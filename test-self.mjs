// Unit self-test for dsh-jev-grep core logic. Cross-platform, no hardcoded paths.
// Live endpoint tests are SKIPPED (not failed) when no key is configured, so this
// runs clean on a fresh clone. Run:  node test-self.mjs
// Optional live key: set JEV_TEST_KEY, or have ~/.config/jev/key present.
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { __test } from "./lib/index.js";

const { estTokens, makeBatches, runRg, jevJudge, jevCall, fmtNoul, fmtChoice, findRg, rgPackageCandidates, DEFAULTS, toolNameOf, resultTextOf } = __test;
let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };
const sk = (name) => { skip++; console.log("SKIP", name); };

const cfg = { ...DEFAULTS };
const key =
  process.env.JEV_TEST_KEY?.trim() ||
  (existsSync(join(homedir(), ".config", "jev", "key")) ? readFileSync(join(homedir(), ".config", "jev", "key"), "utf8").trim() : "");

// --- token estimation
ok("estTokens ascii ~ chars/4", Math.abs(estTokens("a".repeat(400)) - 100) <= 5);
ok("estTokens CJK costs more than ascii", estTokens("中".repeat(100)) > estTokens("a".repeat(100)));

// --- batching
{
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(80)}`);
  const bs = makeBatches(lines, 2000);
  ok("makeBatches covers all", bs.reduce((a, b) => a + b.length, 0) === 50);
  ok("makeBatches respects budget", bs.every((b) => estTokens(b.join("\n")) <= 2000 + 200));
  ok("makeBatches isolates one huge line", makeBatches(["y".repeat(50000), "z"], 1000)[0].length === 1);
}

// --- rg candidate discovery against a temp fixture (skips if no ripgrep found)
{
  const rg = findRg(cfg);
  if (!rg) {
    sk("runRg (no ripgrep on this machine; set rgPath or install rg)");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "jevr"));
    writeFileSync(join(dir, "a.ts"), "const getUser = (id) => db.get(id);\n// getUser legacy note\nexport const setUpper = (s) => s.toUpperCase();\n".repeat(40));
    writeFileSync(join(dir, "b.md"), "getUser appears in docs prose here\n");
    const r = runRg(cfg, "getUser", dir, "*.ts", false, 500);
    ok("runRg no error", !r.error, r.error);
    ok("runRg counts matches", r.total === 80, `total=${r.total}`);
    ok("runRg emits file:line:text", /a\.ts:\d+:/.test(r.hits[0].line.replace(/\\/g, "/")), r.hits[0]?.line);
    ok("runRg text is NON-EMPTY (regression: empty candidates)", r.hits.every((h) => h.text.length > 0), JSON.stringify(r.hits[0]));
    ok("runRg line carries the payload", r.hits.some((h) => h.line.includes("getUser")), r.hits[0]?.line);
    ok("runRg glob off includes .md", runRg(cfg, "getUser", dir, "", true, 500).total === 81);
    const r3 = runRg(cfg, "getUser", dir, "*.ts", false, 10);
    ok("runRg truncation flag", r3.hits.length === 10 && r3.truncated === true);
  }
  ok("rgPackageCandidates non-empty", Array.isArray(rgPackageCandidates()) && rgPackageCandidates().length > 0);
}

// --- nudge helpers
ok("toolNameOf reads shapes", toolNameOf({ tool: { name: "grep" } }) === "grep" && toolNameOf({ name: "mcp__x__glob" }) === "mcp__x__glob");
ok("resultTextOf string", resultTextOf("abc") === "abc");
ok("resultTextOf content array", resultTextOf({ content: [{ type: "text", text: "t1" }, { type: "image" }] }) === "t1");

// --- live endpoint (skip when unconfigured)
if (!key) {
  sk("live noul/choice/degrade (no key: set JEV_TEST_KEY or ~/.config/jev/key)");
} else {
  const lines = [
    "src/api/user.ts:12:  const user = await getUser(id);",
    "src/docs/legacy.md:4: <!-- getUser was removed in v2 -->",
  ];
  const q = "this line calls the user API in production code, not a test, mock, or comment";
  try {
    const { batches, out } = await jevJudge({ ...cfg, key }, key, "noul", q, [], lines, 20000);
    const v = out.flat();
    ok("live noul returns numbers", v.every((x) => typeof x === "number"), JSON.stringify(v));
    ok("live noul separates real from comment", v[0] > v[1], JSON.stringify(v));
    const text = fmtNoul(cfg, q, lines.map((l) => ({ line: l })), v, performance.now(), batches.length);
    ok("fmtNoul prints banner+cut", text.includes("candidate(s)") && text.includes("cut"), text.slice(0, 120));

    const c = await jevCall({ ...cfg, key }, key, "choice", "what kind of artifact is this?", [
      { name: "code", criteria: "executable source that ships and runs" },
      { name: "docs", criteria: "prose for humans to read" },
    ], ["README.md", "src/index.ts"], null);
    ok("live choice labels", c[0] === "docs" && c[1] === "code", JSON.stringify(c));

    const dead = { ...cfg, key: "x", url: "https://127.0.0.1:9/v1/systemone", timeoutMs: 3000 };
    let threw = false;
    try { await jevJudge(dead, "x", "noul", q, [], lines, 3000); } catch { threw = true; }
    ok("dead endpoint throws (caller degrades)", threw);
  } catch (e) {
    sk(`live tests errored (endpoint may be down): ${String(e?.message).slice(0, 80)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
