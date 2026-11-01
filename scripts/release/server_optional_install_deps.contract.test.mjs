import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

test("developer installs defer Redis acquisition while validation still acquires it on demand", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const require = createRequire(path.join(repoRoot, "apps/server/package.json"));
  const postinstall = require.resolve("redis-memory-server/scripts/postinstall.js");
  const redisEntry = require.resolve("redis-memory-server");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "happier-redis-install-"));
  try {
    fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ redisMemoryServer: manifest.redisMemoryServer }));
    const serverDirectory = path.join(fixture, "apps/server");
    fs.mkdirSync(serverDirectory, { recursive: true });
    fs.writeFileSync(path.join(serverDirectory, "package.json"), JSON.stringify({ name: "server" }));
    const env = { ...process.env, REDISMS_DOWNLOAD_DIR: path.join(fixture, "redis"), REDISMS_VERSION: "missing-install-probe", REDISMS_DOWNLOAD_URL: "not-a-valid-url" };
    delete env.REDISMS_DISABLE_POSTINSTALL;
    delete env.REDISMS_SYSTEM_BINARY;
    for (const cwd of [fixture, serverDirectory]) {
      const install = spawnSync(process.execPath, [postinstall], { cwd, env: { ...env, INIT_CWD: cwd }, encoding: "utf8" });
      assert.equal(install.status, 0, install.stdout + install.stderr);
    }
    const runtime = spawnSync(process.execPath, ["-e", "require(process.argv[1]).RedisMemoryServer.create().then(async instance => { await instance.getIp(); await instance.stop(); }).catch(error => { console.error(error); process.exitCode = 1; });", redisEntry], { cwd: fixture, env, encoding: "utf8" });
    assert.equal(runtime.status, 1, runtime.stdout + runtime.stderr);
    assert.match(runtime.stdout + runtime.stderr, /Provided incorrect download url/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
