/**
 * GitHub access through public file proxies.
 *
 * The proxy base this plugin originally shipped with (gh.jasonzeng.dev) stopped
 * answering entirely, so the plugin now keeps an ordered mirror list, measures
 * which mirrors actually work, and fails over automatically.
 *
 * Proxy URL shape (all supported mirrors agree on it):
 *     <proxyBase>/<full original URL>
 * e.g.
 *     https://gh-proxy.com/https://raw.githubusercontent.com/u/r/b/main/file
 *     https://sevastopol36-ghproxy.net/https://github.com/u/r/releases/download/v1.0/a.zip
 *     https://gh-proxy.com/https://api.github.com/repos/u/r
 *
 * No runtime dependencies: Node global fetch + node:fs / node:stream.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const name = "sevastopol36-ghproxy";
const inject = ["tools", "systemPrompt"];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Verified live 2026-02 against raw / blob / archive targets:
 *   gh-proxy.com  and sevastopol36-ghproxy.net  also serve api.github.com (JSON).
 *   ghfast.top    and gh.ddlc.top  serve files but not the API.
 * gh.jasonzeng.dev is retained last so an existing config keeps working if the
 * service ever returns; it currently fails on every request.
 */
export const DEFAULT_PROXY_BASES = [
  "https://gh-proxy.com",
  "https://sevastopol36-ghproxy.net",
  "https://ghfast.top",
  "https://gh.ddlc.top",
  "https://gh.jasonzeng.dev",
];

/** Mirrors that answered a raw-file request correctly during the live audit. */
export const VERIFIED_PROXY_BASES = [
  "https://gh-proxy.com",
  "https://sevastopol36-ghproxy.net",
  "https://ghfast.top",
  "https://gh.ddlc.top",
];

/**
 * Mirrors measured to serve `api.github.com` JSON. The others answer 403/404 on
 * that route, so an API request is never sent to them first.
 * Measured 2026-02: gh-proxy.com -> 200; sevastopol36-ghproxy.net -> 403;
 * ghfast.top -> 403; gh.ddlc.top -> 404.
 */
export const API_CAPABLE_PROXY_BASES = ["https://gh-proxy.com"];

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const Config = z.object({
  proxyBases: z
    .array(z.string())
    .default(DEFAULT_PROXY_BASES)
    .description("Proxy mirrors tried in order. The first healthy one wins; dead ones are skipped."),
  proxyBase: z
    .string()
    .default("")
    .description("Deprecated single-proxy setting. When set it is tried before proxyBases, for backwards compatibility."),
  timeoutMs: z
    .number()
    .default(60000)
    .description("Per-attempt request timeout in milliseconds"),
  retries: z
    .number()
    .default(1)
    .description("Retries per mirror before failing over to the next one"),
  retryDelayMs: z
    .number()
    .default(800)
    .description("Delay between retries in milliseconds"),
  healthCacheMs: z
    .number()
    .default(300000)
    .description("How long a mirror health result is reused before re-measuring (milliseconds)"),
  downloadDir: z
    .string()
    .default("downloads/github")
    .description("Directory (relative to the dsh server cwd) for downloaded files"),
  maxTextBytes: z
    .number()
    .default(256 * 1024)
    .description("Largest text response returned inline; larger text is saved to disk"),
  previewBytes: z
    .number()
    .default(4096)
    .description("Preview length returned when a large text file is saved instead of inlined"),
  maxBytes: z
    .number()
    .default(200 * 1024 * 1024)
    .description("Default maximum download size in bytes"),
  overwrite: z
    .boolean()
    .default(false)
    .description("Overwrite an existing file with the same name (false adds a numeric suffix)"),
  userAgent: z
    .string()
    .default(DEFAULT_UA)
    .description("User-Agent header sent to the proxy"),
  allowApi: z
    .boolean()
    .default(true)
    .description("Allow api.github.com JSON routes through proxies known to support them"),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;

function clampInt(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(2)} KB`;
  return `${bytes} B`;
}

function delay(ms, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolveDelay, ms);
    if (timer.unref) timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        rejectDelay(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function withBudget(exec, ms) {
  if (!exec?.signal) return AbortSignal.timeout(ms);
  return AbortSignal.any([exec.signal, AbortSignal.timeout(ms)]);
}

function isTimeoutError(err) {
  return err?.name === "TimeoutError" || /timed out|timeout/i.test(String(err?.message ?? ""));
}

function isNetworkError(err) {
  const message = String(err?.message ?? "");
  return (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("ENOTFOUND") ||
    message.includes("EAI_AGAIN") ||
    message.includes("network")
  );
}

export function sanitizeFilename(raw) {
  const cleaned = basename(String(raw ?? "").replace(/\\/g, "/"))
    .trim()
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/^\.+$/, "file")
    .slice(0, 200);
  return cleaned || "github-file";
}

const EXT_FOR_MIME = {
  "application/gzip": ".gz",
  "application/json": ".json",
  "application/octet-stream": ".bin",
  "application/pdf": ".pdf",
  "application/vnd.rar": ".rar",
  "application/x-7z-compressed": ".7z",
  "application/x-bzip2": ".bz2",
  "application/x-gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-xz": ".xz",
  "application/x-yaml": ".yml",
  "application/zip": ".zip",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

export function filenameFromContentDisposition(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, "")));
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = header.match(/filename\s*=\s*["']?([^"';]+)["']?/i);
  return plain ? sanitizeFilename(plain[1]) : null;
}

export function filenameFromTarget(target) {
  try {
    const url = new URL(target);
    const segments = url.pathname.split("/").filter(Boolean);
    let raw = segments.length ? segments[segments.length - 1] : "";
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    if (!raw || raw === "download") raw = segments[segments.length - 2] ?? "github-file";
    return sanitizeFilename(raw);
  } catch {
    return "github-file";
  }
}

function extFromContentType(contentType) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  return EXT_FOR_MIME[mime] ?? "";
}

function uniquePath(filePath) {
  if (!existsSync(filePath)) return filePath;
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(dir, `${stem}-${Date.now()}${ext}`);
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

const GITHUB_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "avatars.githubusercontent.com",
  "githubusercontent.com",
  "api.github.com",
  "uploads.github.com",
]);

/**
 * Validate and normalise a GitHub URL for proxying.
 *
 * `api.github.com` is accepted (gh-proxy.com and sevastopol36-ghproxy.net serve it), but the
 * caller is told which mirrors cannot, so `scihub`-style silent failures do not
 * happen.
 */
export function normalizeGithubUrl(input, { allowApi = true } = {}) {
  let raw = String(input ?? "").trim();
  if (!raw) throw new Error("url is required");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (!GITHUB_HOSTS.has(host)) {
    throw new Error(
      `Unsupported host "${host}". Only GitHub hosts can be routed through the proxy: github.com, raw.githubusercontent.com, codeload.github.com, objects.githubusercontent.com, gist.github.com, gist.githubusercontent.com, api.github.com.`,
    );
  }
  if (host === "github.com") {
    const repoPath = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\.git)?(?:[/?#]|$)/);
    if (!repoPath) {
      throw new Error(
        `Unsupported GitHub URL: ${raw}. Expected github.com/<owner>/<repo>[/blob|raw|archive|releases|suites/...].`,
      );
    }
  }
  if (host === "api.github.com" && !allowApi) {
    throw new Error("api.github.com routing is disabled by the `allowApi: false` config.");
  }
  return url.href;
}

export function buildProxyUrl(target, proxyBase) {
  const base = String(proxyBase || DEFAULT_PROXY_BASES[0]).trim().replace(/\/+$/, "");
  return `${base}/${target}`;
}

/** `api.github.com` is only served by a subset of the mirrors. */
function mirrorsFor(target, config) {
  const all = proxyList(config);
  let host = "";
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    /* handled by normalizeGithubUrl */
  }
  if (host === "api.github.com") {
    // Prefer the mirrors measured to serve the API; keep the rest as a last
    // resort so a future change in one of them is still usable.
    const capable = all.filter((b) => API_CAPABLE_PROXY_BASES.includes(b));
    const rest = all.filter((b) => !API_CAPABLE_PROXY_BASES.includes(b));
    return capable.length ? [...capable, ...rest] : all;
  }
  return all;
}

function proxyList(config) {
  const list = [];
  if (config.proxyBase) list.push(String(config.proxyBase).replace(/\/+$/, ""));
  for (const b of config.proxyBases ?? []) {
    const base = String(b).replace(/\/+$/, "");
    if (base && !list.includes(base)) list.push(base);
  }
  return list.length ? list : [...DEFAULT_PROXY_BASES];
}

// ---------------------------------------------------------------------------
// Health tracking
// ---------------------------------------------------------------------------

/** Mirror health, shared across calls in this process. */
const health = new Map();

function healthOf(config) {
  const key = proxyList(config).join("|");
  let entry = health.get(key);
  if (!entry) {
    entry = { ok: new Map(), measuredAt: 0 };
    health.set(key, entry);
  }
  return entry;
}

function recordHealth(config, base, ok) {
  const entry = healthOf(config);
  entry.ok.set(base, ok);
  entry.measuredAt = Date.now();
}

/** Mirrors considered healthy, most recent measurement first. */
function healthyOrder(config) {
  const entry = healthOf(config);
  const fresh = Date.now() - entry.measuredAt < (config.healthCacheMs ?? 300000);
  const all = proxyList(config);
  const known = all.filter((b) => entry.ok.get(b) === true);
  const unknown = all.filter((b) => !entry.ok.has(b));
  const bad = all.filter((b) => entry.ok.get(b) === false);
  if (!fresh) return { ordered: [...known, ...unknown, ...bad], stale: true };
  return { ordered: [...known, ...unknown, ...bad], stale: false };
}

/** For tests / diagnostics. */
export function resetProxyHealth() {
  health.clear();
}

// ---------------------------------------------------------------------------
// Proxy fetch + streaming download
// ---------------------------------------------------------------------------

/**
 * Fetch a target through the mirror list with failover.
 *
 * `onMirror` is called for each attempt so a caller can report progress.
 * Throws only when every mirror failed, with every reason in the message.
 */
export async function fetchViaProxy(target, config, signal, { onMirror, mirrors } = {}) {
  const candidates = mirrors ?? mirrorsFor(target, config);
  const { ordered, stale } = healthyOrder(config);
  const ranked = [...candidates].sort((a, b) => {
    const ia = ordered.indexOf(a);
    const ib = ordered.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const errors = [];
  const maxAttempts = clampInt(config.retries, 1, 0, 5) + 1;

  for (const base of ranked) {
    const proxyUrl = buildProxyUrl(target, base);
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(clampInt(config.timeoutMs, 60000, 1000, 10 * 60000)),
      ]);
      try {
        const response = await fetch(proxyUrl, {
          headers: { "User-Agent": config.userAgent, Accept: "*/*" },
          redirect: "follow",
          signal: attemptSignal,
        });
        if (response.ok) {
          recordHealth(config, base, true);
          onMirror?.({ base, proxyUrl, status: response.status, ok: true });
          return { response, signal: attemptSignal, proxyUrl, base };
        }
        const status = response.status;
        let detail = "";
        try {
          detail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
        } catch {
          /* detail is best-effort */
        }
        lastError = new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`);
        onMirror?.({ base, proxyUrl, status, ok: false, error: lastError.message });
        // A 4xx is the mirror refusing this URL shape (e.g. an API route on a
        // file-only mirror) — fail over instead of retrying the same mirror.
        break;
      } catch (err) {
        if (signal?.aborted) throw err; // caller cancelled: never mask it
        lastError = err;
        onMirror?.({ base, proxyUrl, ok: false, error: err.message });
        const retryable = (isTimeoutError(err) || isNetworkError(err)) && attempt < maxAttempts - 1;
        if (!retryable) break;
        await delay(clampInt(config.retryDelayMs, 800, 0, 30000), signal);
      }
    }
    recordHealth(config, base, false);
    errors.push(`${base}: ${lastError?.message ?? "failed"}`);
  }

  const err = new Error(
    `Every GitHub proxy failed for ${target}${stale ? " (health cache expired)" : ""}.\n` +
      `Mirrors tried:\n${errors.map((e) => `  - ${e}`).join("\n")}\n` +
      `Run sevastopol36_ghproxy_probe to see which mirrors are alive, then set \`proxyBases\` in the profile patch.`,
  );
  err.mirrorErrors = errors;
  throw err;
}

async function downloadToTemp(fetched, maxBytes, callerSignal) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-ghproxy-"));
  const tmpFile = join(dir, "payload.bin");
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new Error(
            `Download exceeds max_bytes (${maxBytes}, ~${formatBytes(maxBytes)}). Raise max_bytes or download a smaller asset.`,
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(Readable.fromWeb(fetched.response.body), limiter, createWriteStream(tmpFile), {
      signal: fetched.signal,
    });
    return { dir, tmpFile, bytes: total };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (callerSignal?.aborted) throw err; // caller cancelled: never mask it
    if (err?.name === "AbortError" || isTimeoutError(err)) {
      throw new Error(
        `Timed out while downloading ${fetched.response.url ?? fetched.proxyUrl}. Raise timeoutMs in config.`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Content classification
// ---------------------------------------------------------------------------

const TEXT_MIME =
  /^(?:text\/|application\/(?:json|javascript|xml|x-yaml|x-sh|x-shellscript|graphql|toml|yaml|x-httpd-php|wasm|x-ndjson))/i;

const TEXT_EXTENSIONS = new Set([
  ".bat", ".c", ".cc", ".cfg", ".clj", ".cmake", ".conf", ".cpp", ".cs",
  ".css", ".csv", ".cxx", ".dart", ".dockerfile", ".editorconfig", ".env",
  ".ex", ".exs", ".gitattributes", ".gitignore", ".go", ".graphql", ".h",
  ".hbs", ".hh", ".hpp", ".htm", ".html", ".ini", ".java", ".js", ".json",
  ".jsonc", ".jsx", ".kt", ".kts", ".less", ".lua", ".m", ".markdown", ".md",
  ".mdx", ".mjs", ".mk", ".nix", ".php", ".pl", ".properties", ".proto",
  ".ps1", ".psm1", ".py", ".pyi", ".pyx", ".r", ".rb", ".rs", ".rst",
  ".sass", ".scss", ".sh", ".sql", ".svelte", ".svg", ".swift", ".tex",
  ".text", ".toml", ".ts", ".tsv", ".tsx", ".txt", ".vim", ".vue", ".xml",
  ".yaml", ".yml",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".br", ".bz2", ".deb", ".dll", ".dmg",
  ".doc", ".docx", ".eot", ".exe", ".flac", ".gif", ".gz", ".ico", ".iso",
  ".jar", ".jpeg", ".jpg", ".lockb", ".m4a", ".mov", ".mp3", ".mp4", ".o",
  ".ogg", ".otf", ".pdf", ".png", ".ppt", ".pptx", ".rar", ".rpm", ".so",
  ".sqlite", ".sqlite3", ".tar", ".tgz", ".tif", ".tiff", ".ttf", ".wasm",
  ".wav", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".xz",
  ".zip", ".zst",
]);

/** Proxy landing / ad pages are HTML, so a "successful" fetch can be junk. */
export function isProxyLanding(head, contentType) {
  if (!String(contentType || "").toLowerCase().includes("text/html")) return false;
  const text = head.toString("utf8");
  return (
    text.includes("GitHub 文件加速") ||
    text.includes("<title>GitHub 文件加速</title>") ||
    text.includes("键入Github文件链接") ||
    text.includes("GitHub Proxy 最新地址") ||
    /<title>Loading\.\.\.<\/title>/i.test(text) ||
    text.includes("Invalid input.")
  );
}

export function looksLikeText(head, size, contentType, ext) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (TEXT_MIME.test(mime)) return true;
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (size === 0) return true;
  if (
    (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) ||
    (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) ||
    (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff)
  ) {
    return true;
  }
  if (head.indexOf(0) !== -1) return false;
  if (mime === "application/octet-stream") return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(head);
    if (!text.trim()) return false;
    let printable = 0;
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
    }
    return printable / text.length > 0.9;
  } catch {
    return false;
  }
}

function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = tmp;
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

async function readHead(filePath, bytes) {
  const handle = await open(filePath, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// End-to-end fetch
// ---------------------------------------------------------------------------

async function resolveDest(args, config, target, response, filenameHint) {
  const contentDisposition = response.headers.get("content-disposition");
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
  let filename =
    filenameHint ||
    filenameFromContentDisposition(contentDisposition) ||
    filenameFromTarget(target) ||
    "github-file";
  if (!extname(filename) && contentType) filename += extFromContentType(contentType);
  filename = sanitizeFilename(filename);
  const downloadDir = resolve(process.cwd(), config.downloadDir);
  let dest;
  if (args?.save_as) {
    const given = String(args.save_as).trim();
    dest =
      isAbsolute(given) || /[/\\]/.test(given)
        ? resolve(process.cwd(), given)
        : join(downloadDir, given);
  } else {
    dest = join(downloadDir, filename);
  }
  return dest;
}

async function materialize(tmpFile, dest, config, args) {
  await mkdir(dirname(dest), { recursive: true });
  const overwrite = args?.overwrite === true || config.overwrite === true;
  const finalPath = overwrite ? dest : uniquePath(dest);
  await copyFile(tmpFile, finalPath);
  return finalPath;
}

export async function fetchGithubResource(args, config, signal, { forceSave, onMirror } = {}) {
  const target = normalizeGithubUrl(args.url, { allowApi: config.allowApi !== false });
  const fetched = await fetchViaProxy(target, config, signal, { onMirror });
  const maxBytes = clampInt(args.max_bytes ?? config.maxBytes, config.maxBytes, 1, 10 * GB);
  const { dir, tmpFile, bytes } = await downloadToTemp(fetched, maxBytes, signal);

  try {
    const contentType = (fetched.response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const head = await readHead(tmpFile, 64 * KB);
    if (isProxyLanding(head, contentType)) {
      throw new Error(
        `Proxy ${fetched.base} answered with a landing/error page instead of the file: it cannot serve this URL. Try another mirror (sevastopol36_ghproxy_probe lists live ones).`,
      );
    }

    const ext = extname(filenameFromTarget(target)).toLowerCase();
    const textKind = looksLikeText(head, bytes, contentType, ext);

    if (textKind && !forceSave) {
      if (bytes <= clampInt(config.maxTextBytes, 256 * KB, 1024, 8 * MB)) {
        const full = await readHead(tmpFile, bytes);
        return {
          kind: "text",
          text: decodeText(full),
          target,
          proxyUrl: fetched.proxyUrl,
          mirror: fetched.base,
          contentType,
          sizeBytes: bytes,
        };
      }
      const dest = await resolveDest(args, config, target, fetched.response);
      const finalPath = await materialize(tmpFile, dest, config, args);
      const preview = await readHead(tmpFile, clampInt(config.previewBytes, 4096, 0, 64 * KB));
      return {
        kind: "saved",
        target,
        proxyUrl: fetched.proxyUrl,
        mirror: fetched.base,
        contentType,
        sizeBytes: bytes,
        filePath: finalPath,
        preview: decodeText(preview),
        reason: "text too large to inline",
      };
    }

    const dest = await resolveDest(args, config, target, fetched.response);
    const finalPath = await materialize(tmpFile, dest, config, args);
    return {
      kind: "saved",
      target,
      proxyUrl: fetched.proxyUrl,
      mirror: fetched.base,
      contentType,
      sizeBytes: bytes,
      filePath: finalPath,
      preview: "",
      reason: textKind ? "save requested" : "binary content",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Mirror health probe
// ---------------------------------------------------------------------------

/**
 * Probe every configured mirror against a raw file, a release asset shape and
 * api.github.com, and report latency + verdict per mirror.
 */
export async function probeProxyMirrors(config, signal, { targets } = {}) {
  const list = proxyList(config);
  const checks = targets ?? [
    { label: "raw", url: "https://raw.githubusercontent.com/nodejs/node/main/README.md", expect: /Node\.js|JavaScript runtime/i },
    { label: "archive", url: "https://github.com/octocat/Hello-World/archive/refs/heads/master.zip", expectPdf: false, expectZip: true },
    { label: "api", url: "https://api.github.com/repos/octocat/Hello-World" },
  ];

  const rows = [];
  for (const base of list) {
    for (const check of checks) {
      const started = Date.now();
      const proxyUrl = buildProxyUrl(check.url, base);
      try {
        const res = await fetch(proxyUrl, {
          headers: { "User-Agent": config.userAgent, Accept: "*/*" },
          redirect: "follow",
          signal: AbortSignal.any([signal, AbortSignal.timeout(clampInt(config.timeoutMs, 60000, 2000, 60000))]),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
        const head = buf.subarray(0, 200).toString("utf8");
        let verdict = "unusable";
        if (res.ok) {
          if (check.expect && check.expect.test(head)) verdict = "ok";
          else if (check.expectZip && isZip) verdict = "ok";
          else if (check.label === "api" && /^\s*[[{]/.test(head)) verdict = "ok";
          else verdict = "landing page";
        } else {
          verdict = `HTTP ${res.status}`;
        }
        if (verdict === "landing page") recordHealth(config, base, false);
        rows.push({ base, check: check.label, ms: Date.now() - started, status: res.status, bytes: buf.length, verdict });
      } catch (err) {
        if (signal?.aborted) throw err;
        rows.push({ base, check: check.label, ms: Date.now() - started, status: 0, bytes: 0, verdict: `unreachable: ${err.message}` });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSaved(result) {
  const lines = [
    "GitHub download complete via proxy:",
    `  Original URL: ${result.target}`,
    `  Mirror:       ${result.mirror}`,
    `  Proxy URL:    ${result.proxyUrl}`,
    `  Content-Type: ${result.contentType || "(unknown)"}`,
    `  Saved to:     ${result.filePath}`,
    `  Size:         ${result.sizeBytes} bytes (${formatBytes(result.sizeBytes)})`,
    result.reason ? `  Note:         ${result.reason}` : "",
  ];
  if (result.preview) {
    lines.push("", `Preview (first ${result.preview.length} chars):`, result.preview);
  }
  return lines.filter(Boolean).join("\n");
}

function formatProbe(rows) {
  const byBase = new Map();
  for (const r of rows) {
    if (!byBase.has(r.base)) byBase.set(r.base, []);
    byBase.get(r.base).push(r);
  }
  const lines = ["GitHub proxy mirror probe", ""];
  const good = [];
  for (const [base, checks] of byBase) {
    const okCount = checks.filter((c) => c.verdict === "ok").length;
    if (okCount) good.push({ base, okCount, avg: checks.reduce((n, c) => n + c.ms, 0) / checks.length });
    lines.push(`  ${okCount === checks.length ? "GOOD" : okCount ? "PART" : "DEAD"}  ${base}  (${okCount}/${checks.length} routes)`);
    for (const c of checks) lines.push(`          ${c.check.padEnd(8)} ${String(c.ms).padStart(6)}ms  HTTP ${c.status}  ${c.verdict}`);
  }
  good.sort((a, b) => b.okCount - a.okCount || a.avg - b.avg);
  if (good.length) {
    lines.push("", "Suggested config (healthy mirrors, best first):", "    proxyBases:");
    for (const g of good) lines.push(`      - '${g.base}'`);
  } else {
    lines.push("", "No mirror is usable. Check network/proxy access, then add a working mirror to `proxyBases`.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const bases = proxyList(config);

  ctx.systemPrompt.section({
    name: "sevastopol36-ghproxy",
    order: 144,
    text: () =>
      [
        "## GitHub Access (verified proxy mirrors)",
        "",
        "GitHub is reached through public file proxies because direct github.com requests often time out. The plugin keeps several mirrors and fails over automatically.",
        `Configured mirrors, in order: ${bases.join(", ")}`,
        "",
        "Tools:",
        "- `sevastopol36_ghproxy_fetch` — read raw / text / JSON content; large text or binary content is saved to disk automatically.",
        "- `sevastopol36_ghproxy_download` — download raw files, release assets, repository archives (zip/tar.gz) and gists to disk.",
        "- `sevastopol36_ghproxy_proxy_url` — build a mirror URL for shell tools (git clone / curl / wget), and for `git clone <proxyUrl>`.",
        "- `sevastopol36_ghproxy_probe` — measure which mirrors are alive right now. Run this first when a GitHub request fails.",
        "",
        "Supported targets: github.com/<owner>/<repo>/(blob|raw|archive|releases|suites)/..., raw.githubusercontent.com/..., codeload.github.com/..., gist.github.com/..., gist.githubusercontent.com/... and api.github.com (JSON).",
        "For git clone use `sevastopol36_ghproxy_proxy_url` and run: git clone <proxyUrl> — the proxy also serves the git smart-HTTP endpoint.",
      ].join("\n"),
  });

  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_ghproxy_fetch",
      description:
        "Fetch GitHub raw files, blob pages, gists, release assets, repository archives or api.github.com JSON through a working proxy mirror, with automatic failover between mirrors. Text responses are returned inline; binary or oversized content is saved to disk. Use when a direct GitHub request times out.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description:
            "Original GitHub URL, e.g. https://raw.githubusercontent.com/owner/repo/branch/file, https://github.com/owner/repo/blob/branch/file, or https://api.github.com/repos/owner/repo",
        },
        save: { type: "boolean", description: "Force saving to disk even when the response is text (default false)" },
        save_as: {
          type: "string",
          description: "Optional target filename or relative path under the download dir; absolute paths are allowed",
        },
        max_bytes: { type: "number", description: "Maximum bytes to download for this call (default from config, 200 MB)" },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      presentCall(args) {
        return { card: "generic", title: `GitHub fetch: ${args.url}`, kind: "fetch", rawInput: args.url };
      },
      async execute(args, exec) {
        const signal = withBudget(
          exec,
          clampInt(config.timeoutMs, 60000, 1000, 600000) * (clampInt(config.retries, 1, 0, 5) + 1) * 4 + 5000,
        );
        const result = await fetchGithubResource(args, config, signal, { forceSave: args.save === true });
        if (result.kind === "text") return result.text;
        return formatSaved(result);
      },
    }),
  );

  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_ghproxy_download",
      description:
        "Download a GitHub file through a working proxy mirror and save it locally, with automatic failover. Supports raw.githubusercontent.com files, github.com blob/raw pages, release assets (releases/download/...), repository archives (archive/...zip|tar.gz), codeload archives and gist files.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description:
            "Original GitHub URL, e.g. https://github.com/owner/repo/releases/download/v1.0/asset.zip",
        },
        save_as: {
          type: "string",
          description: "Optional target filename or relative path under the download dir; absolute paths are allowed",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite an existing file with the same name (default false: a numeric suffix is added)",
        },
        max_bytes: { type: "number", description: "Maximum bytes to download for this call (default from config, 200 MB)" },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      presentCall(args) {
        return { card: "generic", title: `GitHub download: ${args.url}`, kind: "download", rawInput: args.url };
      },
      async execute(args, exec) {
        const signal = withBudget(
          exec,
          clampInt(config.timeoutMs, 60000, 1000, 600000) * (clampInt(config.retries, 1, 0, 5) + 1) * 4 + 5000,
        );
        const result = await fetchGithubResource(args, config, signal, { forceSave: true });
        return formatSaved(result);
      },
    }),
  );

  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_ghproxy_proxy_url",
      description:
        "Build proxy mirror URLs (<proxyBase>/<full GitHub URL>) for shell tools such as git clone, curl or wget. Returns every configured mirror so the caller can retry the next one if the first fails. Supports github.com repo/archive/releases/blob/raw, codeload, raw.githubusercontent.com and gist URLs.",
      parameters: {
        url: {
          type: "string",
          required: true,
          description: "Original GitHub URL, e.g. https://github.com/owner/repo or https://github.com/owner/repo/releases/download/v1.0/asset.zip",
        },
        prefer: {
          type: "string",
          description: "Optional proxy base to put first, e.g. https://gh-proxy.com",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      presentCall(args) {
        return { card: "generic", title: `GitHub proxy URL: ${args.url}`, kind: "fetch", rawInput: args.url };
      },
      async execute(args) {
        const target = normalizeGithubUrl(args.url, { allowApi: config.allowApi !== false });
        const candidates = mirrorsFor(target, config);
        const wanted = String(args.url);
        const isRepoClone = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/?#]+(?:\.git)?\/?$/i.test(wanted);
        const { ordered } = healthyOrder(config);
        const sorted = [...candidates].sort((a, b) => {
          if (args.prefer) {
            if (a === args.prefer.replace(/\/+$/, "")) return -1;
            if (b === args.prefer.replace(/\/+$/, "")) return 1;
          }
          const ia = ordered.indexOf(a);
          const ib = ordered.indexOf(b);
          return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
        const lines = [`Original: ${target}`, "", `Proxy URLs (${sorted.length} mirrors, first is preferred):`];
        for (const base of sorted) {
          const state = healthOf(config).ok.get(base);
          lines.push(`  [${state === true ? "live" : state === false ? "dead" : " ?  "}] ${buildProxyUrl(target, base)}`);
        }
        lines.push("", "Shell examples:");
        if (isRepoClone) {
          lines.push(`  git clone ${buildProxyUrl(target, sorted[0])}`);
        }
        lines.push(`  curl -L -o file "${buildProxyUrl(target, sorted[0])}"`);
        lines.push(`  wget -O file "${buildProxyUrl(target, sorted[0])}"`);
        if (sorted.length > 1) {
          lines.push("", "If the first mirror fails, retry the next URL in the list — they all point at the same upstream.");
        }
        return lines.join("\n");
      },
    }),
  );

  // -------------------------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: "sevastopol36_ghproxy_probe",
      description:
        "Measure which GitHub proxy mirrors are alive right now. Probes each configured mirror against a raw file, a repository archive and the api.github.com JSON route, and prints latency plus a suggested `proxyBases` config. Run this first whenever a GitHub request fails.",
      parameters: {
        include_defaults: {
          type: "boolean",
          description: "Also probe the built-in default mirrors, even when a custom proxyBases list is configured",
        },
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: String(value) }],
      },
      presentCall() {
        return { card: "generic", title: "Probe GitHub proxy mirrors", kind: "execute" };
      },
      async execute(args, exec) {
        const signal = withBudget(exec, 8 * 60000);
        const probeConfig = args.include_defaults
          ? { ...config, proxyBases: [...new Set([...proxyList(config), ...DEFAULT_PROXY_BASES])] }
          : config;
        const rows = await probeProxyMirrors(probeConfig, signal);
        return formatProbe(rows);
      },
    }),
  );
}

export { Config, apply, inject, name };
export { fetchGithubResource as fetchResource, proxyList };
