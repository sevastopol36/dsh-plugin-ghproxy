# GitHub Proxy for DSH

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 GitHub 数据获取能力的原生 Cordis 插件：请求经由**可自动切换的公共代理镜像**转发，用于解决直连 `github.com` / `raw.githubusercontent.com` 时的网络超时。

- **多镜像容错** — 按顺序尝试多个代理，第一个健康的胜出，失效的自动跳过
- **健康度记忆** — 每个镜像的成功/失败结果缓存 5 分钟，避免反复踩坑
- **读取文件** — `sevastopol36_ghproxy_fetch` 读取 raw / blob / gist / `api.github.com` JSON
- **下载文件** — `sevastopol36_ghproxy_download` 下载 release 资产、仓库 archive、raw、gist 到本地
- **命令行加速** — `sevastopol36_ghproxy_proxy_url` 生成全部镜像 URL，供 `git clone` / `curl` / `wget` 使用
- **自带诊断** — `sevastopol36_ghproxy_probe` 实测每个镜像的 raw / archive / API 三种路线
- **零运行时依赖** — 只用 Node 内置 `fetch` 与 `node:fs` / `node:stream`

## ⚠️ 重要变更（0.2.0）

0.1.0 只硬编码了一个代理 **`https://gh.jasonzeng.dev`**，该服务**现已完全不可用**——raw 文件、blob 页面、仓库 archive、`api.github.com` 全部在传输层失败。因此 0.1.0 插件实际上无法抓取任何内容。

0.2.0 改为多镜像列表。实测结果（2026-02）：

| 代理 | raw | archive | `api.github.com` | 延迟 |
|---|---|---|---|---|
| `gh-proxy.com` | ✅ 200 | ✅ 200 (zip) | ✅ **200 (JSON)** | 0.4–0.8 s |
| `sevastopol36-ghproxy.net` | ✅ 200 | ✅ 200 (zip) | ❌ 403 | 0.7–1.9 s |
| `ghfast.top` | ✅ 200 | ✅ 200 (zip) | ❌ 403 | 0.6–2.1 s |
| `gh.ddlc.top` | ✅ 200 | ✅ 200 (zip) | ❌ 404 | 0.6–2.2 s |
| `gh.jasonzeng.dev` | ❌ | ❌ | ❌ | 传输失败 |

只有 `gh-proxy.com` 三种路线全部可用，因此它排在首位，且 `api.github.com` 请求优先走它。

## 提供的工具

| 工具 | 功能 |
|---|---|
| `sevastopol36_ghproxy_fetch` | 读取 raw / 文本 / JSON；过大文本或二进制自动落盘 |
| `sevastopol36_ghproxy_download` | 下载 raw、release 资产、archive（zip/tar.gz）、gist 到本地 |
| `sevastopol36_ghproxy_proxy_url` | 生成全部镜像 URL（带 `[live]`/`[dead]` 标记），供 shell 工具使用 |
| `sevastopol36_ghproxy_probe` | 实测每个镜像的 raw / archive / API 路线，输出建议配置 |

## 代理 URL 规则

**代理前缀 + 完整原始 URL**：

```text
https://gh-proxy.com/https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>
https://gh-proxy.com/https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip
https://gh-proxy.com/https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
https://gh-proxy.com/https://gist.githubusercontent.com/<user>/<gist-id>/raw/<file>
https://gh-proxy.com/https://api.github.com/repos/<owner>/<repo>      # 仅部分镜像支持
```

终端等价用法：

```bash
git clone https://gh-proxy.com/https://github.com/<owner>/<repo>.git
curl -LO https://gh-proxy.com/https://github.com/<owner>/<repo>/releases/download/v1.0/app.zip
```

支持的原始主机：`github.com`、`raw.githubusercontent.com`、`codeload.github.com`、
`objects.githubusercontent.com`、`gist.github.com`、`gist.githubusercontent.com`、
`api.github.com`（JSON，仅 `gh-proxy.com` 实测支持）。

## 安装

本插件是标准 dsh bundle（声明了 `dsh.bundle.patch`）：

```bash
dsh plugin --profile web add dsh-plugin-ghproxy
# 或从本地目录
dsh plugin --profile web add ./dsh-plugin-ghproxy
```

安装后需重启 profile：`dsh web`

## 配置

```yaml
- id: sevastopol36-ghproxy
  config:
    proxyBases:                 # 按顺序尝试，第一个健康的胜出
      - 'https://gh-proxy.com'
      - 'https://sevastopol36-ghproxy.net'
      - 'https://ghfast.top'
      - 'https://gh.ddlc.top'
      - 'https://gh.jasonzeng.dev'
    proxyBase: ''               # 兼容 0.1.0 的单代理设置，若填写会优先尝试
    downloadDir: 'downloads/github'
    timeoutMs: 60000
    retries: 1
    retryDelayMs: 800
    healthCacheMs: 300000
    maxTextBytes: 262144
    maxBytes: 209715200         # 200 MB
    overwrite: false
    allowApi: true
```

### 全部镜像都失败怎么办

```text
sevastopol36_ghproxy_probe                       # 实测并给出建议 proxyBases
sevastopol36_ghproxy_probe include_defaults=true # 连同内置默认镜像一起测
```

错误信息会列出每个镜像的失败原因。

## 开发

```bash
node test/smoke-ext.mjs            # 全部测试（离线 + 联网）
node test/smoke-ext.mjs offline    # 只跑离线单元测试
```

## 架构

```
dsh-plugin-ghproxy/
├── package.json          # dsh.bundle.patch -> cordis.patch.yml
├── cordis.patch.yml      # 注册行: - id: sevastopol36-ghproxy
└── lib/index.mjs         # Config + 4 个工具 + 镜像健康度跟踪
```

设计要点：

- **健康度排序**：实测成功的镜像优先，失败的排到最后，未知的居中
- **4xx 立即换镜像**：4xx 代表该镜像不支持这种 URL，重试无意义
- **落地页识别**：代理的广告/错误页（"GitHub 文件加速" / "Invalid input." / "Loading..."）会被识别为失败，而不是当作文件保存
- **流式落盘 + 大小限制**：不会把大文件读进内存，超过 `maxBytes` 报错

## License

MIT

## English

Native Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
reach GitHub through public file proxies with automatic failover.

- **Read** — raw files, blob pages, gists, release assets and `api.github.com` JSON.
- **Download** — raw files, release assets, repository archives (zip/tar.gz) and gists to disk.
- **Shell helpers** — `sevastopol36_ghproxy_proxy_url` prints a mirror URL per configured base, for
  `git clone` / `curl` / `wget`.
- **Health-checked failover** — a mirror answering with a landing page, the wrong content type or an
  error is marked unhealthy and skipped; `sevastopol36_ghproxy_probe` measures which mirrors answer each
  route (raw / archive / API) and prints a suggested order.
- **Zero runtime dependencies** — Node's built-in `fetch`, `node:fs` and `node:stream` only.

> The proxies are third-party public services that see the URLs routed through them. Do not route
> private or credential-bearing URLs.

### Install

```bash
# Straight from GitHub (pnpm clones the repository)
dsh plugin --profile web add github:sevastopol36/dsh-plugin-ghproxy

# Or clone first and install from the local directory
git clone https://github.com/sevastopol36/dsh-plugin-ghproxy.git
dsh plugin --profile web add ./dsh-plugin-ghproxy
```

The repository ships prebuilt ESM, so **no build step and no `allowBuilds`
approval is needed**. Restart the profile afterwards (`dsh web`), or add the
directory on the plugin page of the DSH desktop app.

### Names

Every public identifier carries the publisher namespace `sevastopol36`, which is
what the harness needs to keep two plugins from colliding — a duplicate tool name
in one scope is rejected with `tool "X" is already registered`. The full
declaration is in [`dsh-plugin.naming.json`](./dsh-plugin.naming.json).

| Surface | Value |
|---|---|
| npm package | `dsh-plugin-ghproxy` |
| plugin module name | `sevastopol36-ghproxy` |
| loader row id | `sevastopol36-ghproxy` |
| tools | `sevastopol36_ghproxy_fetch`, `sevastopol36_ghproxy_download`, `sevastopol36_ghproxy_proxy_url`, `sevastopol36_ghproxy_probe` |

### Verify

```bash
node verify.mjs            # offline: 18 assertions, no network, no install
node verify.mjs --live     # add the network checks; unreachable hosts report as skipped, not failed
VERIFY_STRICT=1 node verify.mjs --live   # treat the network checks as hard failures
```

`verify.mjs` checks the plugin's export shape, its `dsh.bundle.patch`
declaration, that the declared tool names match `dsh-plugin.naming.json`, and
that every `@deepseek-ai/dsh*` peer range accepts the runtimes listed in
`dsh.compatibility.verifiedRuntimes`. `BUILD-INFO.json` records the sha256 of
every published file, so a reader can confirm the code here is the code that was
tested.

### License

MIT.

---

### 从本仓库安装

本插件是预构建的纯 ESM 源码，仓库里的 `lib/` 就是可运行产物，**不需要任何构建步骤或
`allowBuilds` 授权**：

```bash
# 从 GitHub 直接安装（pnpm 会 clone 本仓库）
dsh plugin --profile web add github:sevastopol36/dsh-plugin-ghproxy

# 或先 clone，再从本地目录安装
git clone https://github.com/sevastopol36/dsh-plugin-ghproxy.git
dsh plugin --profile web add ./dsh-plugin-ghproxy
```

安装后重启 profile（`dsh web`），或在 DSH 桌面端的插件页里添加该目录。

### 命名

所有对外标识符都带发布者命名空间 `sevastopol36`——宿主对同一作用域内的重名工具会直接
拒绝（`tool "X" is already registered`），带前缀才能与他人插件共存。完整声明见
[`dsh-plugin.naming.json`](./dsh-plugin.naming.json)。

### 验证

```bash
node verify.mjs            # 离线：18 项断言，不联网、不装依赖
node verify.mjs --live     # 追加联网检查；网络不可达时标记为 skip 而非失败
VERIFY_STRICT=1 node verify.mjs --live   # 把联网检查也当作硬性失败
```

`verify.mjs` 会校验插件导出形态、`dsh.bundle.patch` 声明、工具名与
`dsh-plugin.naming.json` 是否一致，以及每个 `@deepseek-ai/dsh*` peer 范围是否接受
`package.json` 中 `dsh.compatibility.verifiedRuntimes` 列出的运行时。
`BUILD-INFO.json` 记录了每个发布文件的 sha256，可用来确认仓库里的代码就是经过测试的那份。

### 许可

MIT。