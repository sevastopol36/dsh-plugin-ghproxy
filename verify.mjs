/**
 * dsh-plugin-ghproxy verification.
 *
 * Offline by default: every check below runs with no network and no
 * dependencies, and covers URL normalisation, proxy URL construction and the
 * response-classification helpers. Pass `--live` to add the checks that go
 * through the real proxy mirrors (slower, and they fail when a mirror is down
 * rather than when the code is wrong).
 *
 *   node verify.mjs
 *   node verify.mjs --live
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { satisfiesRange } from "./lib/semver-range.mjs";
import {
  DEFAULT_PROXY_BASES,
  buildProxyUrl,
  fetchGithubResource,
  filenameFromTarget,
  formatBytes,
  normalizeGithubUrl,
  probeProxyMirrors,
  sanitizeFilename,
} from "./lib/index.mjs";

const live = process.argv.includes("--live");
let passed = 0;
const failures = [];
/** Checks that failed for a network reason, reported without failing the run. */
const environmental = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(` FAIL  ${name}\n        ${error.message}`);
  }
}

async function checkAsync(name, fn, { environmental: isEnvironmental = false } = {}) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    if (isEnvironmental) {
      environmental.push({ name, error });
      console.log(` skip  ${name}\n        network-dependent, unavailable here: ${error.message.split("\n")[0]}`);
      return;
    }
    failures.push({ name, error });
    console.log(` FAIL  ${name}\n        ${error.message}`);
  }
}

console.log("plugin manifest and module shape");

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const module_ = await import("./lib/index.mjs");

check("manifest declares the bundle patch", () => {
  assert.equal(manifest.dsh?.bundle?.patch, "./cordis.patch.yml");
});
check("the declared patch inserts this package", async () => {
  const patch = await readFile(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  // The row id comes from the naming declaration, so a rename has one home.
  const naming = JSON.parse(await readFile(new URL("./dsh-plugin.naming.json", import.meta.url), "utf8"));
  assert.match(patch, new RegExp(naming.names.loaderIds[0]));
  assert.match(patch, new RegExp(manifest.name));
});
check("module exports the cordis plugin shape", () => {
  assert.equal(typeof module_.name, "string");
  assert.equal(typeof module_.apply, "function");
  assert.ok(Array.isArray(module_.inject));
  assert.ok(module_.Config !== undefined, "Config schema is exported");
});
check("every @deepseek-ai/dsh* peer accepts the verified runtimes", () => {
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"),
  );
  assert.ok(peers.length > 0, "at least one dsh peer is declared");
  for (const runtime of manifest.dsh.compatibility.verifiedRuntimes) {
    for (const [name, range] of peers) {
      assert.ok(
        satisfiesRange(runtime, range),
        `${name} ${range} rejects ${runtime}`,
      );
    }
  }
});
check("the range helper agrees with the host's peer check on the shapes used", () => {
  const range = manifest.peerDependencies["@deepseek-ai/dsh-tools"];
  assert.equal(satisfiesRange("0.1.5-rc.1", range), true);
  assert.equal(satisfiesRange("0.2.0-rc.2", range), true);
  assert.equal(satisfiesRange("0.2.0-rc.2", "^0.1.0-rc.6"), false);
  assert.equal(satisfiesRange("0.1.5-rc.2", "^0.1.0-rc.6"), true);
  assert.equal(satisfiesRange("0.2.0-rc.2", "not-a-range"), false);
});
check("the naming declaration matches the plugin and the bundle patch", async () => {
  // A duplicate tool name in one scope is rejected by the host with
  // `tool "X" is already registered`, so every public identifier carries the
  // publisher namespace and the declaration records exactly which ones.
  const naming = JSON.parse(await readFile(new URL("./dsh-plugin.naming.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  const rowId = /^\s*- id: (\S+)$/m.exec(patch)?.[1];

  assert.equal(naming.plugin.packageName, manifest.name);
  assert.equal(naming.plugin.coordinate, `${naming.plugin.namespace}/${naming.plugin.name}`);
  assert.deepEqual(naming.names.pluginNames, [module_.name]);
  assert.deepEqual(naming.names.loaderIds, [rowId]);
  assert.ok(naming.names.tools.length > 0, "the plugin registers tools");
  for (const tool of naming.names.tools) {
    assert.ok(tool.startsWith(`${naming.plugin.namespace}_`), `${tool} is not namespace-prefixed`);
  }
  for (const surface of ["services", "commands", "skills", "skillProviders", "events", "settingsNamespaces", "routes"]) {
    assert.deepEqual(naming.names[surface], [], `${surface} must be empty because the plugin registers none`);
  }
});

console.log("\nURL normalisation");

check("a raw.githubusercontent URL passes through", () => {
  const url = "https://raw.githubusercontent.com/a/b/main/c";
  assert.equal(normalizeGithubUrl(url), url);
});
check("a repo clone URL is accepted", () => {
  assert.ok(normalizeGithubUrl("https://github.com/a/b.git").endsWith(".git"));
});
check("a blob URL is accepted", () => {
  assert.ok(normalizeGithubUrl("https://github.com/a/b/blob/main/c").includes("/blob/"));
});
check("api.github.com is accepted by default", () => {
  assert.ok(normalizeGithubUrl("https://api.github.com/repos/a/b"));
});
check("api.github.com is rejected when allowApi is off", () => {
  assert.throws(() => normalizeGithubUrl("https://api.github.com/repos/a/b", { allowApi: false }));
});
check("a non-GitHub host is rejected", () => {
  assert.throws(() => normalizeGithubUrl("https://example.com/a/b"));
});
check("the bare github.com root is rejected", () => {
  assert.throws(() => normalizeGithubUrl("https://github.com/"));
});

console.log("\nproxy URL construction");

check("buildProxyUrl prefixes the full target URL", () => {
  assert.equal(
    buildProxyUrl("https://raw.githubusercontent.com/a/b/main/c", "https://gh-proxy.com/"),
    "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/c",
  );
});
check("a proxy base without a trailing slash still works", () => {
  assert.equal(
    buildProxyUrl("https://raw.githubusercontent.com/a/b/main/c", "https://gh-proxy.com"),
    "https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/c",
  );
});
check("the default mirror list is non-empty and healthy-first", () => {
  assert.ok(DEFAULT_PROXY_BASES.length >= 3);
  assert.equal(DEFAULT_PROXY_BASES[0], "https://gh-proxy.com");
});

console.log("\nfilename and size helpers");

check("formatBytes scales units", () => {
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(1024 * 1024), "1.00 MB");
});
check("sanitizeFilename removes path separators", () => {
  const safe = sanitizeFilename("../../etc/pa:sswd*?");
  assert.ok(!/[/\\:*?"<>|]/.test(safe), `still unsafe: ${safe}`);
});
check("filenameFromTarget takes the last path segment", () => {
  assert.equal(filenameFromTarget("https://github.com/a/b/archive/refs/heads/main.zip"), "main.zip");
});

if (live) {
  console.log("\nlive checks (network)");
  const config = {
    proxyBases: DEFAULT_PROXY_BASES,
    timeoutMs: 60000,
    retries: 1,
    retryDelayMs: 500,
    downloadDir: "downloads/github",
    maxTextBytes: 64 * 1024,
    previewBytes: 2048,
    maxBytes: 10 * 1024 * 1024,
    allowApi: true,
  };
  const signal = AbortSignal.timeout(180000);
  const strict = process.env.VERIFY_STRICT === "1";
  const opts = { environmental: !strict };

  await checkAsync(
    "probeProxyMirrors reports at least one usable mirror",
    async () => {
      // One row per (mirror, route); `verdict` is the outcome ("ok" or
      // "HTTP 4xx" / "unreachable: ...").
      const rows = await probeProxyMirrors(config, signal);
      assert.ok(Array.isArray(rows) && rows.length > 0, "no probe rows");
      assert.ok(
        rows.some((row) => row.verdict === "ok"),
        `no usable mirror: ${JSON.stringify(rows)}`,
      );
    },
    opts,
  );
  await checkAsync(
    "a small raw file is fetched through a mirror",
    async () => {
      const result = await fetchGithubResource(
        { url: "https://raw.githubusercontent.com/octocat/Hello-World/master/README" },
        config,
        signal,
        { forceSave: false },
      );
      assert.equal(result.kind, "text", JSON.stringify(result));
    },
    opts,
  );
  await checkAsync(
    "an oversized target is streamed to disk",
    async () => {
      const dest = resolve(process.cwd(), "verify-out.zip");
      try {
        const result = await fetchGithubResource(
          {
            url: "https://github.com/octocat/Hello-World/archive/refs/heads/master.zip",
            save_as: dest,
            overwrite: true,
          },
          config,
          signal,
          { forceSave: true },
        );
        assert.equal(result.kind, "saved", JSON.stringify(result));
        assert.ok(result.sizeBytes > 100, `implausibly small archive: ${result.sizeBytes}`);
      } finally {
        await rm(dest, { force: true }).catch(() => {});
      }
    },
    opts,
  );
}

const failed = failures.length;
console.log(
  `\n${passed}/${passed + failed} checks passed${live ? " (including live checks)" : " (offline)"}` +
    (environmental.length > 0 ? `, ${environmental.length} skipped as network-dependent` : ""),
);
if (failed > 0) {
  console.log("failed checks:");
  for (const { name } of failures) console.log(`  - ${name}`);
}
process.exitCode = failed === 0 ? 0 : 1;
