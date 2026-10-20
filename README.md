<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-jev-grep icon">
</div>

# dsh-jev-grep

> 搜索洪水的裁决层插件（DeepSeek Harness，host 半边，零 npm 依赖，跨平台 Win/mac/Linux）。

**定位**：不替代 grep——找东西仍是 `grep`/`glob` 的活。它替代的是搜索之后"几百行命中要么硬读进 context、要么 `grep -v` 猜"的环节：把命中行灌进 [TypeSafe Jev](https://docs.typesafe.ai) 的类型化判断（noul/choice），返回每行一个校准概率 + 排序 + cut 线，模型只读 cut 上方 ~30 行。

一个 `grep -rn` 回来 3000 行、500 个文件的场景：读它烧 context、猜它出错。`jev_search` 把池子压成"每行一个校准数字 + 一条 cut 线"，回复长度与池子大小无关（40 条和 4000 条都是 ~30 行）。

## 组成

| 部件 | 行为 |
|---|---|
| `jev_search` 工具 | 内置 ripgrep 找候选 → 分批并发裁决 → 排序 + cut。端点不通/超时/无 key 一律**降级返回原始 grep 行并如实标注**（`adjudicated:false`），绝不静默 |
| 洪水 nudge | `grep`/`glob` 结果行数 ≥ `minMatchesForNudge`（默认 120）时，附加一句 ~60 token 提示引导改用 `jev_search`；小池子零打扰 |
| systemPrompt 段 | 问题措辞契约（一跳、字面、单位是行）+ 已实测失效模式提醒 |
| `/dsh-jev-grep` 路由 | GET 状态（key 只回显指纹）；POST `/settings` 改配置，live re-read（10s 缓存），无需重启 |

## 前置

- Node 18+（DSH 自带）
- 一个 Jev 端点 + key，三选一：
  - **OpenCode Zen 免费档**（零成本起步）：`url=https://opencode.ai/zen/v1/systemone`，`model=jev-1.13-free`，key 在 [opencode.ai](https://opencode.ai) 申请。
  - **TypeSafe 官方**：`url=https://api.typesafe.ai/v1/systemone`，`model=jev-latest`，$0.042/百万输入 token、输出免费。
  - **OpenRouter**：`url=https://openrouter.ai/api/alpha/decisions`，`model=~typesafe/jev-latest`，key 以 `sk-or-` 开头。

## 配置

`~/.dsh/dsh-jev-grep/settings.json`（缺省即默认值；也可全走 `POST /dsh-jev-grep/settings`）：

```jsonc
{
  "enabled": true,
  "url": "https://opencode.ai/zen/v1/systemone",  // 任何 systemone 形状端点
  "model": "jev-1.13-free",                        // Zen 免费档；官方用 jev-latest
  "key": "",                                       // 空 → ~/.config/jev/key → env JEV_API_KEY
  "timeoutMs": 20000,
  "minMatchesForNudge": 120,                       // grep 命中行数超它才 nudge
  "maxCandidates": 2000,                           // 单次裁决候选上限
  "tokenBudget": 40000,                            // 每次 API 调用的输入 token 预算
  "concurrency": 4,
  "cutP": 0.7,                                     // noul 默认 cut
  "topRows": 30,                                   // 文本输出最多展示行数
  "nudgeEnabled": true,
  "rgPath": ""                                     // 空 → 自动探测宿主 ripgrep → PATH
}
```

> key 建议落 `~/.config/jev/key`（与 [jev CLI](https://github.com/glud123/jev-assist) 共用），别写进 settings.json——后者更可能被同步/备份。settings.json 里的 key 只会在 `GET /dsh-jev-grep` 回显指纹，绝不回显明文。

## 安装

克隆到本地插件目录，再挂进 profile（三平台一致）：

```sh
git clone https://github.com/jipika/dsh-jev-grep.git ~/.dsh/local-plugins/dsh-jev-grep
```

1. profile 的 `package.json` → `dependencies` 加一行：
   ```json
   "dsh-jev-grep": "link:../../local-plugins/dsh-jev-grep"
   ```
2. profile 的 `cordis.patch.yml` 加一个 insert 块：
   ```yaml
   - insert:
       - id: dsh-jev-grep
         name: dsh-jev-grep
   ```
3. 在 profile 目录跑 `pnpm install`（Windows 上若报 postinstall 找不到 node，把 DSH 自带 node 的 `bin` 加进 PATH 再跑一次）。
4. **重启 DSH**（host 半边新插件必须重启才加载）。

profile 目录在 `~/.dsh/profiles/<profile>/`（桌面端默认 `desktop`）。

### ripgrep 定位

插件自动找宿主自带的 `@vscode/ripgrep-<platform>-<arch>`：
- Windows：`resources/app.asar.unpacked/dsh/node_modules/@vscode/.../bin/rg.exe`
- macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/node_modules/@vscode/.../bin/rg`
- Linux：`/opt`、`/usr/lib`、`~/.local/share` 下的对应路径

都探不到时回落 PATH 上的 `rg`；仍失败可显式设 `rgPath`。

## 用法（模型侧）

模型看到 `jev_search` 工具 + 一段 system prompt。典型：

```
jev_search(
  pattern="getUser",
  path="/repo/src",
  kind="noul",
  question="this line calls the user API in production code, not a test, mock, or comment"
)
```

返回：
```
jev noul · 29 candidate(s) · 1 call(s) · 1394ms
  "this line calls the user API in production code, not a test, mock, or comment"
  yes 12 / 29 at p >= 0.70
--- cut: read above (12 row(s); p >= 0.70; 17 below) ---
0.91	"src/api/user.ts:12:  const user = await getUser(id);"
...
```

读 cut 上方即可。`kind=choice` 时给 `options=[{name,criteria}...]`（2+ 个带对比判据的选项），按标签分组返回。

## 隐私

每次裁决把**候选行 + 问题 + key** 发给所配端点。不想让代码出机器就别启用（`enabled:false` 时 nudge 与工具都静默直通）。

## 已知失效模式（实测）

- **短候选/中文内容分数系统性偏低**：真阳性可能掉进 0.4~cut 的 band；band 大时用 `choice` 二次过一遍再下结论。
- **cut 兜底**：若固定 `cutP` 使 cut 上方为 0 行，自动退到"排序概率最大落差（cliff ≥0.25）"处切；仍无 cliff 则取 top-10 并如实标注"人工复核"。
- 不判编译器/linter/测试能定论的事；单条候选（n=1）别用它；别用它判你刚自己生成的候选。

## 测试

```sh
node test-self.mjs      # 单元：token 估算/批切/rg 解析/nudge helper
node test-runtime.mjs   # 运行时：mock ctx 加载插件 + 真实调用工具与钩子
```

无 key 或无 ripgrep 时，依赖它们的用例自动 SKIP（不算失败），所以干净克隆也能跑通。带真实端点：`JEV_TEST_KEY=*** node test-runtime.mjs`。

## 卸载

删 `cordis.patch.yml` 的 insert 块 + `package.json` 依赖行 + `~/.dsh/dsh-jev-grep/`，重启。

## 许可

MIT

---

## ☕ 赞赏支持

如果 dsh-jev-grep 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
