import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { ensureCliBuilt, ensureDepsInstalled, pmExecBin } from './pm.mjs';

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

async function writeYarnBuildFailAfterDeletingDistStub({ binDir, outputPath }) {
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
      '  rm -rf dist',
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
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-}"',
      '  if [ -z "$out" ]; then',
      '    echo "missing HAPPIER_CLI_BUILD_OUTPUT_DIR" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      '  echo "export const built = true;" > "$out/index.mjs"',
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
      'if [ "${1:-}" = "build" ]; then',
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-}"',
      '  if [ -z "$out" ]; then',
      '    echo "missing HAPPIER_CLI_BUILD_OUTPUT_DIR" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      '  echo "export const built = true;" > "$out/index.mjs"',
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
      'if [ "${1:-}" = "build" ]; then',
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-}"',
      '  if [ -z "$out" ]; then',
      '    echo "missing HAPPIER_CLI_BUILD_OUTPUT_DIR" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      // Simulate a "successful" build that leaves a broken local import graph.
      // This should be treated as a build failure by ensureCliBuilt.
      '  echo "import \'./index-inner.mjs\';" > "$out/index.mjs"',
      '  echo "import \'./missing-chunk.mjs\';" > "$out/index-inner.mjs"',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
}

async function writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, cliDir, agentsDir }) {
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
      'if [ "${1:-}" = "-s" ] && [ "${2:-}" = "build" ]; then',
      `  out="\${HAPPIER_WORKSPACE_DIST_OUTPUT_DIR:-${join(agentsDir, 'dist')}}"`,
      '  mkdir -p "$out/session/state"',
      '  echo "export const state = true;" > "$out/session/state/index.js"',
      '  echo "export const agentsBuilt = true;" > "$out/index.js"',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = "build" ]; then',
      `  mkdir -p ${JSON.stringify(join(cliDir, 'dist'))}`,
      `  echo "export const cliBuilt = true;" > ${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
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
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-}"',
      '  if [ -z "$out" ]; then',
      '    echo "missing HAPPIER_CLI_BUILD_OUTPUT_DIR" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      '  echo "export const built = true;" > "$out/index.mjs"',
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
  const out = await readFile(outputPath, 'utf-8');
  assert.match(out, /\bworkspace @happier-dev\/server generate:providers\b/, `expected provider generation, got:\n${out}`);
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

test('ensureDepsInstalled skips monorepo refresh when node_modules is newer even without root yarn integrity', async (t) => {
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
  const out = await readFile(outputPath, 'utf-8');
  assert.doesNotMatch(out, /\binstall\b/, `expected no yarn install when node_modules is already newer, got:\n${out}`);
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
  await writeYarnBuildFailAfterDeletingDistStub({ binDir, outputPath });

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
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeFile(join(cliDir, '.gitignore'), 'dist/\npackage-dist/\ndist.staging.*\n', 'utf-8');
  await writeFile(join(cliDir, 'tracked.txt'), 'clean\n', 'utf-8');
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
      'if [ "${1:-}" = "build" ]; then',
      '  mkdir -p dist',
      '  value="$(tr -d \'\\n\' < tracked.txt)"',
      '  printf "export const tracked = \\"%s\\";\\n" "$value" > dist/index.mjs',
      '  printf "{\\"fingerprint\\":\\"1111111111111111\\",\\"builtAt\\":\\"2026-07-09T00:00:00.000Z\\",\\"fileCount\\":1,\\"toolVersion\\":\\"1\\"}\\n" > dist/.build-manifest.json',
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

  await writeFile(join(cliDir, 'tracked.txt'), 'dirty one\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });
  await writeFile(join(cliDir, 'tracked.txt'), 'dirty two\n', 'utf-8');
  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build');
  assert.equal(buildInvocations.length, 2);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const tracked = "dirty two";\n');
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
  assert.match(argv, /(^|\n)build(\n|$)/, `expected yarn build after repair, got:\n${argv}`);
  assert.match(await readFile(pkgrollCliPath, 'utf-8'), /pkgroll repaired/);
  assert.equal(await readFile(join(cliDir, 'dist', 'index.mjs'), 'utf-8'), 'export const built = true;\n');
});

test('ensureCliBuilt serializes concurrent rebuilds so dist is built once when the git signature still matches', async (t) => {
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

test('ensureCliBuilt rebuilds after waiting in always mode when worktree changed during the earlier build', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-pm-cli-build-lock-always-dirty-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliDir = join(root, 'apps', 'cli');
  await mkdir(cliDir, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{ "name": "cli-test" }\n', 'utf-8');
  await writeFile(join(cliDir, 'yarn.lock'), '# yarn\n', 'utf-8');
  await mkdir(join(cliDir, 'node_modules'), { recursive: true });
  await writeFile(join(cliDir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
  await writeFile(join(cliDir, 'tracked.txt'), 'initial\n', 'utf-8');

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
      '  out="${HAPPIER_CLI_BUILD_OUTPUT_DIR:-}"',
      '  if [ -z "$out" ]; then',
      '    echo "missing HAPPIER_CLI_BUILD_OUTPUT_DIR" >&2',
      '    exit 3',
      '  fi',
      '  mkdir -p "$out"',
      '  echo "export const built = true;" > "$out/index.mjs"',
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
  await writeFile(join(cliDir, 'tracked.txt'), 'changed during build\n', 'utf-8');

  await Promise.all([firstBuildPromise, secondBuildPromise]);

  const argv = await readFile(outputPath, 'utf-8');
  const buildInvocations = argv
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'build');
  assert.equal(buildInvocations.length, 2);
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

test('ensureCliBuilt restores existing dist and reports the build failure when a rebuild deletes dist', async (t) => {
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
  await writeYarnBuildFailAfterDeletingDistStub({ binDir, outputPath });

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

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /(^|\n)build(\n|$)/);
  assert.equal(await readFile(distIndex, 'utf-8'), 'export const stable = true;\n');
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
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({
    name: '@happier-dev/cli',
    private: true,
    dependencies: {
      '@happier-dev/agents': '0.0.0',
    },
  }, null, 2) + '\n', 'utf-8');
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
  await writeFile(join(agentsDir, 'src', 'index.ts'), 'export const source = true;\n', 'utf-8');
  await writeFile(
    join(agentsDir, 'dist', 'index.js'),
    'import "./session/state/index.js";\nexport const agentsCached = true;\n',
    'utf-8',
  );

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnBuildRefreshesAgentsAndPreservesCliDistStub({ binDir, outputPath, cliDir, agentsDir });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true, env: process.env });

  const argv = await readFile(outputPath, 'utf-8');
  assert.match(argv, /-s build/);
  assert.equal(await readFile(join(agentsDir, 'dist', 'session', 'state', 'index.js'), 'utf-8'), 'export const state = true;\n');
});

test('ensureCliBuilt defaults to no rebuild in service mode even when git signature changed', async (t) => {
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

  // Real git repo so computeGitWorktreeSignature() returns a signature.
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
