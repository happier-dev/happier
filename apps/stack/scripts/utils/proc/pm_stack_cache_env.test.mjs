import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ensureCliBuilt, ensureDepsInstalled, pmExecBin } from './pm.mjs';
import { withCliDistBuildLock } from './cliDistBuildLock.mjs';

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

async function writeYarnArgDumpStub({ binDir, outputPath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "$*" >> "${OUTPUT_PATH:?}"',
      'if [[ "${1:-}" == "install" && -n "${YARN_INSTALL_DELAY_SECONDS:-}" ]]; then sleep "$YARN_INSTALL_DELAY_SECONDS"; fi',
      'if [[ "${1:-}" == "install" && "${YARN_INSTALL_FAIL:-}" == "1" ]]; then exit 23; fi',
      'if [[ "${1:-}" == "install" ]]; then mkdir -p node_modules; fi',
    ].join('\n') + '\n',
    'utf-8'
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

async function writeYarnBuildFailsBeforePromotionStub({ binDir, outputPath }) {
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
      'if [ "${1:-}" = "build" ]; then',
      '  rm -rf dist.cli-owner-staging',
      '  echo "simulated build failure" >&2',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
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
      'if [ "${1:-}" = "build" ]; then',
      '  out_dir="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist}"',
      '  mkdir -p "$out_dir"',
      '  echo "export const built = true;" > "$out_dir/index.mjs"',
      '  printf \'{"fingerprint":"0123456789abcdef","fileCount":1}\\n\' > "$out_dir/.build-manifest.json"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildAtomicallyPromotesDistStub({ binDir, outputPath }) {
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
      'if [ "${1:-}" = "build" ]; then',
      '  stage="dist.cli-owner-staging"',
      '  backup="dist.cli-owner-backup"',
      '  rm -rf "$stage" "$backup"',
      '  mkdir -p "$stage"',
      '  echo "export const built = true;" > "$stage/index.mjs"',
      '  printf \'{"fingerprint":"0123456789abcdef","fileCount":1}\\n\' > "$stage/.build-manifest.json"',
      '  if [ -d dist ]; then mv dist "$backup"; fi',
      '  mv "$stage" dist',
      '  rm -rf "$backup"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildUsesCliLockProtocolStub({ binDir, outputPath, cliLockModulePath }) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const { pathToFileURL } = require('node:url');",
      "writeFileSync(process.env.OUTPUT_PATH, process.argv.slice(2).join(' ') + '\\n', { flag: 'a' });",
      "if (process.argv[2] === '--version') { console.log('1.22.22'); process.exit(0); }",
      "if (process.argv[2] !== 'build') process.exit(0);",
      '(async () => {',
      `  const lockModule = await import(pathToFileURL(${JSON.stringify(cliLockModulePath)}).href);`,
      '  await lockModule.withOptionalCliSharedDepsBuildLock(async () => {',
      "    const stage = join(process.cwd(), 'dist.cli-owner-staging');",
      "    const dist = join(process.cwd(), 'dist');",
      "    const backup = join(process.cwd(), 'dist.cli-owner-backup');",
      '    rmSync(stage, { recursive: true, force: true });',
      '    rmSync(backup, { recursive: true, force: true });',
      '    mkdirSync(stage, { recursive: true });',
      "    writeFileSync(join(stage, 'index.mjs'), 'export const built = true;\\n');",
      "    writeFileSync(join(stage, '.build-manifest.json'), '{\"fingerprint\":\"0123456789abcdef\",\"fileCount\":1}\\n');",
      '    if (existsSync(dist)) renameSync(dist, backup);',
      '    renameSync(stage, dist);',
      '    rmSync(backup, { recursive: true, force: true });',
      '  }, {',
      '    startDir: process.cwd(),',
      '    env: process.env,',
      '    lockTimeoutMs: 75,',
      '    lockPollIntervalMs: 10,',
      '    lockStaleAfterMs: 1_000,',
      '  });',
      '})().catch((error) => { console.error(error); process.exit(1); });',
    ].join('\n') + '\n',
    'utf-8',
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
      'if [ "${1:-}" = "build" ]; then',
      '  stage="dist.cli-owner-staging"',
      '  rm -rf "$stage"',
      '  mkdir -p "$stage"',
      '  echo "import \'./index-inner.mjs\';" > "$stage/index.mjs"',
      '  echo "import \'./missing-chunk.mjs\';" > "$stage/index-inner.mjs"',
      '  echo "incomplete dist import closure" >&2',
      '  exit 2',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, cliDir }) {
  await mkdir(binDir, { recursive: true });
  const stubPath = join(binDir, 'yarn-stub.cjs');
  await writeFile(
    stubPath,
    [
      "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      'const args = process.argv.slice(2);',
      "appendFileSync(process.env.OUTPUT_PATH, args.join(' ') + '\\n');",
      "if (args[0] === '--version') { console.log('1.22.22'); process.exit(0); }",
      "if (args[0] === '-s' && args[1] === 'build') {",
      "  const out = process.env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR || 'dist';",
      "  mkdirSync(join(out, 'session', 'state'), { recursive: true });",
      "  writeFileSync(join(out, 'session', 'state', 'index.js'), 'export const state = true;\\n');",
      "  writeFileSync(join(out, 'index.js'), 'export const agentsBuilt = true;\\n');",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'build') {",
      "  const out = process.env.HAPPIER_CLI_BUILD_OUTPUT_DIR || 'dist';",
      '  mkdirSync(out, { recursive: true });',
      "  writeFileSync(join(out, 'index.mjs'), 'export const cliBuilt = true;\\n');",
      "  writeFileSync(join(out, '.build-manifest.json'), '{\"fingerprint\":\"0123456789abcdef\",\"fileCount\":1}\\n');",
      '}',
    ].join('\n') + '\n',
    'utf-8',
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
      '  echo "1.22.22"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build" ]; then',
      '  sleep 1',
      '  stage="dist.cli-owner-staging"',
      '  backup="dist.cli-owner-backup"',
      '  rm -rf "$stage" "$backup"',
      '  mkdir -p "$stage"',
      '  echo "export const built = true;" > "$stage/index.mjs"',
      '  printf \'{"fingerprint":"0123456789abcdef","fileCount":1}\\n\' > "$stage/.build-manifest.json"',
      '  echo "$stage" > "${OUTPUT_PATH}.outdir"',
      '  if [ -n "${BUILD_SIGNAL_PATH:-}" ]; then echo started > "${BUILD_SIGNAL_PATH}"; fi',
      '  sleep 1',
      '  if [ -d dist ]; then mv dist "$backup"; fi',
      '  mv "$stage" dist',
      '  rm -rf "$backup"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildCreatesEsmLinkFailureStub({ binDir, outputPath }) {
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
      'if [ "${1:-}" = "build" ]; then',
      '  stage="dist.cli-owner-staging"',
      '  rm -rf "$stage"',
      '  mkdir -p "$stage"',
      '  echo "import { A } from \'./chunk.mjs\'; export const value = A;" > "$stage/index.mjs"',
      '  echo "export const B = true;" > "$stage/chunk.mjs"',
      '  echo "SyntaxError: ./chunk.mjs does not provide an export named A" >&2',
      '  exit 2',
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

function applyEnvOverrides(t, vars) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(vars)) {
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

test('ensureDepsInstalled derives stack cache roots from ~/ env file overrides against HOME', async (t) => {
  const fixture = await createStackCacheFixture(t, 'hs-pm-tilde-stack-env-file-');
  const { root, componentDir, binDir } = fixture;
  const outputPath = join(root, 'env.json');
  const homeDir = join(root, 'home');
  const expectedCacheBase = join(homeDir, '.happier', 'stacks', 'dev', 'cache');
  const expectedStackHome = join(homeDir, '.happier', 'stacks', 'dev', 'home');
  await writeYarnEnvDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HOME: homeDir,
    USERPROFILE: homeDir,
    HAPPIER_STACK_ENV_FILE: '~/.happier/stacks/dev/env',
    XDG_CACHE_HOME: null,
    YARN_CACHE_FOLDER: null,
    npm_config_cache: null,
  });

  await ensureDepsInstalled(componentDir, 'test-component', { quiet: true });
  const parsed = JSON.parse(await readFile(outputPath, 'utf-8'));
  assert.equal(parsed.XDG_CACHE_HOME, join(expectedCacheBase, 'xdg'));
  assert.equal(parsed.YARN_CACHE_FOLDER, join(expectedCacheBase, 'yarn'));
  assert.equal(parsed.npm_config_cache, join(expectedCacheBase, 'npm'));
  assert.equal(parsed.HOME, expectedStackHome);
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
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'happier-server', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  assert.ok(out.includes('install') || out.includes('--version'));
});

test('ensureDepsInstalled forces non-production yarn installs', async (t) => {
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
});

test('ensureDepsInstalled regenerates server Prisma provider outputs when sqlite generated clients are missing', async (t) => {
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
  await writeFile(join(root, 'node_modules', '.prisma', 'client', 'default.js'), 'module.exports = {};\n', 'utf-8');
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

  await ensureDepsInstalled(componentDir, 'happier-server-light', { quiet: true });
  await ensureDepsInstalled(componentDir, 'happier-server-light', { quiet: true });
  const out = await readFile(outputPath, 'utf-8');
  const providerGenerations = out
    .split('\n')
    .filter((line) => /\bworkspace @happier-dev\/server generate:providers\b/.test(line));
  assert.equal(providerGenerations.length, 2, `expected each component preflight to preserve provider generation, got:\n${out}`);
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

test('ensureDepsInstalled does not repeat a successful no-op refresh while dependency inputs stay unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-refresh-once-'));
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
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await Promise.all([
    utimes(join(root, 'package.json'), older, older),
    utimes(join(root, 'yarn.lock'), older, older),
    utimes(join(root, 'apps', 'ui', 'package.json'), newer, newer),
    utimes(join(root, 'apps', 'cli', 'package.json'), older, older),
    utimes(join(root, 'apps', 'server', 'package.json'), older, older),
    utimes(join(root, 'node_modules', '.yarn-integrity'), older, older),
  ]);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    YARN_INSTALL_DELAY_SECONDS: '0.2',
    YARN_INSTALL_FAIL: null,
    HAPPIER_STACK_ENV_FILE: null,
  });

  await Promise.all([
    ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true }),
    ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true }),
  ]);
  await ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true });

  const unchangedOut = await readFile(outputPath, 'utf-8');
  const unchangedInstalls = unchangedOut.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(unchangedInstalls.length, 1, `expected one successful refresh for unchanged inputs, got:\n${unchangedOut}`);

  const changed = new Date(Date.now() + 10_000);
  await utimes(join(root, 'apps', 'server', 'package.json'), changed, changed);
  await ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true });

  const changedOut = await readFile(outputPath, 'utf-8');
  const changedInstalls = changedOut.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(changedInstalls.length, 2, `expected a later dependency input change to refresh again, got:\n${changedOut}`);

  const changedAgain = new Date(Date.now() + 20_000);
  await utimes(join(root, 'apps', 'server', 'package.json'), changedAgain, changedAgain);
  process.env.YARN_INSTALL_FAIL = '1';
  await assert.rejects(
    ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true }),
  );
  delete process.env.YARN_INSTALL_FAIL;
  await ensureDepsInstalled(join(root, 'apps', 'server'), 'happier-server-light', { quiet: true });

  const retryOut = await readFile(outputPath, 'utf-8');
  const retryInstalls = retryOut.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(retryInstalls.length, 4, `expected a failed refresh to remain stale and retry, got:\n${retryOut}`);
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
  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env: process.env });

  // A warm admission must not need either mutation-lock path. Replacing both lock parents with
  // ordinary files makes an accidental lock acquisition fail deterministically instead of wait.
  await rm(join(stackHome, 'cache', 'dependencies'), { recursive: true, force: true });
  await mkdir(join(stackHome, 'cache'), { recursive: true });
  await writeFile(join(stackHome, 'cache', 'dependencies'), 'read-only-fast-path\n', 'utf-8');
  await rm(join(root, '.project'), { recursive: true, force: true });
  await writeFile(join(root, '.project'), 'read-only-fast-path\n', 'utf-8');

  await ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env: process.env });
  const installs = (await readFile(outputPath, 'utf-8')).split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(installs.length, 1);
});

test('ensureDepsInstalled waits for the monorepo CLI bundle lock before deciding whether to refresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-monorepo-cli-lock-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

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
      workspaces: { packages: ['apps/ui', 'apps/cli', 'apps/server'] },
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
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    LOCK_OUTPUT_PATH: heldLockOutputPath,
    HAPPIER_STACK_ENV_FILE: '',
  };

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
    { lockPath: cliLockPath, timeoutMs: 5_000, pollIntervalMs: 10, staleAfterMs: 5_000 },
  );
  await cliLockHeld;

  const firstEnsure = ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });
  await waitForFileText(dependencyLockPath, /"pid"/);
  const secondEnsure = ensureDepsInstalled(componentDir, 'happier-ui', { quiet: true, env });

  try {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await readFile(outputPath, 'utf-8'), '', 'yarn install started while the CLI bundle lock was held');
  } finally {
    releaseCliLock();
  }

  await Promise.all([holder, firstEnsure, secondEnsure]);
  const installLines = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .filter((line) => /^install\b/.test(line));
  assert.equal(installLines.length, 1, `expected freshness to collapse queued work to one install, got:\n${installLines.join('\n')}`);
  const heldLockLease = JSON.parse((await readFile(heldLockOutputPath, 'utf-8')).trim());
  assert.equal(heldLockLease.path, cliLockPath);
  assert.equal(typeof heldLockLease.token, 'string');
  assert.notEqual(heldLockLease.token, '');
  await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
  await assert.rejects(() => stat(dependencyLockPath), { code: 'ENOENT' });
});

test('ensureDepsInstalled serializes the initial Yarn install and records it through the canonical refresh owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-initial-once-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const componentDir = join(root, 'component');
  await mkdir(componentDir, { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    YARN_INSTALL_DELAY_SECONDS: '0.2',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  await Promise.all([
    ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env }),
    ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env }),
  ]);
  await ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const installs = out.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(installs.length, 1, `expected one serialized initial install, got:\n${out}`);
});

test('ensureDepsInstalled performs one marker bootstrap refresh for a legacy Yarn install, then skips warm calls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-happy-monorepo-marker-bootstrap-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const componentDir = join(root, 'component');
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(componentDir, 'node_modules', '.yarn-integrity'), 'legacy\n', 'utf-8');
  const base = Date.now();
  const older = new Date(base - 10_000);
  const newer = new Date(base);
  await utimes(join(componentDir, 'package.json'), older, older);
  await utimes(join(componentDir, 'yarn.lock'), older, older);
  await utimes(join(componentDir, 'node_modules', '.yarn-integrity'), newer, newer);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env });
  await ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const installs = out.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(installs.length, 1, `expected one marker-bootstrap refresh followed by a warm skip, got:\n${out}`);
});

test('ensureDepsInstalled bootstraps the canonical marker when a legacy Yarn install has no lockfile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-yarn-missing-lock-marker-bootstrap-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const componentDir = join(root, 'component');
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(componentDir, 'node_modules', '.yarn-integrity'), 'legacy\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env });
  await ensureDepsInstalled(componentDir, 'component', { quiet: true, env: process.env });

  const out = await readFile(outputPath, 'utf-8');
  const installs = out.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(installs.length, 1, `expected one missing-lock marker bootstrap and then a warm skip, got:\n${out}`);
});

test('ensureDepsInstalled bootstraps one canonical snapshot when legacy node_modules has no Yarn integrity', async (t) => {
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
  const out = await readFile(outputPath, 'utf-8');
  const installs = out.split('\n').filter((line) => /\binstall\b/.test(line));
  assert.equal(installs.length, 1, `expected one canonical marker bootstrap and then a warm skip, got:\n${out}`);
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

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
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
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeCorepackYarnArgDumpStub({ binDir, outputPath });

  await ensureDepsInstalled(componentDir, 'corepack-component', {
    quiet: true,
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      OUTPUT_PATH: outputPath,
      HAPPIER_STACK_BINARY_MODE: '0',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    },
  });

  assert.equal(await readFile(outputPath, 'utf-8'), 'yarn --version\n');
});

test('ensureDepsInstalled preserves a Windows-style Path key while preparing Corepack Yarn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-corepack-windows-path-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'component');
  await mkdir(join(componentDir, 'node_modules'), { recursive: true });
  await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeCorepackYarnArgDumpStub({ binDir, outputPath });

  const env = {
    ...process.env,
    Path: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_BINARY_MODE: '0',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  };
  delete env.PATH;

  await ensureDepsInstalled(componentDir, 'corepack-component', { quiet: true, env });
  assert.equal(await readFile(outputPath, 'utf-8'), 'yarn --version\n');
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

test('ensureCliBuilt delegates atomic dist promotion to the CLI build owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-owner-promotion-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildAtomicallyPromotesDistStub({ binDir, outputPath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  assert.equal(
    await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'),
    'export const built = true;\n',
  );
});

test('ensureCliBuilt declares its held lock so the CLI build owner cannot self-wait', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-lock-protocol-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const cliDir = join(root, 'apps', 'cli');
  for (const app of ['cli', 'ui', 'server']) {
    const appDir = join(root, 'apps', app);
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, 'package.json'), `{ "name": "${app}-test" }\n`, 'utf-8');
  }
  await writeFile(join(root, 'package.json'), '{ "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# root yarn\n', 'utf-8');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  const cliLockModulePath = fileURLToPath(
    new URL('../../../../cli/scripts/optionalWorkspaceBundleLock.mjs', import.meta.url),
  );
  await writeYarnBuildUsesCliLockProtocolStub({ binDir, outputPath, cliLockModulePath });
  applyEnvOverrides(t, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt restores previous dist output when build fails', async (t) => {
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
  await writeYarnBuildFailsBeforePromotionStub({ binDir, outputPath });

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

test('ensureCliBuilt restores previous dist output when build produces a broken dist import graph', async (t) => {
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

  await assert.rejects(() => ensureCliBuilt(cliDir, { buildCli: true, quiet: true }));
  const restored = await readFile(distIndex, 'utf-8');
  assert.equal(restored, 'export const stable = true;\n');
});

test('ensureCliBuilt keeps the previous dist readable while a staged build is in progress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-live-dist-'));
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
  const buildSignalPath = join(root, 'build-started.txt');
  await writeYarnSlowBuildCreatesDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    BUILD_SIGNAL_PATH: buildSignalPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  const buildPromise = ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await waitForFileText(buildSignalPath, /started/);

  assert.equal(await readFile(distIndex, 'utf-8'), 'export const stable = true;\n');

  await buildPromise;
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const built = true;\n');

  const stagedOutDir = (await readFile(`${outputPath}.outdir`, 'utf-8')).trim();
  assert.notEqual(stagedOutDir, 'dist');
  await assert.rejects(() => stat(join(cliDir, '.dist.hstack-backup')));
});

test('ensureCliBuilt rejects staged ESM link failures before promoting over the previous dist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-esm-link-'));
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
  await writeYarnBuildCreatesEsmLinkFailureStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await assert.rejects(
    () => ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env }),
  );

  assert.equal(
    await readFile(distIndex, 'utf-8'),
    'export const stable = true;\n',
  );
  await assert.rejects(() => stat(join(cliDir, '.dist.hstack-backup')));
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
  await writeYarnSlowBuildCreatesDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  await Promise.all([
    ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env }),
    ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env }),
  ]);

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build');
  assert.equal(buildInvocations.length, 1);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt consumes one concurrent atomic build when runtime inputs change during it', async (t) => {
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
      'if [ "${1:-}" = "build" ]; then',
      '  sleep 1',
      '  out_dir="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist}"',
      '  mkdir -p "$out_dir"',
      '  echo "export const built = true;" > "$out_dir/index.mjs"',
      '  printf \'{"fingerprint":"0123456789abcdef","fileCount":1}\\n\' > "$out_dir/.build-manifest.json"',
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
    HAPPIER_STACK_CLI_BUILD_MODE: 'always',
    HAPPIER_STACK_HOME_DIR: join(root, 'home'),
    HAPPIER_STACK_ENV_FILE: null,
  });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  await mkdir(dirname(distIndex), { recursive: true });
  await writeFile(distIndex, 'export const stable = true;\n', 'utf-8');

  const firstBuildPromise = ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await waitForFileText(outputPath, /(^|\n)build(\n|$)/);
  const secondBuildPromise = ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'src', 'tracked.txt'), 'changed during build\n', 'utf-8');

  const [firstBuild, secondBuild] = await Promise.all([firstBuildPromise, secondBuildPromise]);

  assert.deepEqual(firstBuild, { built: true, current: false, reason: 'inputs_changed_during_build' });
  assert.equal(secondBuild.built, false);
  assert.match(secondBuild.reason, /^concurrent_build_(?:already_completed|superseded)$/);
  assert.equal(secondBuild.current, secondBuild.reason === 'concurrent_build_already_completed');

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build');
  assert.equal(buildInvocations.length, 1);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt ignores stale legacy .dist.hstack-backup and rebuilds through staged output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-interrupted-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  // Legacy interrupted builds could leave this backup directory behind. The atomic builder must
  // not restore it as a second recovery path.
  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const backupIndex = join(distBackupDir, 'index.mjs');
  await mkdir(dirname(backupIndex), { recursive: true });
  await writeFile(backupIndex, 'export const stable = true;\n', 'utf-8');

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
  const rebuilt = await readFile(distIndex, 'utf-8');
  assert.equal(rebuilt, 'export const built = true;\n');
  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)build(\n|$)/);
  await assert.rejects(() => stat(distBackupDir));
});

test('ensureCliBuilt rebuilds only for CLI runtime and build inputs in a nested monorepo package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-dirty-content-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const cliSrcDir = join(cliDir, 'src');
  const cliScriptsDir = join(cliDir, 'scripts');
  const uiSrcDir = join(root, 'apps', 'ui', 'src');
  const workspaceScriptsDir = join(root, 'scripts', 'workspaces');
  await mkdir(cliSrcDir, { recursive: true });
  await mkdir(cliScriptsDir, { recursive: true });
  await mkdir(uiSrcDir, { recursive: true });
  await mkdir(workspaceScriptsDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, '.gitignore'), 'dist/\n', 'utf-8');
  await writeFile(join(cliSrcDir, 'tracked.txt'), 'clean\n', 'utf-8');
  await writeFile(join(cliScriptsDir, 'build-helper.mjs'), 'export const version = 1;\n', 'utf-8');
  await writeFile(join(uiSrcDir, 'unrelated.txt'), 'clean\n', 'utf-8');
  await writeFile(join(workspaceScriptsDir, 'compiler-helper.mjs'), 'export const version = 1;\n', 'utf-8');
  await writeFile(join(root, '.gitignore'), '/.project/\n/bin/\n/home/\n/argv.txt\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');

  await runCapture('git', ['init'], { cwd: root });
  await runCapture('git', ['config', 'user.email', 'hstack-test@example.test'], { cwd: root });
  await runCapture('git', ['config', 'user.name', 'hstack-test'], { cwd: root });
  await runCapture('git', ['add', '.'], { cwd: root });
  await runCapture('git', ['commit', '-m', 'init'], { cwd: root });

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
      'if [ "${1:-}" = "build" ]; then',
      '  out_dir="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-dist}"',
      '  mkdir -p "$out_dir"',
      '  value="$(tr -d \'\\n\' < src/tracked.txt)"',
      '  printf "export const tracked = \\"%s\\";\\n" "$value" > "$out_dir/index.mjs"',
      '  printf \'{"fingerprint":"0123456789abcdef","fileCount":1}\\n\' > "$out_dir/.build-manifest.json"',
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

  await writeFile(join(cliSrcDir, 'tracked.txt'), 'dirty one\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(uiSrcDir, 'unrelated.txt'), 'dirty but unrelated\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const assertTestOnlyInputDoesNotRebuild = async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'export const testOnly = 1;\n', 'utf-8');
    await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
    const buildsBeforeContentEdit = (await readFile(outputPath, 'utf-8'))
      .split('\n')
      .filter((line) => line.trim() === 'build').length;
    await writeFile(path, 'export const testOnly = 2;\n', 'utf-8');
    await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
    const buildsAfterContentEdit = (await readFile(outputPath, 'utf-8'))
      .split('\n')
      .filter((line) => line.trim() === 'build').length;
    assert.equal(buildsAfterContentEdit, buildsBeforeContentEdit, `${path} content edit must stay ignored`);
    await rm(path, { force: true });
    await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  };
  await assertTestOnlyInputDoesNotRebuild(join(cliSrcDir, 'testkit', 'nested', 'runtimeFixture.ts'));
  await assertTestOnlyInputDoesNotRebuild(join(cliSrcDir, 'runtimeFixture.testkit.ts'));
  await assertTestOnlyInputDoesNotRebuild(join(cliSrcDir, 'vitestSetup.ts'));
  await writeFile(join(cliScriptsDir, 'build-helper.mjs'), 'export const version = 2;\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(workspaceScriptsDir, 'compiler-helper.mjs'), 'export const version = 2;\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliSrcDir, 'tracked.txt'), 'dirty two\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliSrcDir, 'untracked.txt'), 'untracked one\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliSrcDir, 'untracked.txt'), 'untracked two\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await rm(join(cliSrcDir, 'untracked.txt'));
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await rm(join(cliDir, 'dist', '.build-manifest.json'));
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'dist', 'index.mjs'), "import './missing-after-build.mjs';\n", 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build');
  assert.equal(buildInvocations.length, 14);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const tracked = "dirty two";\n');
  await assert.rejects(
    () => stat(join(root, 'home', 'cache', 'build', 'happier-cli')),
    { code: 'ENOENT' },
    'CLI freshness must not create a persistent source-signature cache',
  );
});

test('ensureCliBuilt refreshes shared workspace deps before trusting a cached cli dist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-refresh-shared-deps-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const agentsDir = join(root, 'packages', 'agents');
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await mkdir(join(agentsDir, 'src'), { recursive: true });
  await mkdir(join(agentsDir, 'dist', 'session', 'state'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "name": "repo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/ui", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server", "private": true }\n', 'utf-8');
  await writeFile(
    join(cliDir, 'package.json'),
    JSON.stringify(
      {
        name: '@happier-dev/cli',
        private: true,
        dependencies: {
          '@happier-dev/agents': '0.0.0',
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const cached = true;\n', 'utf-8');
  await writeFile(join(cliDir, 'dist', '.build-manifest.json'), '{"fingerprint":"0123456789abcdef","fileCount":1}\n', 'utf-8');

  await writeFile(
    join(agentsDir, 'package.json'),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export const source = true;\n', 'utf-8');
  await writeFile(
    join(agentsDir, 'dist', 'index.js'),
    'import "./session/state/index.js";\nexport const agentsCached = true;\n',
    'utf-8',
  );

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'never',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /-s build/);
  assert.equal(await readFile(join(agentsDir, 'dist', 'session', 'state', 'index.js'), 'utf-8'), 'export const state = true;\n');
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const cached = true;\n');
});

test('ensureCliBuilt rebuilds an auto-mode cli dist after repairing a stale workspace dependency', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-auto-refresh-shared-deps-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  const agentsDir = join(root, 'packages', 'agents');
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await mkdir(join(agentsDir, 'src'), { recursive: true });
  await mkdir(join(agentsDir, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "name": "repo", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(root, 'apps', 'ui', 'package.json'), '{ "name": "@happier-dev/ui", "private": true }\n', 'utf-8');
  await writeFile(join(root, 'apps', 'server', 'package.json'), '{ "name": "@happier-dev/server", "private": true }\n', 'utf-8');
  await writeFile(
    join(cliDir, 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli',
      private: true,
      dependencies: {
        '@happier-dev/agents': '0.0.0',
      },
    }, null, 2) + '\n',
    'utf-8',
  );
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'dist', 'index.mjs'), 'export const cached = true;\n', 'utf-8');
  const cliManifestPath = join(cliDir, 'dist', '.build-manifest.json');
  await writeFile(cliManifestPath, '{"fingerprint":"0123456789abcdef","fileCount":1}\n', 'utf-8');

  await writeFile(
    join(agentsDir, 'package.json'),
    JSON.stringify({
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
    }, null, 2) + '\n',
    'utf-8',
  );
  const agentsSourcePath = join(agentsDir, 'src', 'index.ts');
  await writeFile(agentsSourcePath, 'export const source = "changed";\n', 'utf-8');
  await writeFile(join(agentsDir, 'dist', 'index.js'), 'export const agentsCached = true;\n', 'utf-8');

  const staleDependencyTime = new Date(Date.now() - 20_000);
  const changedSourceTime = new Date(Date.now() - 10_000);
  const publishedCliTime = new Date(Date.now() + 10_000);
  await utimes(join(agentsDir, 'dist'), staleDependencyTime, staleDependencyTime);
  await utimes(agentsSourcePath, changedSourceTime, changedSourceTime);
  await utimes(cliManifestPath, publishedCliTime, publishedCliTime);

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, cliDir });

  applyEnvOverrides(t, {
    PATH: [binDir, process.env.PATH].filter(Boolean).join(delimiter),
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_ENV_FILE: null,
  });

  const result = await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  assert.deepEqual(result, { built: true, current: true, reason: 'changed' });
  const invocations = (await readFile(outputPath, 'utf-8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(invocations.indexOf('-s build') >= 0, 'the stale agents dist must be repaired');
  assert.ok(
    invocations.indexOf('build') > invocations.indexOf('-s build'),
    'the CLI must rebuild after its workspace dependency is repaired',
  );
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const cliBuilt = true;\n');
});

test('ensureCliBuilt defaults to no rebuild in service mode even when runtime inputs changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-service-skip-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
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

  // 1) Force an initial build so a usable dist exists.
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

  // 2) Change a runtime input (auto mode would rebuild).
  await writeFile(join(cliDir, 'src', 'dirty.ts'), 'export {};\n', 'utf-8');
  await writeFile(outputPath, '', 'utf-8');
  applyEnvOverrides(t, {
    HAPPIER_STACK_CLI_BUILD_MODE: null,
    HAPPIER_STACK_SERVICE_MODE: '1',
  });
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  const out2 = await readFile(outputPath, 'utf-8');
  assert.ok(!out2.includes('build'), `expected no rebuild in service mode, got:\n${out2}`);
});
