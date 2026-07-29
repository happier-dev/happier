import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const testSource = path.join(packageRoot, "scripts", "tts-job-registry.test.cpp");
const commonCppDir = path.join(packageRoot, "common", "cpp");
const buildDir = mkdtempSync(path.join(tmpdir(), "sherpa-native-tts-job-registry-"));
const outputBinary = path.join(buildDir, process.platform === "win32" ? "tts-job-registry.exe" : "tts-job-registry");
const configuredCompiler = process.env.CXX?.trim();
const compilerCandidates = configuredCompiler ? [configuredCompiler] : ["c++", "clang++", "g++"];

function tryCompiler(compiler) {
  return spawnSync(
    compiler,
    ["-std=c++17", "-I", commonCppDir, testSource, "-o", outputBinary],
    { stdio: "inherit" },
  );
}

let compileResult = null;
let selectedCompiler = null;

try {
  for (const compiler of compilerCandidates) {
    const result = tryCompiler(compiler);
    if (result.error && result.error.code === "ENOENT") {
      continue;
    }
    compileResult = result;
    selectedCompiler = compiler;
    break;
  }

  if (!compileResult || !selectedCompiler) {
    console.error("No C++ compiler found. Set CXX or install one of: c++, clang++, g++.");
    process.exit(1);
  }

  if ((compileResult.status ?? 1) !== 0) {
    process.exit(compileResult.status ?? 1);
  }

  const runResult = spawnSync(outputBinary, [], { stdio: "inherit" });
  if (runResult.error) {
    throw runResult.error;
  }
  process.exit(runResult.status ?? 1);
} finally {
  rmSync(buildDir, { force: true, recursive: true });
}
