import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const scriptsDir = path.join(packageRoot, "scripts");
const commonCppDir = path.join(packageRoot, "common", "cpp");
const buildDir = mkdtempSync(path.join(tmpdir(), "sherpa-native-cpp-tests-"));
const configuredCompiler = process.env.CXX?.trim();
const compilerCandidates = configuredCompiler ? [configuredCompiler] : ["c++", "clang++", "g++"];

// The registries under test hand native handles between a decoding thread and a
// cancelling one, so the assertions are only as strong as the memory checking
// underneath them. Compile with the sanitizers when the toolchain has them and
// fall back to a plain build otherwise, reporting which mode actually ran.
const sanitizedFlags = ["-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-g"];

function testSources() {
  return readdirSync(scriptsDir)
    .filter((entry) => entry.endsWith(".test.cpp"))
    .sort()
    .map((entry) => path.join(scriptsDir, entry));
}

function compile(compiler, source, output, extraFlags) {
  return spawnSync(
    compiler,
    ["-std=c++17", ...extraFlags, "-I", commonCppDir, source, "-o", output],
    { stdio: "inherit" },
  );
}

function selectCompiler(source, output) {
  for (const compiler of compilerCandidates) {
    const probe = compile(compiler, source, output, sanitizedFlags);
    if (probe.error && probe.error.code === "ENOENT") {
      continue;
    }
    if ((probe.status ?? 1) === 0) {
      return { compiler, extraFlags: sanitizedFlags, sanitized: true };
    }
    // The compiler exists but rejected the sanitizer build; retry unsanitized so
    // a toolchain without the runtime libraries still runs the assertions.
    const plain = compile(compiler, source, output, []);
    if ((plain.status ?? 1) === 0) {
      return { compiler, extraFlags: [], sanitized: false };
    }
    return null;
  }
  return null;
}

try {
  const sources = testSources();
  if (sources.length === 0) {
    console.error(`No *.test.cpp sources found in ${scriptsDir}.`);
    process.exit(1);
  }

  let selection = null;

  for (const source of sources) {
    const name = path.basename(source, ".test.cpp");
    const output = path.join(buildDir, process.platform === "win32" ? `${name}.exe` : name);

    if (!selection) {
      selection = selectCompiler(source, output);
      if (!selection) {
        console.error(
          `Failed to build ${path.basename(source)}. Set CXX or install one of: c++, clang++, g++.`,
        );
        process.exit(1);
      }
      console.log(
        `[sherpa-native] ${selection.compiler}${selection.sanitized ? " (address,undefined sanitizers)" : " (no sanitizers)"}`,
      );
    } else {
      const result = compile(selection.compiler, source, output, selection.extraFlags);
      if ((result.status ?? 1) !== 0) {
        process.exit(result.status ?? 1);
      }
    }

    const runResult = spawnSync(output, [], { stdio: "inherit" });
    if (runResult.error) {
      throw runResult.error;
    }
    if ((runResult.status ?? 1) !== 0) {
      console.error(`[sherpa-native] ${path.basename(source)} failed`);
      process.exit(runResult.status ?? 1);
    }
    console.log(`[sherpa-native] ${path.basename(source)} passed`);
  }

  process.exit(0);
} finally {
  rmSync(buildDir, { force: true, recursive: true });
}
