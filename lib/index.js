// dsh-jev-grep — 搜索洪水的裁决层（host 半边，零 npm 依赖）
//
// 定位：不替代 grep（找东西仍是 grep/glob 的活），替代 grep 之后"几百行命中要么
// 硬读进 context、要么 grep -v 猜"的环节。把命中行灌进 TypeSafe Jev 的类型化
// 判断（noul/choice），返回每行一个校准概率 + 排序 + cut 线，~30 行读完。
//
// 组成：
//   · jev_search 工具：内置 ripgrep 找候选 → 分批并发裁决 → 排序 + cut。
//     端点不通/超时/402 一律降级：返回原始 rg 结果并如实标注，绝不假装是零。
//   · 洪水 nudge（tools/post-execute）：grep/glob 命中行数超阈值时附加一句
//     ~60 token 提示引导模型改用 jev_search。机制负责时机，模型负责判断。
//   · systemPrompt 段：问题措辞契约（一跳、字面、单位是行）与失效模式提醒。
//   · /dsh-jev-grep 路由：GET 状态（key 只回显指纹），POST /settings 改配置。
//
// 配置：~/.dsh/dsh-jev-grep/settings.json（live re-read，10s 缓存）。
//   url/model/key 全部可配；key 也可落 ~/.config/jev/key（与 jev CLI 共用）。

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const name = "dsh-jev-grep";
export const inject = ["tools", "systemPrompt", "webServer"];

const DEBUG = process.env.JEVGREP_DEBUG === "1" || process.env.JEVGREP_DEBUG === "true";
function debug(...args) {
  if (DEBUG) console.error("[dsh-jev-grep:debug]", ...args);
}

const STATE_DIR = join(homedir(), ".dsh", "dsh-jev-grep");
const SETTINGS_FILE = join(STATE_DIR, "settings.json");

const DEFAULTS = {
  enabled: true,
  // provider（可指向任何 systemone 形状端点：OpenCode Zen 免费档 / TypeSafe 官方 / OpenRouter）
  url: "https://opencode.ai/zen/v1/systemone",
  model: "jev-1.13-free",
  key: "", // 留空则回落 ~/.config/jev/key，再回落 env JEV_API_KEY
  timeoutMs: 20_000,
  // 行为参数
  minMatchesForNudge: 120, // grep 命中行数超过它才 nudge
  maxCandidates: 2000, // jev_search 单次裁决的候选上限（超出截断并如实报告）
  tokenBudget: 40_000, // 每次 API 调用的输入 token 预算（约 chars*0.9/4）
  concurrency: 4,
  cutP: 0.7, // noul 默认 cut
  topRows: 30, // 文本输出最多展示的行数
  nudgeEnabled: true,
  debugNudge: false, // true → 每次 nudge 判定写 ~/.dsh/dsh-jev-grep/nudge.log（诊断，不靠 stderr）
  rgPath: "", // 留空自动探测（宿主 @vscode/ripgrep → PATH）
};

// ────────────────────────────── 设置（live re-read） ──────────────────────────────

let settingsCache = { at: 0, value: null };

function readSettings() {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < 10_000) return settingsCache.value;
  let value = { ...DEFAULTS };
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
      if (parsed && typeof parsed === "object") value = { ...DEFAULTS, ...parsed };
    }
  } catch {
    /* 坏文件回落默认 */
  }
  settingsCache = { at: now, value };
  return value;
}

function invalidateSettings() {
  settingsCache = { at: 0, value: null };
}

function resolveKey(cfg) {
  if (cfg.key && cfg.key.trim()) return cfg.key.trim();
  try {
    const f = join(homedir(), ".config", "jev", "key");
    if (existsSync(f)) {
      const v = readFileSync(f, "utf8").trim();
      if (v) return v;
    }
  } catch { /* fallthrough */ }
  return process.env.JEV_API_KEY?.trim() || "";
}

function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  const takeNum = (k, min, max) => {
    if (!(k in input)) return;
    const n = Number(input[k]);
    if (!Number.isFinite(n)) return;
    out[k] = Math.min(max, Math.max(min, Math.round(n)));
  };
  const takeBool = (k) => { if (k in input) out[k] = input[k] === true; };
  const takeStr = (k, max) => {
    if (!(k in input)) return;
    const s = String(input[k] ?? "");
    if (s.length <= max) out[k] = s;
  };
  takeBool("enabled");
  takeBool("nudgeEnabled");
  takeBool("debugNudge");
  takeStr("url", 500);
  takeStr("model", 200);
  takeStr("key", 400);
  takeStr("rgPath", 500);
  takeNum("timeoutMs", 1000, 120_000);
  takeNum("minMatchesForNudge", 5, 100_000);
  takeNum("maxCandidates", 10, 5000);
  takeNum("tokenBudget", 2000, 100_000);
  takeNum("concurrency", 1, 8);
  takeNum("topRows", 5, 200);
  if ("cutP" in input) {
    const n = Number(input.cutP);
    if (Number.isFinite(n)) out.cutP = Math.min(0.95, Math.max(0.05, n));
  }
  return out;
}

// ────────────────────────────── ripgrep 定位与执行 ──────────────────────────────

let rgPathCache = { at: 0, path: "", probed: 0 };

/** 宿主自带的 rg：@vscode/ripgrep-<platform>-<arch>/bin/rg(.exe) */
function rgPackageCandidates() {
  const pkg = `ripgrep-${process.platform}-${process.arch}`;
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  // 注意大小写：macOS/Linux 的 Electron 包内是 Resources（大写 R），Windows 才是 resources。
  const res = process.platform === "win32" ? "resources" : "Resources";
  const rel = [res, "app.asar.unpacked", "dsh", "node_modules", "@vscode", pkg, "bin", exe];
  const out = [];
  const pushUpFrom = (start, levels) => {
    let dir = start;
    for (let up = 0; up <= levels; up++) {
      out.push(join(dir, ...rel));
      out.push(join(dir, ...rel.slice(1))); // 少一层 resources（直接位于 unpacked 根下）
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };
  try { pushUpFrom(dirname(process.execPath), 5); } catch { /* ignore */ }
  try { pushUpFrom(join(homedir(), ".dsh", "dsh-runtimes"), 3); } catch { /* ignore */ }
  // 已知默认安装根（Electron 未运行时也探得到）
  const apps = ["DeepSeek Harness", "deepseek-harness", "DSH"];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    for (const app of apps) out.push(join(process.env.LOCALAPPDATA, "Programs", app, ...rel));
  }
  if (process.platform === "darwin") {
    for (const app of apps) {
      out.push(join("/Applications", `${app}.app`, "Contents", ...rel));
      out.push(join(homedir(), "Applications", `${app}.app`, "Contents", ...rel));
    }
  }
  if (process.platform === "linux") {
    for (const app of apps) {
      out.push(join("/opt", app, ...rel));
      out.push(join("/usr/lib", app, ...rel));
      out.push(join(process.env.HOME || homedir(), ".local", "share", app, ...rel));
    }
  }
  return out;
}

function findRg(cfg) {
  const now = Date.now();
  if (now - rgPathCache.probed < 60_000) return rgPathCache.path; // 含失败缓存，避免每次探测
  rgPathCache.probed = now;
  const cands = [];
  if (cfg.rgPath) cands.push(cfg.rgPath);
  cands.push(...rgPackageCandidates());
  for (const c of cands) {
    try {
      if (existsSync(c)) { rgPathCache = { at: now, path: c, probed: now }; return c; }
    } catch { /* next */ }
  }
  // PATH 兜底：Windows 上 CreateProcess 会搜 PATH，裸名可用
  const exe = process.platform === "win32" ? "rg.exe" : "rg";
  try {
    const r = spawnSync(exe, ["--version"], { timeout: 5000 });
    if (!r.error && r.status === 0) { rgPathCache = { at: now, path: exe, probed: now }; return exe; }
  } catch { /* ignore */ }
  rgPathCache = { at: now, path: "", probed: now };
  return "";
}

/** 剥掉 rg 输出路径的 "./" / ".\\" 前缀（Windows 反斜杠同样要处理）。 */
function cleanRelPath(p) {
  return String(p).replace(/^\.[\\/]+/, "");
}

/** 跑一次 rg --json，返回 {hits:[{line,file,ln,col,text}], total, truncated}。 */
function runRg(cfg, pattern, cwd, glob, ignoreCase, max) {
  const rg = findRg(cfg);
  if (!rg) return { error: "ripgrep not found (set rgPath in settings)" };
  const args = ["--json", "-e", pattern];
  if (ignoreCase) args.push("-i");
  if (glob) args.push("--glob", glob);
  args.push(".");
  const res = spawnSync(rg, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60_000, encoding: "utf8" });
  if (res.error && res.error.name !== "AbortError") return { error: `rg failed: ${res.error.message}` };
  const hits = [];
  let total = 0;
  for (const raw of String(res.stdout || "").split("\n")) {
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type !== "match") continue;
    total++;
    if (hits.length >= max) continue;
    const d = ev.data;
    // rg --json: data.lines = { text: "<内容>" }（UTF-8 时），非 UTF-8 时退 { bytes: <base64> }。
    // 注意 text 直接是字符串，不是 { content } —— 早期版本取错层级导致候选全空。
    const rawLine = d.lines?.text ?? (d.lines?.bytes != null ? Buffer.from(d.lines.bytes, "base64").toString("utf8") : "");
    const text = String(rawLine).replace(/\r?\n$/, "").trim();
    const file = cleanRelPath(d.path?.text ?? (d.path?.bytes != null ? Buffer.from(d.path.bytes, "base64").toString("utf8") : "") ?? "?");
    hits.push({ line: `${file}:${d.line_number}:${text}`, file, ln: d.line_number, text });
  }
  return { hits, total, truncated: total > hits.length };
}

// ────────────────────────────── Jev 调用 ──────────────────────────────

function estTokens(s) {
  // 粗估：ASCII≈4 chars/tok，CJK≈1.5 char/tok；取保守值。
  let cjk = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x2e80) cjk++;
  return Math.ceil((s.length - cjk) / 4 + cjk / 1.5);
}

function makeBatches(lines, budget) {
  const batches = [];
  let cur = [], curTok = 0;
  for (const l of lines) {
    const t = estTokens(l) + 16;
    if (cur.length > 0 && curTok + t > budget) { batches.push(cur); cur = []; curTok = 0; }
    cur.push(l); curTok += t;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 一次 systemone 调用。kind: noul|choice。
 * noul: question=陈述句；choice: options=[{name,criteria}...]。
 * 返回 {verdicts: string[]与batch对齐} 或抛错（调用方降级）。
 */
async function jevCall(cfg, key, kind, question, options, batch, signal) {
  const questions = {};
  batch.forEach((l, n) => {
    questions[`q${n}`] = kind === "noul"
      ? { type: "noul", instructions: l, criteria: { true: "yes", false: "no" } }
      : { type: "choice", instructions: l, criteria: Object.fromEntries(options.map((o) => [o.name, o.criteria])) };
  });
  const res = await fetch(cfg.url, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ state: kind === "noul" ? question : `${question}\u001f${JSON.stringify(Object.fromEntries(options.map((o) => [o.name, o.criteria])))}`, model: cfg.model, questions }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${body.slice(0, 180)}`);
  }
  const j = await res.json();
  const ans = j?.answers;
  if (!ans || typeof ans !== "object") throw new Error(`unexpected response: ${JSON.stringify(j).slice(0, 180)}`);
  return batch.map((_, n) => {
    const a = ans[`q${n}`];
    if (!a) return null;
    if (kind === "noul") {
      const p = a.noul ?? a.probability;
      return typeof p === "number" ? p : null;
    }
    return a.choice ?? a.label ?? null;
  });
}

/** 并发跑完所有批次；任何一批硬失败 → 抛出（调用方降级为原始 grep）。 */
async function jevJudge(cfg, key, kind, question, options, lines, timeoutMs) {
  const batches = makeBatches(lines, cfg.tokenBudget);
  const out = new Array(batches.length);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let next = 0;
  let failed = null;
  const worker = async () => {
    for (;;) {
      const b = next++;
      if (b >= batches.length || failed) return;
      try {
        out[b] = await jevCall(cfg, key, kind, question, options, batches[b], ctrl.signal);
      } catch (e) {
        failed = e;
        ctrl.abort();
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, batches.length) }, worker));
    if (failed) throw failed;
  } finally {
    clearTimeout(timer);
  }
  return { batches, out };
}

// ────────────────────────────── 输出格式化 ──────────────────────────────

function fmtNoul(cfg, question, hits, verdicts, t0, calls) {
  const rows = hits
    .map((h, i) => ({ p: verdicts[i], line: h.line }))
    .filter((r) => typeof r.p === "number")
    .sort((a, b) => b.p - a.p);
  // cut 选择（移植 jev-assist 的 cliff 逻辑）：默认固定 p>=cutP；若全池都在
  // cut 下（0 行），退到"排序概率的最大落差"处切——固定阈值偶发整体偏低时
  // 不至于返回空答案。仍无显著 cliff 则取 top-10 并如实标注"人工复核"。
  let at = rows.filter((r) => r.p >= cfg.cutP).length;
  let why = `p >= ${cfg.cutP.toFixed(2)}`;
  if (at === 0 && rows.length >= 2) {
    let best = -1, bestGap = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i - 1].p - rows[i].p;
      if (gap > bestGap) { bestGap = gap; best = i; }
    }
    if (best > 0 && bestGap >= 0.25) {
      at = best;
      why = `cliff ${rows[best - 1].p.toFixed(2)}→${rows[best].p.toFixed(2)}`;
    } else {
      at = Math.min(10, rows.length);
      why = "no cliff, no p >= cut — top 10 (分数整体偏低，人工复核)";
    }
  }
  const above = rows.slice(0, at);
  const lines = [
    `jev noul · ${hits.length} candidate(s) · ${calls} call(s) · ${Math.round(performance.now() - t0)}ms`,
    `  "${question}"`,
    `  yes ${above.length} / ${rows.length} at ${why}`,
    `--- cut: read above (${above.length} row(s); ${why}; ${rows.length - above.length} below) ---`,
  ];
  for (const r of above.slice(0, cfg.topRows)) lines.push(`${r.p.toFixed(2)}\t${JSON.stringify(r.line)}`);
  if (above.length > cfg.topRows) lines.push(`  … ${above.length - cfg.topRows} more above cut (raise topRows or use --json style raw grep)`);
  return lines.join("\n");
}

function fmtChoice(cfg, hits, labels, t0, calls) {
  const by = new Map();
  hits.forEach((h, i) => {
    const l = labels[i] ?? "?";
    if (!by.has(l)) by.set(l, []);
    by.get(l).push(h.line);
  });
  const groups = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines = [
    `jev choice · ${hits.length} candidate(s) · ${calls} call(s) · ${Math.round(performance.now() - t0)}ms`,
    groups.map(([l, v]) => `${l} ${v.length}`).join("  ·  "),
  ];
  for (const [l, v] of groups) {
    lines.push("", `[${l}]  ${v.length} candidate(s)`);
    for (const x of v.slice(0, cfg.topRows)) lines.push(JSON.stringify(x));
    if (v.length > cfg.topRows) lines.push(`  … ${v.length - cfg.topRows} more`);
  }
  return lines.join("\n");
}

function degradeNote(cfg, reason, rg) {
  const sample = rg.hits.slice(0, 60).map((h) => h.line);
  return [
    `jev unavailable (${reason}) — 已降级为原始 grep 行为，以下只是未裁决的前 ${sample.length}/${rg.total} 行，请自行收窄 pattern 或分批处理。`,
    "",
    ...sample,
  ].join("\n");
}

// ────────────────────────────── jev_search 工具 ──────────────────────────────

function registerTool(ctx) {
  ctx.tools.register({
    name: "jev_search",
    description:
      "Adjudicate a search flood with TypeSafe Jev: runs ripgrep for `pattern`, pipes every hit through a typed judgment, and returns one calibrated number per line, sorted, with a cut line — read above the cut instead of hundreds of raw matches. kind=noul: `question` is a statement about ONE candidate line (write exclusions into it literally, e.g. '...not a test, mock, or comment'). kind=choice: `question` is a question and `options` is 2+ {name,criteria} with contrastive criteria. The unit is a line — do not aim it at whole files. When the endpoint is unreachable it degrades to returning raw grep lines and says so. Not for: small pools you can read, retrieval itself (use grep), or judging your own just-generated candidates.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "ripgrep pattern (regex) to find candidates" },
        path: { type: "string", description: "directory to search (default: session workspace)" },
        glob: { type: "string", description: "optional ripgrep --glob filter, e.g. *.ts" },
        ignore_case: { type: "boolean", description: "case-insensitive match (default false)" },
        kind: { type: "string", enum: ["noul", "choice"], description: "judgment type: noul = per-line probability, choice = per-line label" },
        question: { type: "string", description: "noul: a one-hop literal statement about one candidate line. choice: the question." },
        options: {
          type: "array",
          description: "choice only: 2+ options with contrastive criteria",
          items: { type: "object", properties: { name: { type: "string" }, criteria: { type: "string" } }, required: ["name", "criteria"], additionalProperties: false },
        },
      },
      required: ["pattern", "kind", "question"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, adjudicated: { type: "boolean" } },
        required: ["text", "adjudicated"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      const cfg = readSettings();
      const cwd = args.path && existsSync(args.path) ? args.path : process.cwd();
      const rg = runRg(cfg, args.pattern, cwd, args.glob, args.ignore_case === true, cfg.maxCandidates);
      if (rg.error) return { text: `jev_search: ${rg.error}`, adjudicated: false };
      if (rg.total === 0) return { text: "jev_search: 0 matches.", adjudicated: true };
      if (rg.hits.length === 0) return { text: `jev_search: ${rg.total} matches but none returned (maxCandidates).`, adjudicated: false };

      const trunc = rg.truncated ? `\n(候选截断：共 ${rg.total} 命中，只裁决了前 ${rg.hits.length} 行——收窄 pattern 或 glob 再跑)` : "";
      const key = resolveKey(cfg);
      if (!key) {
        return { text: degradeNote(cfg, "no API key: set settings.json key or ~/.config/jev/key", rg) + trunc, adjudicated: false };
      }
      // 去重裁决（同行只判一次），再按命中展开
      const uniq = new Map();
      rg.hits.forEach((h, i) => { if (!uniq.has(h.line)) uniq.set(h.line, []); uniq.get(h.line).push(i); });
      const lines = [...uniq.keys()];
      const t0 = performance.now();
      try {
        const { batches, out } = await jevJudge(cfg, key, args.kind, args.question, args.options ?? [], lines, cfg.timeoutMs);
        const flat = [];
        out.forEach((verdicts, b) => verdicts.forEach((v, n) => {
          for (const idx of uniq.get(batches[b][n])) flat[idx] = v;
        }));
        const calls = batches.length;
        if (args.kind === "noul") return { text: fmtNoul(cfg, args.question, rg.hits, flat, t0, calls) + trunc, adjudicated: true };
        return { text: fmtChoice(cfg, rg.hits, flat, t0, calls) + trunc, adjudicated: true };
      } catch (e) {
        const reason = e?.name === "AbortError" ? `timeout ${cfg.timeoutMs}ms` : String(e?.message ?? e).slice(0, 160);
        debug("degrade:", reason);
        return { text: degradeNote(cfg, reason, rg) + trunc, adjudicated: false };
      }
    },
  });
}

// ────────────────────────────── 系统提示段 ──────────────────────────────

const PROMPT_SECTION = [
  "## 搜索洪水裁决（dsh-jev-grep）",
  "",
  "- 当 `grep`/`glob` 返回上百行命中时，优先用 `jev_search` 工具：它跑 ripgrep 并把每行命中送 Jev 类型化判断，返回每行一个校准概率 + cut 线，只读 cut 上方 ~30 行，而不是把洪水读进 context。",
  "- 措辞契约：noul 的问题是对**一行候选**的一跳字面陈述（把排除项写进去：'...not a test, mock, or comment'）；choice 给 2+ 个带对比判据的选项。判断单位是一行，不是整个文件。",
  "- 已知失效模式：短候选/中文内容分数系统性偏低（假阴性多落在 0.4~cut 的 band——大 band 用 choice 二次过一遍再下结论）；深尾 <0.4 报告前对可疑形状做一次 regex 探针审计。",
  "- 端点不通时工具自动降级为原始 grep 行并明说（adjudicated:false）——此时回到收窄 pattern 的老路。小池子（<一屏）直接读，别调它。",
].join("\n");

// ────────────────────────────── 洪水 nudge ──────────────────────────────

function toolNameOf(exec) {
  return String(exec?.tool?.name ?? exec?.name ?? exec?.toolName ?? exec?.definition?.name ?? "");
}

function resultTextOf(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n");
  }
  try { return JSON.stringify(result).slice(0, 400_000); } catch { return ""; }
}

async function floodNudgeHook(exec, result, next) {
  const downstream = await next();
  try {
    const cfg = readSettings();
    if (!cfg.enabled || !cfg.nudgeEnabled) return downstream;
    // 只处理成功放行的结果；blocked/ask/error 一律不注入（对齐 save-token 的 kind 守卫）。
    if (downstream && downstream.kind && downstream.kind !== "accept") return downstream;
    if (downstream && downstream.isError === true) return downstream;
    const tn = toolNameOf(exec).toLowerCase();
    if (!/(^|[-_.])grep($|[-_.])|(^|[-_.])glob($|[-_.])/.test(tn)) return downstream;

    // 行数从**原始 result** 数，不是 downstream —— 内层 pruner 可能已把 downstream 截断，
    // 用截断后的值数会漏触发（实测 250 行洪水被压成 ~30 行预览）。
    const rawText = resultTextOf(result);
    if (!rawText) return downstream;
    let lines = 0;
    for (let i = 0; i < rawText.length; i++) if (rawText.charCodeAt(i) === 10) lines++;
    if (lines < cfg.minMatchesForNudge) return downstream;

    const note =
      `[dsh-jev-grep] 这次 ${tn} 命中约 ${lines} 行——超过一屏。别硬读、也别写 grep -v 猜：改用 jev_search 工具（同一 pattern，对"一行候选"做 noul 字面陈述裁决，或带对比判据的 choice 分类），只读 cut 上方的行；端点不通它会自动降级回原始 grep 行为。`;

    // 写进 content 头部（不是只挂 additionalContexts）：外层插件（如 save-token）重建对象
    // 会丢掉 additionalContexts，而 content 是"post-execute hook 追加文本块的幸存路径"。
    // 放数组最前 = 落在压缩保留的 head 里。additionalContexts 仍保留作双保险。
    const base = downstream && typeof downstream === "object" ? downstream : (result && typeof result === "object" ? result : {});
    let content = Array.isArray(base.content) ? base.content : null;
    if (!content) {
      const t = typeof base.text === "string" ? base.text : rawText;
      content = [{ type: "text", text: t }];
    }
    const nudgeBlock = { type: "text", text: note };
    if (cfg.debugNudge) {
      try { appendFileSync(join(STATE_DIR, "nudge.log"), `${new Date().toISOString()} FIRED ${tn} lines=${lines}\n`); } catch { /* ignore */ }
    }
    return {
      ...base,
      content: [nudgeBlock, ...content],
      additionalContexts: [{ type: "text", text: note }, ...(base.additionalContexts ?? [])],
    };
  } catch (e) {
    debug("nudge hook failed:", e?.message);
    try { if (readSettings().debugNudge) appendFileSync(join(STATE_DIR, "nudge.log"), `${new Date().toISOString()} ERROR ${e?.message}\n`); } catch { /* ignore */ }
    return downstream; // nudge 失败绝不影响工具结果
  }
}

// ────────────────────────────── 状态路由 ──────────────────────────────

function keyFingerprint(key) {
  if (!key) return "(unset)";
  return `${key.slice(0, 6)}…${key.slice(-4)} (len ${key.length})`;
}

function statusPayload() {
  const cfg = readSettings();
  return {
    enabled: cfg.enabled,
    nudgeEnabled: cfg.nudgeEnabled,
    debugNudge: cfg.debugNudge,
    url: cfg.url,
    model: cfg.model,
    key: keyFingerprint(resolveKey(cfg)),
    timeoutMs: cfg.timeoutMs,
    minMatchesForNudge: cfg.minMatchesForNudge,
    maxCandidates: cfg.maxCandidates,
    cutP: cfg.cutP,
    topRows: cfg.topRows,
    rgPath: findRg(cfg) || "(not found)",
    defaults: { ...DEFAULTS },
  };
}

function reply(res, status, body) {
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  } catch { /* 客户端已断开 */ }
}

// ────────────────────────────── apply ──────────────────────────────

export function apply(ctx) {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }

  ctx.effect(
    () => ctx.systemPrompt.section({ name: "dsh-jev-grep:notice", order: 3610, text: PROMPT_SECTION }),
    "dsh-jev-grep: system prompt section",
  );

  ctx.effect(() => ctx.on("tools/post-execute", floodNudgeHook), "dsh-jev-grep: flood nudge hook");

  ctx.effect(() => registerTool(ctx), "dsh-jev-grep: jev_search tool");

  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          path: "/dsh-jev-grep",
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? "/", "http://localhost");
              const pathname = url.pathname.replace(/\/+$/, "");
              if (req.method === "POST" && (pathname === "/settings" || pathname.endsWith("/dsh-jev-grep/settings"))) {
                let body = "";
                req.on("data", (c) => (body += c));
                req.on("end", () => {
                  try {
                    const patch = sanitizeSettings(JSON.parse(body));
                    if (Object.keys(patch).length > 0) {
                      mkdirSync(STATE_DIR, { recursive: true });
                      const merged = { ...readSettings(), ...patch };
                      const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
                      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
                      renameSync(tmp, SETTINGS_FILE);
                      invalidateSettings();
                    }
                    reply(res, 200, statusPayload());
                  } catch (error) {
                    reply(res, 400, { error: String(error?.message ?? error) });
                  }
                });
                return;
              }
              reply(res, 200, statusPayload());
            } catch (error) {
              reply(res, 500, { error: String(error?.message ?? error) });
            }
          },
        }),
      "dsh-jev-grep: status route",
    );
  });
}

// 测试出口（宿主只读 name/inject/apply，多导出不影响加载）
export const __test = { readSettings, invalidateSettings, resolveKey, estTokens, makeBatches, runRg, jevJudge, jevCall, fmtNoul, fmtChoice, degradeNote, toolNameOf, resultTextOf, findRg, rgPackageCandidates, DEFAULTS };
