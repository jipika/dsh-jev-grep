// Runtime smoke test: mock the cordis ctx, run apply(), then invoke the tool and
// the flood-nudge hook for real. Catches registration-shape / hook-wiring bugs that
// --check cannot. Cross-platform; live-endpoint assertions SKIP when no key. Run:
//   node test-runtime.mjs
// Optional live key: set JEV_TEST_KEY, or have ~/.config/jev/key present.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as plugin from "./lib/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const { __test } = plugin;
let fail = 0, skip = 0;
const ok = (name, cond, extra = "") => { if (cond) console.log("PASS", name); else { fail++; console.log("FAIL", name, extra); } };
const sk = (name) => { skip++; console.log("SKIP", name); };
const key =
  process.env.JEV_TEST_KEY?.trim() ||
  (existsSync(join(homedir(), ".config", "jev", "key")) ? readFileSync(join(homedir(), ".config", "jev", "key"), "utf8").trim() : "");

ok("exports name/inject/apply", plugin.name === "dsh-jev-grep" && Array.isArray(plugin.inject) && typeof plugin.apply === "function");

// ---- mock ctx ----
const hooks = {};
const tools = new Map();
const promptSections = [];
const webRoutes = [];
const ctx = {
  effect: (fn) => fn(),
  on: (evt, h) => { (hooks[evt] ||= []).push(h); return () => {}; },
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  systemPrompt: { section: (s) => { promptSections.push(s); return () => {}; } },
  inject: (_deps, fn) => fn({ webServer: { register: (r) => { webRoutes.push(r); return () => {}; } } }),
};
plugin.apply(ctx);

ok("jev_search registered", tools.has("jev_search"));
const tool = tools.get("jev_search");
ok("output schema declared (hard contract)", !!tool?.output?.schema && typeof tool?.output?.render === "function");
ok("parameters is full JSON Schema", tool?.parameters?.type === "object" && !!tool?.parameters?.properties?.pattern);
ok("nudge hook wired", (hooks["tools/post-execute"] || []).length === 1);
ok("prompt section added", promptSections.some((s) => s.name === "dsh-jev-grep:notice"));
ok("web route registered", webRoutes.some((r) => r.path === "/dsh-jev-grep"));

// zero-match path needs rg only to confirm "0 matches"; works without a key.
{
  const rg = __test.findRg(__test.DEFAULTS);
  if (!rg) sk("zero-match tool path (no ripgrep)");
  else {
    // Search an EMPTY temp dir so the pattern literal can't self-match this file.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const empty = mkdtempSync(join(tmpdir(), "jevempty"));
    const r3 = await tool.execute({ pattern: "anything_at_all", path: empty, kind: "noul", question: "this line exists" });
    ok("zero matches handled", r3.adjudicated === true && r3.text.includes("0 matches"), r3.text);
  }
}

// live adjudication (needs key + rg)
if (!key || !__test.findRg(__test.DEFAULTS)) {
  sk("live jev_search adjudication (no key or no ripgrep)");
} else {
  const r1 = await tool.execute({
    pattern: "register|apply|tools",
    path: HERE, glob: "*.js",
    kind: "noul",
    question: "this line is production code in lib/index.js, not a comment or string literal",
  });
  ok("live adjudicated", r1.adjudicated === true, r1.text.slice(0, 200));
  ok("live banner+cut", r1.text.includes("candidate(s)") && r1.text.includes("cut"), r1.text.slice(0, 160));
  console.log("---- sample ----\n" + r1.text.split("\n").slice(0, 6).join("\n"));

  const r2 = await tool.execute({
    pattern: "register|apply|tools",
    path: HERE, glob: "*.js",
    kind: "choice",
    question: "does this line define or call?",
    options: [{ name: "def", criteria: "declares a function/const/const-assignment" }, { name: "call", criteria: "invokes something already defined" }],
  });
  ok("choice adjudicated", r2.adjudicated === true && r2.text.includes("jev choice"), r2.text.slice(0, 160));

  // degrade: point at a dead url via the settings file, then restore.
  const sf = join(homedir(), ".dsh", "dsh-jev-grep", "settings.json");
  const had = existsSync(sf);
  const backup = had ? readFileSync(sf, "utf8") : null;
  try {
    mkdirSync(join(homedir(), ".dsh", "dsh-jev-grep"), { recursive: true });
    writeFileSync(sf, JSON.stringify({ url: "https://127.0.0.1:9/x", timeoutMs: 2500 }));
    __test.invalidateSettings();
    const r4 = await tool.execute({ pattern: "apply", path: HERE, kind: "noul", question: "this line is production code, not a comment" });
    ok("degrade: adjudicated false + honest note", r4.adjudicated === false && /unavailable|降级|degrad/i.test(r4.text), r4.text.slice(0, 160));
    ok("degrade: still returns raw lines", /:\d+:|:\s/.test(r4.text), r4.text.slice(0, 120));
  } finally {
    if (had) writeFileSync(sf, backup); else try { writeFileSync(sf, JSON.stringify(__test.DEFAULTS)); } catch { /* ignore */ }
    __test.invalidateSettings();
  }
}

// ---- flood nudge hook (no key needed) ----
{
  const nudge = hooks["tools/post-execute"][0];
  const bigText = Array.from({ length: 200 }, (_, i) => `f${i}.ts:${i}: match line`).join("\n");
  const big = { content: [{ type: "text", text: bigText }] };

  // fires: nudge lands in content[0] AND additionalContexts; exec.name is the real field.
  const out1 = await nudge({ name: "grep" }, big, async () => big);
  ok("nudge fires on 200-line grep (exec.name)", out1.content?.[0]?.text?.includes("jev_search"), JSON.stringify(out1).slice(0, 120));
  ok("nudge also in additionalContexts", out1.additionalContexts?.[0]?.text?.includes("jev_search"), JSON.stringify(out1).slice(0, 120));
  ok("nudge preserves original content", out1.content?.[1]?.text === bigText, "content tail lost");

  // REGRESSION: line-count from the ORIGINAL result, not the compressed downstream.
  // save-token/pruner replace downstream with a short stub; original still 200 lines -> must fire.
  const stub = { content: [{ type: "text", text: "[save-token #abcd compressed: 200 lines -> 30]" }] };
  const out1b = await nudge({ name: "grep" }, big, async () => stub);
  ok("nudge fires when downstream is compressed stub", out1b.content?.[0]?.text?.includes("jev_search"), JSON.stringify(out1b).slice(0, 140));

  // exec.tool.name shape still supported (belt-and-suspenders).
  const out1c = await nudge({ tool: { name: "grep" } }, big, async () => big);
  ok("nudge fires on exec.tool.name shape", out1c.content?.[0]?.text?.includes("jev_search"));

  // silent on small result.
  const small = { content: [{ type: "text", text: "a:1: x\nb:2: y\n" }] };
  const out2 = await nudge({ name: "grep" }, small, async () => small);
  ok("nudge silent on small result", !out2.additionalContexts && out2 === small);

  // ignores non-grep tools.
  const out3 = await nudge({ name: "read" }, big, async () => big);
  ok("nudge ignores non-grep tools", out3 === big);

  // skips a blocked downstream (kind guard).
  const blocked = { kind: "block", content: [{ type: "text", text: "no" }] };
  const out4 = await nudge({ name: "grep" }, big, async () => blocked);
  ok("nudge skips blocked downstream", out4 === blocked);

  // mcp-prefixed grep name matches too.
  const out5 = await nudge({ name: "mcp__fs__grep" }, big, async () => big);
  ok("nudge fires on mcp__*__grep", out5.content?.[0]?.text?.includes("jev_search"));
}

console.log(fail ? `\n${fail} FAILED, ${skip} skipped` : `\nALL PASS (${skip} skipped)`);
process.exit(fail ? 1 : 0);
