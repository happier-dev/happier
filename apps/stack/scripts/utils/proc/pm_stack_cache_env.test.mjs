import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureCliBuilt, ensureDepsInstalled, pmExecBin } from './pm.mjs';
import { withCliDistBuildLock } from './cliDistBuildLock.mjs';
import { readHappyCliRuntimeInputFreshness } from './cli_runtime_inputs.mjs';
import { resolveValidRuntimeSnapshot } from '../../../../cli/bin/_resolveRuntimeEntrypoint.mjs';
import {
  inspectSourceDevSharedDepsForSourceDev,
} from '../../../../cli/scripts/buildSharedDeps.mjs';

const CLI_DIST_BUILD_MANIFEST_MODULE_PATH = fileURLToPath(
  new URL('../../../../../packages/cli-common/cliDistBuildManifest.cjs', import.meta.url),
);
const { writeCliDistBuildManifest } = createRequire(import.meta.url)(CLI_DIST_BUILD_MANIFEST_MODULE_PATH);

test('CLI runtime input identity is independent of relative, absolute, or aliased package paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-input-path-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const inputPath = join(cliDir, 'src', 'tracked.ts');
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {},
  }), 'utf-8');
  await writeFile(inputPath, 'export const value = 1;\n', 'utf-8');

  const absolute = await readHappyCliRuntimeInputFreshness(cliDir);
  const relativePath = relative(process.cwd(), cliDir);
  const relativeInput = await readHappyCliRuntimeInputFreshness(relativePath);
  const aliasDir = join(root, 'cli-alias');
  await symlink(cliDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasedInput = await readHappyCliRuntimeInputFreshness(aliasDir);

  assert.equal(relativeInput.fingerprint, absolute.fingerprint);
  assert.equal(relativeInput.newestMtimeNs, absolute.newestMtimeNs);
  assert.equal(aliasedInput.fingerprint, absolute.fingerprint);
  assert.equal(aliasedInput.newestMtimeNs, absolute.newestMtimeNs);
});

test('CLI runtime input identity changes after a same-size rewrite with restored modification time', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-input-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const inputPath = join(cliDir, 'src', 'tracked.ts');
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {},
  }), 'utf-8');
  await writeFile(inputPath, 'export const value = 1;\n', 'utf-8');

  const stableTimestampSeconds = 1_700_000_000;
  await utimes(inputPath, stableTimestampSeconds, stableTimestampSeconds);
  const originalStats = await stat(inputPath, { bigint: true });
  const before = await readHappyCliRuntimeInputFreshness(cliDir);
  await writeFile(inputPath, 'export const value = 2;\n', 'utf-8');
  await utimes(
    inputPath,
    stableTimestampSeconds,
    stableTimestampSeconds,
  );
  assert.equal((await stat(inputPath, { bigint: true })).mtimeNs, originalStats.mtimeNs);
  const after = await readHappyCliRuntimeInputFreshness(cliDir);

  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('CLI runtime input identity ignores an identical rewrite with different filesystem metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-input-identical-rewrite-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const inputPath = join(cliDir, 'src', 'generated.ts');
  await mkdir(dirname(inputPath), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {},
  }), 'utf-8');
  const content = 'export const generated = true;\n';
  await writeFile(inputPath, content, 'utf-8');

  const beforeStat = await stat(inputPath, { bigint: true });
  const before = await readHappyCliRuntimeInputFreshness(cliDir);
  await writeFile(inputPath, content, 'utf-8');
  const afterStat = await stat(inputPath, { bigint: true });
  const after = await readHappyCliRuntimeInputFreshness(cliDir);

  assert.notEqual(afterStat.ctimeNs, beforeStat.ctimeNs);
  assert.equal(after.fingerprint, before.fingerprint);
});

test('CLI runtime input identity ignores directory timestamp churn without hiding tree membership changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-input-directory-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const srcDir = join(cliDir, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {},
  }), 'utf-8');
  await writeFile(join(srcDir, 'tracked.ts'), 'export const tracked = true;\n', 'utf-8');

  const before = await readHappyCliRuntimeInputFreshness(cliDir);

  const ignoredPath = join(srcDir, 'transient.test.ts');
  await writeFile(ignoredPath, 'ignored\n', 'utf-8');
  const withIgnoredChild = await readHappyCliRuntimeInputFreshness(cliDir);
  await rm(ignoredPath);
  const afterIgnoredRoundtrip = await readHappyCliRuntimeInputFreshness(cliDir);
  assert.equal(withIgnoredChild.fingerprint, before.fingerprint);
  assert.equal(afterIgnoredRoundtrip.fingerprint, before.fingerprint);

  const addedPath = join(srcDir, 'added.ts');
  const renamedPath = join(srcDir, 'renamed.ts');
  await writeFile(addedPath, 'export const added = true;\n', 'utf-8');
  const afterAdd = await readHappyCliRuntimeInputFreshness(cliDir);
  await rename(addedPath, renamedPath);
  const afterRename = await readHappyCliRuntimeInputFreshness(cliDir);
  await rm(renamedPath);
  const afterDelete = await readHappyCliRuntimeInputFreshness(cliDir);

  assert.notEqual(afterAdd.fingerprint, before.fingerprint);
  assert.notEqual(afterRename.fingerprint, afterAdd.fingerprint);
  assert.notEqual(afterDelete.fingerprint, afterRename.fingerprint);
  assert.equal(afterDelete.fingerprint, before.fingerprint);
});

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fakeCliDistManifestWriteLine(outputDirExpression) {
  const source = 'const path=require("node:path");const m=require(process.env.HAPPIER_TEST_CLI_DIST_MANIFEST_MODULE);const dir=process.env.HAPPIER_TEST_CLI_DIST_DIR;const inputFingerprint=process.env.HAPPIER_CLI_BUILD_INPUT_FINGERPRINT;m.writeCliDistBuildManifest(path.join(dir,"index.mjs"),{outputDir:dir,builtAt:"2026-07-09T00:00:00.000Z",...(inputFingerprint?{inputFingerprint}:{})});';
  return `  HAPPIER_TEST_CLI_DIST_MANIFEST_MODULE=${shellSingleQuote(CLI_DIST_BUILD_MANIFEST_MODULE_PATH)} HAPPIER_TEST_CLI_DIST_DIR=${outputDirExpression} ${shellSingleQuote(process.execPath)} -e ${shellSingleQuote(source)}`;
}

async function writeYarnEnvDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      "const out = {",
      '  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,',
      '  YARN_CACHE_FOLDER: process.env.YARN_CACHE_FOLDER ?? null,',
      '  npm_config_cache: process.env.npm_config_cache ?? null,',
      '  REDISMS_DISABLE_POSTINSTALL: process.env.REDISMS_DISABLE_POSTINSTALL ?? null,',
      '  HOME: process.env.HOME ?? null,',
      '  NODE_ENV: process.env.NODE_ENV ?? null,',
      '  YARN_PRODUCTION: process.env.YARN_PRODUCTION ?? null,',
      '  npm_config_production: process.env.npm_config_production ?? null,',
      '  NPM_CONFIG_PRODUCTION: process.env.NPM_CONFIG_PRODUCTION ?? null,',
      '};',
      "writeFileSync(process.env.OUTPUT_PATH, JSON.stringify(out, null, 2) + '\\n');",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnRuntimeDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      "const out = {",
      '  fakeNodeUsed: process.env.FAKE_NODE_USED ?? null,',
      '  execPath: process.execPath,',
      '};',
      "writeFileSync(process.env.OUTPUT_PATH, JSON.stringify(out, null, 2) + '\\n');",
      'process.exit(0);',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeNvmNodeShim({ nvmDir, version }) {
  const binDir = join(nvmDir, 'versions', 'node', version, 'bin');
  await mkdir(binDir, { recursive: true });
  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'export FAKE_NODE_USED=1',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(nodePath, 0o755);
}

async function writeFailingNodeShim({ binDir }) {
  await mkdir(binDir, { recursive: true });
  const nodePath = join(binDir, 'node');
  await writeFile(
    nodePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "wrong node selected" >&2',
      'exit 86',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(nodePath, 0o755);
}

async function writeYarnArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnUiPostinstallStub({ binDir, outputPath, requiredOutputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "install" ]]; then mkdir -p node_modules; fi',
      'if [[ "$*" == "-s workspace @happier-dev/app postinstall:real" ]]; then',
      `  mkdir -p ${JSON.stringify(dirname(requiredOutputPath))}`,
      `  printf '%s\n' 'export const patched = true;' > ${JSON.stringify(requiredOutputPath)}`,
      'fi',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeSlowYarnArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "install" ]; then',
      '  if [ -n "${LOCK_OUTPUT_PATH:-}" ]; then',
      '    printf "%s\\n" "${HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD:-}" > "$LOCK_OUTPUT_PATH"',
      '  fi',
      '  sleep 0.25',
      '  mkdir -p node_modules',
      'fi',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeNpmArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const npmPath = join(binDir, 'npm');
  await writeFile(
    npmPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(npmPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeCorepackYarnArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const corepackPath = join(binDir, 'corepack');
  await writeFile(
    corepackPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "yarn" && "${2:-}" == "--version" ]]; then',
      '  echo "1.22.22"',
      'fi',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(corepackPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

function fakeAtomicCliDistBuildLines(writeOutputLines) {
  return [
    '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist.staging.$$}"',
    '  rm -rf "$out"',
    '  mkdir -p "$out"',
    ...writeOutputLines,
    fakeCliDistManifestWriteLine('"$out"'),
    '  backup="dist.__fake_backup__.$$"',
    '  rm -rf "$backup"',
    '  if [ -e dist ]; then mv dist "$backup"; fi',
    '  if ! mv "$out" dist; then',
    '    if [ -e "$backup" ]; then mv "$backup" dist; fi',
    '    exit 4',
    '  fi',
    '  rm -rf "$backup"',
  ];
}

async function writeYarnStagedBuildFailureStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist.staging.$$}"',
      '  rm -rf "$out"',
      '  mkdir -p "$out"',
      '  echo "export const incomplete = true;" > "$out/index.mjs"',
      '  echo "simulated build failure" >&2',
      '  if [ -n "${HAPPIER_TEST_SECRET:-}" ]; then',
      '    echo "HAPPIER_TEST_SECRET=${HAPPIER_TEST_SECRET}" >&2',
      '  fi',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnCanonicalCliInputChangeStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');",
      "const { dirname, join } = require('node:path');",
      'const [command] = process.argv.slice(2);',
      'if (command === "--version") {',
      '  console.log("1.22.22");',
      '  process.exit(0);',
      '}',
      'appendFileSync(process.env.OUTPUT_PATH, `${process.argv.slice(2).join(" ")}\\n`);',
      'if (command !== "build:prepared") process.exit(0);',
      '(async () => {',
      '  const { buildCliDist } = await import(process.env.HAPPIER_TEST_CLI_BUILD_MODULE_URL);',
      '  const admittedFingerprint = process.env.HAPPIER_CLI_BUILD_INPUT_FINGERPRINT;',
      '  if (!/^[a-f0-9]{64}$/.test(admittedFingerprint ?? "")) {',
      '    throw new Error("missing admitted CLI input fingerprint");',
      '  }',
      '  mkdirSync(join(process.cwd(), "src"), { recursive: true });',
      '  writeFileSync(join(process.cwd(), "src", "generated.ts"), "export const generated = true;\\n", "utf8");',
      '  try {',
      '    await buildCliDist({',
      '      packageRoot: process.cwd(),',
      '      repoRoot: process.env.HAPPIER_TEST_REPO_ROOT,',
      '      skipLock: true,',
      '      env: process.env,',
      '      resolveTypeScriptCliInvocationImpl: () => ({ argsPrefix: ["/canonical/runTypeScriptCli.mjs"] }),',
      '      runTypecheckImpl: () => {},',
      '      runPkgrollBuildImpl: ({ outputDir, packageJsonPath }) => {',
      '        const stageDir = join(dirname(packageJsonPath), outputDir);',
      '        mkdirSync(stageDir, { recursive: true });',
      '        writeFileSync(join(stageDir, "index.mjs"), "export const mixed = true;\\n", "utf8");',
      '      },',
      '    });',
      '  } catch (error) {',
      '    const message = error instanceof Error ? error.message : String(error);',
      '    if (/runtime inputs changed while this build was running/i.test(message)) {',
      '      // Present the exact terminal filesystem state observed from the failed child process.',
      '      rmSync(join(process.cwd(), "dist"), { recursive: true, force: true });',
      '    }',
      '    throw error;',
      '  }',
      '})().catch((error) => {',
      '  console.error(error instanceof Error ? error.message : String(error));',
      '  process.exit(2);',
      '});',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildCreatesDistStub({ binDir, outputPath, cliDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      ...fakeAtomicCliDistBuildLines([
        '  if [ -n "${LOCK_OUTPUT_PATH:-}" ]; then',
        '    printf "%s\\n" "${HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD:-}" > "$LOCK_OUTPUT_PATH"',
        '  fi',
        '  echo "export const built = true;" > "$out/index.mjs"',
      ]),
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnForceRepairPkgrollThenBuildStub({ binDir, outputPath, cliDir, pkgrollCliPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "install" ] && [ "${2:-}" = "--force" ]; then',
      `  cat > ${JSON.stringify(pkgrollCliPath)} <<'EOF'`,
      '#!/usr/bin/env node',
      'console.log("pkgroll repaired");',
      'EOF',
      '  chmod 755 ' + JSON.stringify(pkgrollCliPath),
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      ...fakeAtomicCliDistBuildLines([
        '  echo "export const built = true;" > "$out/index.mjs"',
      ]),
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildCreatesPartialDistWithMissingChunkStub({ binDir, outputPath, cliDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist.staging.$$}"',
      '  rm -rf "$out"',
      '  mkdir -p "$out"',
      // Simulate a "successful" build that leaves a broken local import graph.
      // The canonical CLI builder validates the staged graph before promotion, so model that
      // boundary failure and leave the previous dist untouched.
      '  echo "import \'./index-inner.mjs\';" > "$out/index.mjs"',
      '  echo "import \'./missing-chunk.mjs\';" > "$out/index-inner.mjs"',
      '  echo "incomplete staged CLI build" >&2',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, agentsDir }) {
  await mkdir(binDir, { recursive: true });
  const stubPath = join(binDir, 'yarn-stub.cjs');
  await writeFile(
    stubPath,
    [
      "const { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      "appendFileSync(process.env.OUTPUT_PATH, args.join(' ') + '\\n');",
      "if (args[0] === '--version') { console.log('1.22.22'); process.exit(0); }",
      "if (args[0] === '-s' && args[1] === 'build') {",
      `  const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || ${JSON.stringify(join(agentsDir, 'dist'))};`,
      "  mkdirSync(join(out, 'session', 'state'), { recursive: true });",
      "  writeFileSync(join(out, 'session', 'state', 'index.js'), 'export const state = true;\\n');",
      "  writeFileSync(join(out, 'index.js'), 'export const agentsBuilt = true;\\n');",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'build:prepared') {",
      "  const out = process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR || `dist.staging.${process.pid}`;",
      "  const backup = `dist.__fake_backup__.${process.pid}`;",
      '  rmSync(out, { recursive: true, force: true });',
      '  rmSync(backup, { recursive: true, force: true });',
      '  mkdirSync(out, { recursive: true });',
      "  writeFileSync(join(out, 'index.mjs'), 'export const cliBuilt = true;\\n');",
      '  const manifest = require(process.env.HAPPIER_TEST_CLI_DIST_MANIFEST_MODULE);',
      "  manifest.writeCliDistBuildManifest(join(out, 'index.mjs'), {",
      '    outputDir: out,',
      "    builtAt: '2026-07-09T00:00:00.000Z',",
      '    ...(process.env.HAPPIER_CLI_BUILD_INPUT_FINGERPRINT',
      '      ? { inputFingerprint: process.env.HAPPIER_CLI_BUILD_INPUT_FINGERPRINT }',
      '      : {}),',
      '  });',
      "  if (existsSync('dist')) renameSync('dist', backup);",
      "  renameSync(out, 'dist');",
      '  rmSync(backup, { recursive: true, force: true });',
      '}',
    ].join('\n') + '\n',
    'utf-8'
  );
  const yarnPath = join(binDir, process.platform === 'win32' ? 'yarn.cmd' : 'yarn');
  await writeFile(
    yarnPath,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0yarn-stub.cjs" %*\r\n`
      : `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/yarn-stub.cjs" "$@"\n`,
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnSlowBuildCreatesDistStub({ binDir, outputPath, cliDir }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  if [ -n "${HAPPIER_TEST_WAIT_FOR_BUILD_MARKER:-}" ]; then',
      '    while [ ! -f "$HAPPIER_TEST_WAIT_FOR_BUILD_MARKER" ] || [ -e "${HAPPIER_TEST_WAIT_FOR_BUILD_LOCK:?}" ]; do sleep 0.05; done',
      '  fi',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  sleep "${HAPPIER_TEST_BUILD_SLEEP_SECONDS:-1}"',
      ...fakeAtomicCliDistBuildLines([
        '  echo "export const built = true;" > "$out/index.mjs"',
      ]),
      '  if [ -n "${HAPPIER_TEST_BUILD_COMPLETE_MARKER:-}" ]; then : > "$HAPPIER_TEST_BUILD_COMPLETE_MARKER"; fi',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function waitForFileText(path, matcher, { timeoutMs = 5_000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const text = await readFile(path, 'utf-8');
      if (matcher.test(text)) {
        return;
      }
    } catch {
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for ${path} to match ${matcher}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runCapture(cmd, args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += String(c)));
    proc.stderr.on('data', (c) => (err += String(c)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`command failed: ${cmd} ${args.join(' ')} (code=${code})\n${err}`));
    });
  });
}

function expectedCacheEnv({ envPath }) {
  const base = join(dirname(envPath), 'cache');
  return {
    xdg: join(base, 'xdg'),
    yarn: join(base, 'yarn'),
    npm: join(base, 'npm'),
  };
}

function withoutInheritedPackageManagerHints(env) {
  const isolatedEnv = { ...env };
  delete isolatedEnv.npm_execpath;
  delete isolatedEnv.npm_config_user_agent;
  return isolatedEnv;
}

function applyEnvOverrides(t, vars) {
  const isolatedVars = {
    npm_execpath: null,
    npm_config_user_agent: null,
    ...vars,
  };
  const previous = {};
  for (const key of Object.keys(isolatedVars)) {
    previous[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(isolatedVars)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
}

async function createStackCacheFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stackDir = join(root, 'stacks', 'exp1');
  const envPath = join(stackDir, 'env');
  await mkdir(dirname(envPath), { recursive: true });
  await writeFile(envPath, 'HAPPIER_STACK_STACK=exp1\n', 'utf-8');

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');

  const binDir = join(root, 'bin');
  return { root, envPath, componentDir, binDir };
}

test('ensureDepsInstalled sets stack-scoped cache env vars for yarn installs', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-cache-install-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  const exp = expectedCacheEnv({ envPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_HOME_DIR: null,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: null,
    XDG_CACHE_HOME: null,
    YARN_CACHE_FOLDER: null,
    npm_config_cache: null,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.XDG_CACHE_HOME, exp.xdg);
  assert.equal(parsed.YARN_CACHE_FOLDER, exp.yarn);
  assert.equal(parsed.npm_config_cache, exp.npm);
});

test('ensureDepsInstalled does not publish lockfile changes from a synchronized dev target', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-dev-target-lockfile-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_DEV_TARGET_EXECUTION: '1',
  });

  await ensureDepsInstalled(componentDir, 'remote workspace', { quiet: true });

  assert.match(await readFile(outputPath, 'utf-8'), /^install .*--pure-lockfile\b/m);
});

test('ensureDepsInstalled skips dependency refresh in service mode when node_modules already exists', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-cache-service-install-skip-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');

  await writeYarnArgDumpStub({ binDir, outputPath });

  // Simulate existing node_modules + stale integrity so refresh would normally run.
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# new lock\n', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_SERVICE_MODE: '1',
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env });
  const out = await readFile(outputPath, 'utf-8');
  assert.ok(!out.includes('install'), `expected no yarn install in service mode, got:\n${out}`);
});

test('ensureDepsInstalled skips dependency refresh when explicitly disabled in local mode', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-cache-local-refresh-disable-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');

  await writeYarnArgDumpStub({ binDir, outputPath });

  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# new lock\n', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env });
  const out = await readFile(outputPath, 'utf-8');
  assert.ok(!out.includes('install'), `expected no yarn install when refresh is disabled, got:\n${out}`);
});

test('ensureDepsInstalled explicitly suppresses refresh of an existing dependency tree', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-existing-tree-no-refresh-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');

  await writeYarnArgDumpStub({ binDir, outputPath });
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'node_modules', '.yarn-integrity'), 'old\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# changed lock\n', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'hstack-home'),
    HAPPIER_STACK_SKIP_REFRESH_DEPS: null,
  });

  await ensureDepsInstalled(componentDir, 'test-component', {
    quiet: true,
    env: process.env,
    refreshExisting: false,
  });
  const out = await readFile(outputPath, 'utf-8');
  assert.ok(!out.includes('install'), `expected the existing dependency tree to be reused, got:\n${out}`);
});

test('ensureDepsInstalled still installs a missing dependency tree when existing refresh is suppressed', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-missing-tree-no-refresh-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');

  await writeYarnArgDumpStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'hstack-home'),
  });

  await ensureDepsInstalled(componentDir, 'test-component', {
    quiet: true,
    env: process.env,
    refreshExisting: false,
  });
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /^install\b/m);
});

test('ensureDepsInstalled scrubs production-mode env for yarn installs', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-cache-prod-scrub-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    NODE_ENV: 'production',
    YARN_PRODUCTION: '1',
    npm_config_production: 'true',
    NPM_CONFIG_PRODUCTION: 'true',
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.notEqual(parsed.NODE_ENV, 'production');
  assert.notEqual(parsed.YARN_PRODUCTION, '1');
  assert.notEqual(parsed.npm_config_production, 'true');
  assert.notEqual(parsed.NPM_CONFIG_PRODUCTION, 'true');
});

test('ensureDepsInstalled scrubs production-mode env even without a stack env file', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-prod-scrub-no-env-file-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    NODE_ENV: 'production',
    YARN_PRODUCTION: '1',
    npm_config_production: 'true',
    NPM_CONFIG_PRODUCTION: 'true',
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.notEqual(parsed.NODE_ENV, 'production');
  assert.notEqual(parsed.YARN_PRODUCTION, '1');
  assert.notEqual(parsed.npm_config_production, 'true');
  assert.notEqual(parsed.NPM_CONFIG_PRODUCTION, 'true');
});

test('ensureDepsInstalled disables redis-memory-server postinstall for stack-managed installs', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-redis-memory-server-postinstall-disable-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.REDISMS_DISABLE_POSTINSTALL, '1');
});

test('ensureDepsInstalled honors HAPPIER_STACK_PM_CACHE_BASE_DIR when no stack env file is present', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-explicit-cache-base-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  const cacheBase = join(root, 'pm-cache');

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: cacheBase,
    XDG_CACHE_HOME: null,
    YARN_CACHE_FOLDER: null,
    npm_config_cache: null,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.XDG_CACHE_HOME, join(cacheBase, 'xdg'));
  assert.equal(parsed.YARN_CACHE_FOLDER, join(cacheBase, 'yarn'));
  assert.equal(parsed.npm_config_cache, join(cacheBase, 'npm'));
  assert.equal(parsed.HOME, join(cacheBase, 'home'));
});

test('stack package-manager preparation preserves installed bin symlinks for live file crawlers', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-isolated-workspace-tools-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');
  const eslintDir = join(componentDir, 'node_modules', 'eslint');
  const installedBinDir = join(componentDir, 'node_modules', '.bin');
  const installedBinPath = join(installedBinDir, 'eslint');

  await writeYarnArgDumpStub({ binDir, outputPath });
  await mkdir(join(eslintDir, 'bin'), { recursive: true });
  await mkdir(installedBinDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), JSON.stringify({
    private: true,
    devDependencies: { eslint: '1.0.0' },
  }) + '\n', 'utf-8');
  await writeFile(join(eslintDir, 'package.json'), JSON.stringify({
    name: 'eslint',
    version: '1.0.0',
    bin: { eslint: './bin/eslint.js' },
  }) + '\n', 'utf-8');
  await writeFile(join(eslintDir, 'bin', 'eslint.js'), '#!/usr/bin/env node\n', 'utf-8');
  await symlink('../eslint/bin/eslint.js', installedBinPath);

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env });

  assert.equal(await readlink(installedBinPath), '../eslint/bin/eslint.js');
  assert.match(
    await readFile(join(componentDir, '.project', 'tmp', 'workspace-tool-bins', 'eslint'), 'utf-8'),
    /eslint[\\/]bin[\\/]eslint\.js/,
  );
});

test('ensureDepsInstalled prefers the .nvmrc node runtime for yarn shebangs when available', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-nvm-node-runtime-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'runtime.json');
  const nvmDir = join(root, '.nvm');
  const version = 'v22.22.1';

  await writeYarnRuntimeDumpStub({ binDir, outputPath });
  await writeNvmNodeShim({ nvmDir, version });
  await writeFile(join(componentDir, '.nvmrc'), `${version}\n`, 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
    NVM_DIR: nvmDir,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.fakeNodeUsed, '1');
  assert.match(parsed.execPath, /node$/);
});

test('ensureDepsInstalled runs yarn shebangs with the stack node before incompatible PATH nodes', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-node-runtime-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'runtime.json');
  const badNodeBinDir = join(root, 'bad-node-bin');

  await writeYarnRuntimeDumpStub({ binDir, outputPath });
  await writeFailingNodeShim({ binDir: badNodeBinDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${badNodeBinDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.fakeNodeUsed, null);
  assert.equal(parsed.execPath, process.execPath);
});

test('ensureDepsInstalled prefers yarn when component is inside the Happy monorepo (packages/ layout)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-yarn-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Create the minimum monorepo markers (apps/ layout) + root yarn.lock.
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  const componentDir = join(root, 'apps', 'server');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    // Avoid leaking other package managers into PATH so the test fails loudly when a non-yarn fallback is attempted.
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'happier-server', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.ok(out.includes('install') || out.includes('--version'));
});

test('ensureDepsInstalled uses the canonical repository yarn install policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-yarn-production-flag-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  const componentDir = join(root, 'apps', 'server');
  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'happier-server', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const installLine = lines.find((l) => l.startsWith('install'));
  assert.ok(installLine, `expected yarn install to be invoked, got:\n${out}`);
  assert.match(installLine, /--production=false\b/);
  assert.match(installLine, /--ignore-engines\b/);
});

test('ensureDepsInstalled delegates Prisma output freshness to the server generator when Stack probe files already exist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-server-generate-providers-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server', 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(
    join(root, 'apps', 'server', 'package.json'),
    JSON.stringify({ name: '@happier-dev/server', scripts: { 'generate:providers': 'tsx ./scripts/generateClients.ts' } }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'apps', 'server', 'prisma', 'schema.prisma'), 'datasource db { provider = "postgresql" }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  await mkdir(join(root, 'node_modules', '.prisma', 'client'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.prisma', 'client', 'default.js'), 'module.exports = {};\n'.padEnd(3_989, ' '), 'utf-8');
  await mkdir(join(root, 'apps', 'server', 'generated', 'sqlite-client'), { recursive: true });
  await writeFile(join(root, 'apps', 'server', 'generated', 'sqlite-client', 'index.js'), 'export class PrismaClient {}\n', 'utf-8');
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const componentDir = join(root, 'apps', 'server');
  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'happier-server-light', {
    quiet: true,
    refreshExisting: false,
    prepareComponentOutputs: false,
  });
  assert.doesNotMatch(
    await readFile(outputPath, 'utf-8'),
    /\bworkspace @happier-dev\/server generate:providers\b/,
    'last-known-good admission must not gate startup on regenerated provider outputs',
  );

  await writeFile(outputPath, '', 'utf-8');
  await ensureDepsInstalled(componentDir, 'happier-server-light', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /\bworkspace @happier-dev\/server generate:providers\b/, `expected provider generation, got:\n${out}`);
});

test('ensureDepsInstalled repairs missing UI postinstall outputs on a warm dependency tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-ui-postinstall-readiness-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const component of ['cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), `{ "name": "@happier-dev/${component}" }\n`, 'utf-8');
  }
  const componentDir = join(root, 'apps', 'ui');
  await mkdir(componentDir, { recursive: true });
  await writeFile(
    join(componentDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/app',
      scripts: { 'postinstall:real': 'node ./tools/postinstall.mjs' },
    }) + '\n',
    'utf-8',
  );
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'monorepo',
      private: true,
      workspaces: { packages: ['apps/ui', 'apps/cli', 'apps/server'] },
    }) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const requiredOutputPath = join(
    componentDir,
    'node_modules',
    'react-native-enriched-markdown',
    'lib',
    'module',
    'web',
    'streamingReveal.js',
  );
  await mkdir(dirname(requiredOutputPath), { recursive: true });
  await writeFile(requiredOutputPath, 'export const patched = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnUiPostinstallStub({ binDir, outputPath, requiredOutputPath });
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: '',
  };

  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });
  await rm(requiredOutputPath);
  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });
  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });

  assert.equal((await readFile(requiredOutputPath, 'utf-8')).trim(), 'export const patched = true;');
  const commands = (await readFile(outputPath, 'utf-8')).split('\n').filter(Boolean);
  assert.equal(commands.filter((line) => line.startsWith('install ')).length, 1);
  assert.equal(
    commands.filter((line) => line === '-s workspace @happier-dev/app postinstall:real').length,
    1,
  );
});

test('ensureDepsInstalled refreshes monorepo dependencies when root yarn.lock changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-refresh-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');

  // Simulate an already-installed workspace (so we don't trigger the first-run install branch).
  await mkdir(join(root, 'apps', 'ui', 'node_modules'), { recursive: true });

  // Simulate a previous monorepo install.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  // Root yarn.lock is newer than the integrity file -> should trigger `yarn install`.
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  // Some filesystems (and CI runners) can create both files within the same timestamp quantum.
  // Make the "lock newer than integrity" ordering explicit to keep this test deterministic.
  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await utimes(join(root, 'node_modules', '.yarn-integrity'), older, older);
  await utimes(join(root, 'yarn.lock'), newer, newer);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /\binstall\b/);
});

test('ensureDepsInstalled refreshes monorepo dependencies when a workspace package manifest changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-workspace-manifest-refresh-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'protocol', 'package.json'), '{ "name": "@happier-dev/protocol", "dependencies": { "zod": "4.3.6" } }\n', 'utf-8');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'monorepo',
      private: true,
      workspaces: {
        packages: ['apps/ui', 'apps/cli', 'apps/server', 'packages/protocol'],
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'package.json'), older, older),
    utimes(join(root, 'yarn.lock'), older, older),
    utimes(join(root, 'apps', 'ui', 'package.json'), older, older),
    utimes(join(root, 'apps', 'cli', 'package.json'), older, older),
    utimes(join(root, 'apps', 'server', 'package.json'), older, older),
    utimes(join(root, 'node_modules', '.yarn-integrity'), older, older),
    utimes(join(root, 'packages', 'protocol', 'package.json'), newer, newer),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /\binstall\b/);
});

test('ensureDepsInstalled does not repeat a monorepo refresh after a successful no-op yarn install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-refresh-stamp-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(root, 'packages', 'protocol'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'packages', 'protocol', 'package.json'), '{ "name": "@happier-dev/protocol" }\n', 'utf-8');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'monorepo',
      private: true,
      workspaces: {
        packages: ['apps/ui', 'apps/cli', 'apps/server', 'packages/protocol'],
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const base = Date.now() - 20_000;
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'package.json'), older, older),
    utimes(join(root, 'yarn.lock'), older, older),
    utimes(join(root, 'apps', 'ui', 'package.json'), older, older),
    utimes(join(root, 'apps', 'cli', 'package.json'), older, older),
    utimes(join(root, 'apps', 'server', 'package.json'), older, older),
    utimes(join(root, 'node_modules', '.yarn-integrity'), older, older),
    utimes(join(root, 'packages', 'protocol', 'package.json'), newer, newer),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });
  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });

  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /\binstall\b/.test(line));
  assert.equal(installLines.length, 1, `expected one yarn install after a successful refresh, got:\n${installLines.join('\n')}`);
});

test('ensureDepsInstalled keeps a current dependency tree outside dependency and CLI publication locks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-current-deps-read-only-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  for (const component of ['ui', 'cli', 'server']) {
    await mkdir(join(root, 'apps', component), { recursive: true });
    await writeFile(join(root, 'apps', component, 'package.json'), '{}\n', 'utf-8');
  }
  await writeFile(join(root, 'package.json'), '{"name":"monorepo","private":true}\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'legacy\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const stackHome = join(root, 'stack-home');
  await writeYarnArgDumpStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_HOME_DIR: stackHome,
    HAPPIER_STACK_ENV_FILE: null,
  });

  const componentDir = join(root, 'apps', 'ui');
  await runCapture(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      `const { ensureDepsInstalled } = await import(${JSON.stringify(new URL('./pm.mjs', import.meta.url).href)});`,
      `await ensureDepsInstalled(${JSON.stringify(componentDir)}, 'happier-ui', { quiet: true, env: process.env });`,
    ].join('\n'),
  ], { cwd: root, env: process.env });

  // A warm admission must not need either mutation-lock path. Replacing both lock parents with
  // ordinary files makes an accidental lock acquisition fail deterministically instead of wait.
  await rm(join(stackHome, 'cache', 'dependencies'), { recursive: true, force: true });
  await mkdir(join(stackHome, 'cache'), { recursive: true });
  await writeFile(join(stackHome, 'cache', 'dependencies'), 'read-only-fast-path\n', 'utf-8');
  await rm(join(root, '.project'), { recursive: true, force: true });
  await writeFile(join(root, '.project'), 'read-only-fast-path\n', 'utf-8');

  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env: process.env });
  const yarnInvocations = (await readFile(outputPath, 'utf-8')).split('\n');
  const installs = yarnInvocations.filter((line) => /\binstall\b/.test(line));
  const readinessProbes = yarnInvocations.filter((line) => line.trim() === '--version');
  assert.equal(installs.length, 1);
  assert.equal(
    readinessProbes.length,
    1,
    'a current dependency tree must not re-run the Yarn/Corepack readiness probe',
  );
});

test('ensureDepsInstalled serializes concurrent refreshes and rechecks freshness after waiting', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-concurrent-install-lock-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'argv.txt');
  await writeSlowYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await Promise.all([
    ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env }),
    ensureDepsInstalled(componentDir, 'test-component', { quiet: true, env: process.env }),
  ]);

  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /^install\b/.test(line));
  assert.equal(installLines.length, 1, `expected one serialized install, got:\n${installLines.join('\n')}`);
});

test('ensureDepsInstalled refreshes independently of the monorepo CLI bundle lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-monorepo-cli-lock-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'ui');
  const cliLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
  const dependencyLockPath = join(root, '.project', 'tmp', 'dependency-install.lock');
  await mkdir(componentDir, { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{ "name": "@happier-dev/ui" }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{ "name": "@happier-dev/cli" }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n', 'utf-8');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'monorepo',
      private: true,
      workspaces: {
        packages: ['apps/ui', 'apps/cli', 'apps/server'],
      },
    }) + '\n',
    'utf-8',
  );
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'stale\n', 'utf-8');

  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'node_modules', '.yarn-integrity'), older, older),
    utimes(join(root, 'package.json'), newer, newer),
    utimes(join(root, 'yarn.lock'), newer, newer),
    utimes(join(componentDir, 'package.json'), newer, newer),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const heldLockOutputPath = join(root, 'held-cli-lock.txt');
  await writeSlowYarnArgDumpStub({ binDir, outputPath });
  const env = withoutInheritedPackageManagerHints({
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    LOCK_OUTPUT_PATH: heldLockOutputPath,
    HAPPIER_STACK_ENV_FILE: '',
  });

  let releaseCliLock;
  const releaseCliLockPromise = new Promise((resolve) => {
    releaseCliLock = resolve;
  });
  let notifyCliLockHeld;
  const cliLockHeld = new Promise((resolve) => {
    notifyCliLockHeld = resolve;
  });
  const holder = withCliDistBuildLock(
    async () => {
      notifyCliLockHeld();
      await releaseCliLockPromise;
    },
    {
      lockPath: cliLockPath,
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      staleAfterMs: 5_000,
    },
  );
  await cliLockHeld;

  const firstEnsure = ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });
  await waitForFileText(dependencyLockPath, /"pid"/);
  const secondEnsure = ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });

  try {
    await waitForFileText(outputPath, /^install\b/m);
    assert.match(
      await readFile(outputPath, 'utf-8'),
      /^install\b/m,
      'dependency refresh should not queue behind final CLI publication',
    );
    await Promise.all([firstEnsure, secondEnsure]);
  } finally {
    releaseCliLock();
  }

  await holder;

  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /^install\b/.test(line));
  assert.equal(installLines.length, 1, `expected freshness to collapse queued work to one install, got:\n${installLines.join('\n')}`);
  assert.equal((await readFile(heldLockOutputPath, 'utf-8')).trim(), '');
  await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
  await assert.rejects(() => stat(dependencyLockPath), { code: 'ENOENT' });
});

test('ensureDepsInstalled retries a failed refresh even when yarn touched node_modules', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-refresh-retry-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });

  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'node_modules'), older, older),
    utimes(join(root, 'package.json'), newer, newer),
    utimes(join(root, 'yarn.lock'), newer, newer),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const statePath = join(root, 'failed-once');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "install" ]; then',
      '  echo "$*" >> "${OUTPUT_PATH:?}"',
      '  mkdir -p node_modules',
      '  touch node_modules/.failed-install-artifact',
      '  if [ ! -e "${STATE_PATH:?}" ]; then',
      '    touch "$STATE_PATH"',
      '    exit 2',
      '  fi',
      'fi',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    STATE_PATH: statePath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await assert.rejects(
    () => ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true }),
    /yarn failed \(code=2,/,
  );
  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });

  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /\binstall\b/.test(line));
  assert.equal(installLines.length, 2, `expected the failed refresh to be retried, got:\n${installLines.join('\n')}`);
});

test('ensureDepsInstalled refreshes once when node_modules has no successful install marker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-missing-integrity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(root, 'package.json'), '{ "name": "monorepo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');

  await mkdir(join(root, 'node_modules', '@scope', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.placeholder'), 'ok\n', 'utf-8');
  await writeFile(join(root, 'node_modules', '@scope', 'pkg', 'package.json'), '{}\n', 'utf-8');

  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'package.json'), older, older),
    utimes(join(root, 'yarn.lock'), older, older),
    utimes(join(root, 'apps', 'ui', 'package.json'), older, older),
    utimes(join(root, 'apps', 'cli', 'package.json'), older, older),
    utimes(join(root, 'apps', 'server', 'package.json'), older, older),
    utimes(join(root, 'node_modules'), newer, newer),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });
  await ensureDepsInstalled(join(root, 'apps', 'ui'), 'happier-ui', { quiet: true });

  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /\binstall\b/.test(line));
  assert.equal(installLines.length, 1, `expected one install to establish a success marker, got:\n${installLines.join('\n')}`);
});

test('ensureDepsInstalled falls back to npm in binary mode when yarn is unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-binary-mode-npm-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeNpmArgDumpStub({ binDir, outputPath });

  const originalExecPath = process.execPath;
  process.execPath = join(root, 'fake-node-bin', 'node');
  t.after(() => {
    process.execPath = originalExecPath;
  });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_BINARY_MODE: '1',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'binary-mode-component', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /install/);
});

test('ensureDepsInstalled uses Corepack Yarn when a global Yarn shim is unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-corepack-yarn-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeCorepackYarnArgDumpStub({ binDir, outputPath });

  await ensureDepsInstalled(componentDir, 'corepack-component', {
    quiet: true,
    env: withoutInheritedPackageManagerHints({
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
      HAPPIER_STACK_BINARY_MODE: '0',
      HAPPIER_STACK_ENV_FILE: '',
    }),
  });

  assert.match(await readFile(outputPath, 'utf-8'), /^yarn --version\nyarn install\b/m);
});

test('ensureDepsInstalled preserves a Windows-style Path key while preparing Corepack Yarn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-corepack-windows-path-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeCorepackYarnArgDumpStub({ binDir, outputPath });

  const env = withoutInheritedPackageManagerHints({
    ...process.env,
    Path: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_BINARY_MODE: '0',
    HAPPIER_STACK_ENV_FILE: '',
  });
  delete env.PATH;

  await ensureDepsInstalled(componentDir, 'corepack-component', { quiet: true, env });
  assert.match(await readFile(outputPath, 'utf-8'), /^yarn --version\nyarn install\b/m);
});

test('pmExecBin sets stack-scoped cache env vars for yarn runs', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-stack-cache-exec-');
  const { root, envPath, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  const exp = expectedCacheEnv({ envPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: envPath,
    HAPPIER_HOME_DIR: null,
    HAPPIER_STACK_PM_CACHE_BASE_DIR: null,
    XDG_CACHE_HOME: null,
    YARN_CACHE_FOLDER: null,
    npm_config_cache: null,
  });

  await pmExecBin({ dir: componentDir, bin: 'prisma', args: ['generate'], env: process.env, quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.XDG_CACHE_HOME, exp.xdg);
  assert.equal(parsed.YARN_CACHE_FOLDER, exp.yarn);
  assert.equal(parsed.npm_config_cache, exp.npm);
});

test('ensureCliBuilt preserves previous dist output when a staged build fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-restore-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, '.gitignore'), 'dist/\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStagedBuildFailureStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });
  await assert.rejects(
    () => ensureCliBuilt(cliDir, { buildCli: true, quiet: true }),
  );
  const restored = await readFile(distIndex, 'utf-8');
  assert.equal(restored, 'export const stable = true;\n');
});

test('ensureCliBuilt rebuilds when the same dirty tracked file changes content in auto mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-dirty-content-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, '.gitignore'), 'dist/\npackage-dist/\ndist.staging.*\n', 'utf-8');
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'clean\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  execFileSync('git', ['init'], { cwd: cliDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'hstack-test@example.test'], { cwd: cliDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'hstack-test'], { cwd: cliDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: cliDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: cliDir, stdio: 'ignore' });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  mkdir -p dist',
      '  if [ -f src/tracked.txt ]; then value="$(tr -d \'\\n\' < src/tracked.txt)"; else value="deleted"; fi',
      '  printf "export const tracked = \\"%s\\";\\n" "$value" > dist/index.mjs',
      fakeCliDistManifestWriteLine('"$PWD/dist"'),
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'dirty one\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'unrelated-stack-note.txt'), 'unrelated\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'dirty content with a different size\n', 'utf-8');
  await utimes(
    join(cliDir, 'src', 'tracked.txt'),
    new Date('2000-01-01T00:00:00.000Z'),
    new Date('2000-01-01T00:00:00.000Z'),
  );
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'dirty two\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await rm(join(cliDir, 'src', 'tracked.txt'));
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await rm(join(cliDir, 'dist', '.build-manifest.json'));
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), "import './missing-after-build.mjs';\n", 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build:prepared');
  assert.equal(buildInvocations.length, 6);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const tracked = "deleted";\n');
  await assert.rejects(
    () => stat(join(root, 'home', 'cache', 'build', 'happier-cli')),
    { code: 'ENOENT' },
    'CLI freshness must not create a persistent source-signature cache',
  );
});

test('ensureCliBuilt preserves previous dist when staged import validation fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-partial-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, '.gitignore'), 'dist/\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildCreatesPartialDistWithMissingChunkStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await assert.rejects(
    () => ensureCliBuilt(cliDir, { buildCli: true, quiet: true }),
    /yarn failed \(code=2,/,
  );
  const restored = await readFile(distIndex, 'utf-8');
  assert.equal(restored, 'export const stable = true;\n');
});

test('ensureCliBuilt force-refreshes deps once when pkgroll entrypoint is a shell wrapper before building', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-repair-pkgroll-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const pkgrollCliPath = join(root, 'node_modules', 'pkgroll', 'dist', 'cli.mjs');
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(dirname(pkgrollCliPath), { recursive: true });
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "name": "repo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/ui", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server", "private": true }\n', 'utf-8');
  await writeFile(join(cliDir, 'package.json'), '{ "name": "@happier-dev/cli", "private": true }\n', 'utf-8');
  await writeFile(pkgrollCliPath, '#!/bin/sh\nexec node "$0" "$@"\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const newer = new Date(Date.now() + 5_000);
  await utimes(join(root, 'node_modules', '.yarn-integrity'), newer, newer);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnForceRepairPkgrollThenBuildStub({ binDir, outputPath, cliDir, pkgrollCliPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /\binstall --force --production=false\b/, `expected forced yarn reinstall, got:\n${argv}`);
  assert.match(argv, /(^|\n)build:prepared(\n|$)/, `expected prepared yarn build after repair, got:\n${argv}`);
  assert.match(await readFile(pkgrollCliPath, 'utf-8'), /pkgroll repaired/);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt serializes concurrent rebuilds so a fresh dist is built once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-lock-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  await runCapture('git', ['init'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.email', 'hstack-test@example.test'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.name', 'hstack-test'], { cwd: cliDir });
  await runCapture('git', ['add', '.'], { cwd: cliDir });
  await runCapture('git', ['commit', '-m', 'init'], { cwd: cliDir });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const buildCompleteMarkerPath = join(root, 'build-complete.marker');
  const buildLockPath = join(cliDir, '.dist.hstack-build.lock');
  await writeYarnSlowBuildCreatesDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  const firstBuild = ensureCliBuilt(cliDir, {
    buildCli: true,
    quiet: true,
    env: {
      ...process.env,
      HAPPIER_TEST_BUILD_SLEEP_SECONDS: '3',
      HAPPIER_TEST_BUILD_COMPLETE_MARKER: buildCompleteMarkerPath,
    },
  });
  await waitForFileText(outputPath, /^build:prepared$/m);
  const secondBuild = ensureCliBuilt(cliDir, {
    buildCli: true,
    quiet: true,
    env: {
      ...process.env,
      HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'second-cache'),
      HAPPIER_TEST_WAIT_FOR_BUILD_MARKER: buildCompleteMarkerPath,
      HAPPIER_TEST_WAIT_FOR_BUILD_LOCK: buildLockPath,
    },
  });
  await Promise.all([firstBuild, secondBuild]);

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build:prepared');
  assert.equal(buildInvocations.length, 1);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt rebuilds an atomic publication when runtime inputs changed during it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-lock-always-dirty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'initial\n', 'utf-8');

  await runCapture('git', ['init'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.email', 'hstack-test@example.test'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.name', 'hstack-test'], { cwd: cliDir });
  await runCapture('git', ['add', '.'], { cwd: cliDir });
  await runCapture('git', ['commit', '-m', 'init'], { cwd: cliDir });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  tracked="$(tr -d \'\\n\' < src/tracked.txt)"',
      '  echo "captured" >> "${OUTPUT_PATH:?}"',
      '  sleep 1',
      ...fakeAtomicCliDistBuildLines([
        '  printf \'export const tracked = "%s";\\n\' "$tracked" > "$out/index.mjs"',
      ]),
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const firstBuildPromise = ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await waitForFileText(outputPath, /(^|\n)captured(\n|$)/);
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'changed during build\n', 'utf-8');

  const firstBuild = await firstBuildPromise;

  assert.deepEqual(firstBuild, { built: true, current: false, reason: 'inputs_changed_during_build' });
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const tracked = "initial";\n');

  const trailingBuild = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  assert.deepEqual(trailingBuild, { built: true, current: true, reason: 'changed' });

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build:prepared');
  assert.equal(buildInvocations.length, 2);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const tracked = "changed during build";\n');
});

test('ensureCliBuilt detects a runtime input changed during build when another input has a newer mtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-masked-input-change-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  const changedInputPath = join(cliDir, 'src', 'changed-during-build.txt');
  const newerInputPath = join(cliDir, 'src', 'unrelated-newer-input.txt');
  await writeFile(changedInputPath, 'initial\n', 'utf-8');
  await writeFile(newerInputPath, 'unchanged\n', 'utf-8');
  const future = new Date(Date.now() + 60_000);
  await utimes(newerInputPath, future, future);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build:prepared" ]; then',
      '  sleep 1',
      ...fakeAtomicCliDistBuildLines([
        '  echo "export const built = true;" > "$out/index.mjs"',
      ]),
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  const buildPromise = ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await waitForFileText(outputPath, /(^|\n)build:prepared(\n|$)/);
  await writeFile(changedInputPath, 'changed\n', 'utf-8');

  await assert.doesNotReject(async () => {
    const result = await buildPromise;
    assert.deepEqual(result, { built: true, current: false, reason: 'inputs_changed_during_build' });
  });
});

test('ensureCliBuilt admits a canonical prebuild source publication without scheduling a duplicate build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-interrupted-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'src', 'index.ts'), 'export const initial = true;\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  // The release artifact builder moves the manifest-valid live dist here before rebuilding.
  // Simulate abnormal termination in that window, followed by a stack-requested rebuild failure.
  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const backupIndex = join(distBackupDir, 'index.mjs');
  await mkdir(dirname(backupIndex), { recursive: true });
  await writeFile(backupIndex, 'export const stable = true;\n', 'utf-8');
  writeCliDistBuildManifest(backupIndex, {
    outputDir: distBackupDir,
    builtAt: '2026-07-26T00:00:00.000Z',
  });
  const priorManifest = JSON.parse(
    await readFile(join(distBackupDir, '.build-manifest.json'), 'utf-8'),
  );

  const packageDistDir = join(cliDir, 'package-dist');
  const packageDistIndex = join(packageDistDir, 'index.mjs');
  await mkdir(packageDistDir, { recursive: true });
  await writeFile(packageDistIndex, 'export const older = true;\n', 'utf-8');
  writeCliDistBuildManifest(packageDistIndex, {
    outputDir: packageDistDir,
    builtAt: '2026-07-25T00:00:00.000Z',
  });
  const packageDistManifest = JSON.parse(
    await readFile(join(packageDistDir, '.build-manifest.json'), 'utf-8'),
  );
  assert.notEqual(packageDistManifest.fingerprint, priorManifest.fingerprint);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnCanonicalCliInputChangeStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_TEST_CLI_BUILD_MODULE_URL: pathToFileURL(
      fileURLToPath(new URL('../../../../cli/scripts/build.mjs', import.meta.url)),
    ).href,
    HAPPIER_TEST_REPO_ROOT: root,
    HAPPIER_CLI_BUILD_OUTPUT_DIR: null,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true });
  assert.deepEqual(result, { built: true, current: true, reason: 'mode_always' });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const mixed = true;\n');
  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)build:prepared(\n|$)/);
  await assert.rejects(() => stat(distBackupDir));
  const selectedSnapshot = resolveValidRuntimeSnapshot(cliDir, 'index.mjs');
  assert.equal(selectedSnapshot?.outputDir, join(cliDir, 'dist'));
  assert.notEqual(selectedSnapshot?.manifest.fingerprint, priorManifest.fingerprint);
  assert.notEqual(selectedSnapshot?.manifest.fingerprint, packageDistManifest.fingerprint);
});

test('ensureCliBuilt discards an incomplete release backup instead of making it current', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-invalid-backup-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const backupIndex = join(distBackupDir, 'index.mjs');
  await mkdir(dirname(backupIndex), { recursive: true });
  await writeFile(backupIndex, 'export const stable = true;\n', 'utf-8');
  writeCliDistBuildManifest(backupIndex, {
    outputDir: distBackupDir,
    builtAt: '2026-07-26T00:00:00.000Z',
  });
  await writeFile(backupIndex, "import './missing-chunk.mjs';\n", 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildCreatesDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const built = true;\n');
  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)build:prepared(\n|$)/);
  await assert.rejects(() => stat(distBackupDir));
});

test('ensureCliBuilt passes its exact dist lock ownership to the child build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-lock-ownership-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const lockOutputPath = join(root, 'held-lock.txt');
  await writeYarnBuildCreatesDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    LOCK_OUTPUT_PATH: lockOutputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const heldLockLease = JSON.parse((await readFile(lockOutputPath, 'utf-8')).trim());
  assert.equal(heldLockLease.path, join(await realpath(cliDir), '.dist.hstack-build.lock'));
  assert.equal(typeof heldLockLease.token, 'string');
  assert.notEqual(heldLockLease.token, '');
});

test('ensureCliBuilt preserves existing dist and reports a staged build failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-failed-restore-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnStagedBuildFailureStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_TEST_SECRET: 'must-not-escape',
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  let failure;
  try {
    await ensureCliBuilt(cliDir, { buildCli: true, quiet: true });
    assert.fail('expected quiet CLI build to fail');
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /yarn failed \(code=2,/);
  assert.match(failure.message, /simulated build failure/);
  assert.doesNotMatch(failure.message, /must-not-escape/);

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)build:prepared(\n|$)/);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const stable = true;\n');
});

test('ensureCliBuilt refreshes shared workspace deps before trusting a cached cli dist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-refresh-shared-deps-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const agentsDir = join(root, 'packages', 'agents');
  const bundledAgentsDir = join(cliDir, 'node_modules', '@happier-dev', 'agents');
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'tweetnacl'), { recursive: true });
  await mkdir(join(bundledAgentsDir, 'dist'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await mkdir(join(agentsDir, 'src'), { recursive: true });
  await mkdir(join(agentsDir, 'dist', 'session', 'state'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'repo',
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  }, null, 2) + '\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(root, 'node_modules', 'tweetnacl', 'package.json'), JSON.stringify({
    name: 'tweetnacl',
    version: '1.0.3',
    main: './index.js',
  }, null, 2) + '\n', 'utf-8');
  await writeFile(join(root, 'node_modules', 'tweetnacl', 'index.js'), 'module.exports = {};\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/ui", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server", "private": true }\n', 'utf-8');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/agents': '0.0.0',
      tweetnacl: '1.0.3',
    },
    bundledDependencies: ['@happier-dev/agents'],
  }, null, 2) + '\n', 'utf-8');
  await writeFile(
    join(cliDir, 'scripts', 'buildSharedDeps.mjs'),
    `export { syncSharedDepsForSourceDev } from ${JSON.stringify(
      new URL('../../../../cli/scripts/buildSharedDeps.mjs', import.meta.url).href,
    )};\n`,
    'utf-8',
  );
  await writeFile(
    join(cliDir, 'scripts', 'syncSharedDepsForDev.mjs'),
    [
      "import { dirname, resolve } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "import { syncSharedDepsForSourceDev } from './buildSharedDeps.mjs';",
      'const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");',
      'const workspaceNames = process.argv.slice(2).filter((value) => !value.startsWith("--"));',
      'const result = await syncSharedDepsForSourceDev({ repoRoot, workspaceNames });',
      'process.stdout.write(`__HAPPIER_SOURCE_DEV_SYNC_RESULT__=${JSON.stringify(result ?? null)}\\n`);',
      '',
    ].join('\n'),
    'utf-8',
  );
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const cached = true;\n', 'utf-8');

  await writeFile(join(agentsDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/agents',
    version: '0.0.0',
    type: 'module',
    scripts: {
      build: 'yarn build',
    },
    main: './dist/index.js',
    exports: {
      '.': {
        default: './dist/index.js',
      },
    },
  }, null, 2) + '\n', 'utf-8');
  await writeFile(join(agentsDir, 'tsconfig.json'), '{}\n', 'utf-8');
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export const source = true;\n', 'utf-8');
  await writeFile(
    join(agentsDir, 'dist', 'index.js'),
    'import "./session/state/index.js";\nexport const agentsCached = true;\n',
    'utf-8',
  );
  await writeFile(join(bundledAgentsDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/agents',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    exports: {
      '.': {
        default: './dist/index.js',
      },
    },
  }, null, 2) + '\n', 'utf-8');
  await writeFile(
    join(bundledAgentsDir, 'dist', 'index.js'),
    'export const staleBundledAgents = true;\n',
    'utf-8',
  );
  const cliDistManifest = (await import(pathToFileURL(CLI_DIST_BUILD_MANIFEST_MODULE_PATH).href)).default;
  const cliInputFreshness = await readHappyCliRuntimeInputFreshness(cliDir);
  cliDistManifest.writeCliDistBuildManifest(join(cliDir, 'dist', 'index.mjs'), {
    inputFingerprint: cliInputFreshness.fingerprint,
  });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, agentsDir });

  applyEnvOverrides(t, {
    PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
    npm_execpath: join(binDir, 'yarn-stub.cjs'),
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_ENV_FILE: null,
    HAPPIER_TEST_CLI_DIST_MANIFEST_MODULE: CLI_DIST_BUILD_MANIFEST_MODULE_PATH,
  });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)-s build(\n|$)/);
  assert.match(argv, /(^|\n)build:prepared(\n|$)/);
  assert.deepEqual(result, { built: true, current: true, reason: 'changed' });
  assert.equal(await readFile(join(agentsDir, 'dist', 'session', 'state', 'index.js'), 'utf-8'), 'export const state = true;\n');
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const cliBuilt = true;\n');
  assert.equal(
    await readFile(join(bundledAgentsDir, 'dist', 'index.js'), 'utf-8'),
    'export const agentsBuilt = true;\n',
  );
  assert.deepEqual(
    inspectSourceDevSharedDepsForSourceDev({
      repoRoot: root,
      workspaceNames: ['agents'],
    }),
    { current: true, reason: 'current' },
  );
});

test('ensureCliBuilt delegates workspace preparation only to the canonical source-dev owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-canonical-source-dev-preparation-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const pluginDir = join(root, 'packages', 'plugins', 'broken');
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(pluginDir, 'src'), { recursive: true });
  await mkdir(join(pluginDir, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({
    private: true,
    workspaces: ['apps/*', 'packages/plugins/*'],
  }, null, 2) + '\n');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/ui" }\n');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server" }\n');
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/plugins-broken': '0.0.0',
    },
    bundledDependencies: ['@happier-dev/plugins-broken'],
  }, null, 2) + '\n');
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n');
  await mkdir(join(cliDir, 'node_modules', '@happier-dev'), { recursive: true });
  await symlink(
    pluginDir,
    join(cliDir, 'node_modules', '@happier-dev', 'plugins-broken'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(cliDir, 'scripts', 'buildSharedDeps.mjs'),
    'export async function syncSharedDepsForSourceDev() { return { synced: false, reason: "last-green-plugin-output" }; }\n',
  );
  await writeFile(
    join(cliDir, 'scripts', 'syncSharedDepsForDev.mjs'),
    [
      "import { syncSharedDepsForSourceDev } from './buildSharedDeps.mjs';",
      'const result = await syncSharedDepsForSourceDev();',
      'process.stdout.write(`__HAPPIER_SOURCE_DEV_SYNC_RESULT__=${JSON.stringify(result)}\\n`);',
      '',
    ].join('\n'),
  );
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-broken',
    version: '0.0.0',
    type: 'module',
    main: './dist/index.js',
    exports: { '.': { default: './dist/index.js' } },
  }, null, 2) + '\n');
  await writeFile(join(pluginDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      declaration: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      target: 'ES2022',
    },
    include: ['src/**/*.ts'],
  }, null, 2) + '\n');
  await writeFile(join(pluginDir, 'dist', 'index.js'), 'export const lastGreen = true;\n');
  await writeFile(join(pluginDir, 'dist', 'index.d.ts'), 'export declare const lastGreen = true;\n');
  await writeFile(join(pluginDir, 'src', 'index.ts'), 'export const broken: string = 1;\n');
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  const changedTime = new Date('2030-01-01T00:00:00.000Z');
  await utimes(join(pluginDir, 'package.json'), oldTime, oldTime);
  await utimes(join(pluginDir, 'tsconfig.json'), oldTime, oldTime);
  await utimes(join(pluginDir, 'dist', 'index.js'), oldTime, oldTime);
  await utimes(join(pluginDir, 'dist', 'index.d.ts'), oldTime, oldTime);
  await utimes(join(pluginDir, 'src', 'index.ts'), changedTime, changedTime);

  const result = await ensureCliBuilt(cliDir, {
    buildCli: false,
    quiet: true,
    env: process.env,
  });

  assert.deepEqual(result, { built: false, reason: 'disabled' });
  assert.equal(
    await readFile(join(pluginDir, 'dist', 'index.js'), 'utf-8'),
    'export const lastGreen = true;\n',
  );
});

test('ensureCliBuilt defaults to no rebuild in service mode even when runtime inputs changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-service-skip-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  // Keep a real repository fixture while changing an observed runtime input.
  await runCapture('git', ['init'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.email', 'hstack-test@example.test'], { cwd: cliDir });
  await runCapture('git', ['config', 'user.name', 'hstack-test'], { cwd: cliDir });
  await runCapture('git', ['add', '.'], { cwd: cliDir });
  await runCapture('git', ['commit', '-m', 'init'], { cwd: cliDir });

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildCreatesDistStub({ binDir, outputPath, cliDir });

  // 1) Force an initial build so a build state is written.
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_SERVICE_MODE: null,
    HAPPIER_STACK_ENV_FILE: null,
  });
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const out1 = await readFile(outputPath, 'utf-8');
  assert.match(out1, /\bbuild\b/, `expected initial build, got:\n${out1}`);

  // 2) Dirty the worktree so git signature changes (auto mode would rebuild).
  await writeFile(join(cliDir, 'dirty.txt'), 'x\n', 'utf-8');
  await writeFile(outputPath, '', 'utf-8');
  applyEnvOverrides(t, {
    HAPPIER_STACK_CLI_BUILD_MODE: null,
    HAPPIER_STACK_SERVICE_MODE: '1',
  });
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  assert.ok(!out2.includes('build'), `expected no rebuild in service mode, got:\n${out2}`);
});
