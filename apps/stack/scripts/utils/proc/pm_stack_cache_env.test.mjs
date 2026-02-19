import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

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
      `  mkdir -p ${JSON.stringify(join(cliDir, 'dist'))}`,
      `  echo "export const built = true;" > ${JSON.stringify(join(cliDir, 'dist', 'index.mjs'))}`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  await writeFile(outputPath, '', 'utf-8');
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

test('ensureCliBuilt restores dist from .dist.hstack-backup when previous build was interrupted', async (t) => {
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

  // Simulate: dist/ was moved out of the way to .dist.hstack-backup/, then the build process
  // was killed before it restored dist/. Next run should recover without invoking `yarn build`.
  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const backupIndex = join(distBackupDir, 'index.mjs');
  await mkdir(dirname(backupIndex), { recursive: true });
  await writeFile(backupIndex, 'export const stable = true;\n', 'utf-8');

  const binDir = join(root, 'bin');
  const outputPath = join(root, 'argv.txt');
  await writeYarnArgDumpStub({ binDir, outputPath });

  applyEnvOverrides(t, {
    PATH: `${binDir}:/usr/bin:/bin`,
    OUTPUT_PATH: outputPath,
    HAPPIER_STACK_CLI_BUILD_MODE: 'auto',
    HAPPIER_STACK_ENV_FILE: null,
  });

  await ensureCliBuilt(cliDir, { buildCli: true, quiet: true });

  const distIndex = join(cliDir, 'dist', 'index.mjs');
  const recovered = await readFile(distIndex, 'utf-8');
  assert.equal(recovered, 'export const stable = true;\n');
  const argv = await readFile(outputPath, 'utf-8');
  assert.ok(!argv.includes('build'), `expected no build invocation, got: ${argv}`);
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
