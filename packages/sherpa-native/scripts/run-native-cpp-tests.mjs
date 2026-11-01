import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Kept in test:native so ordinary JS-only validation does not require a C++ toolchain.
test("native streaming ASR finalizes the last words at the stream's input sample rate", () => {
  const buildDir = mkdtempSync(path.join(tmpdir(), "sherpa-asr-finish-"));
  try {
    const binary = path.join(buildDir, process.platform === "win32" ? "asr-finish.exe" : "asr-finish");
    const compile = spawnSync(process.env.CXX || "c++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      "-I", path.join(packageRoot, "common", "cpp"),
      "-I", path.join(packageRoot, "android", "src", "main", "cpp", "include"),
      path.join(packageRoot, "scripts", "online-asr-finish.test.cpp"), "-o", binary,
    ], { encoding: "utf8" });
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, compile.stderr);

    const result = spawnSync(binary, [], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});
