import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

test('repo-local wrapper dry-run prints hstack invocation with repo-local env', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
    {
      cwd: repoRoot,
      env: { ...process.env, HAPPIER_STACK_CLI_ROOT_DIR: '/some/other/install' },
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.cwd, repoRoot);
  assert.equal(data.cmd, process.execPath);
  assert.ok(Array.isArray(data.args), 'expected args array');
  assert.equal(
    data.args[0],
    join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs'),
    'expected wrapper to invoke repo-local hstack bin'
  );
  assert.equal(data.args[1], 'dev');

  assert.equal(data.env.HAPPIER_STACK_CLI_ROOT_DISABLE, '1');
  assert.equal(data.env.HAPPIER_STACK_REPO_DIR, repoRoot);
  assert.ok(String(data.env.HAPPIER_STACK_STACK ?? '').trim() !== '', 'expected stackless wrapper to scope to a non-main stack name');
  assert.ok(String(data.env.HAPPIER_STACK_ENV_FILE ?? '').trim() !== '', 'expected wrapper to set a stack env file path for stack-scoped commands');
  assert.ok(String(data.env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() !== '', 'expected wrapper to set a stack-scoped CLI home dir');
  assert.ok(String(data.env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() !== '', 'expected wrapper to set a stack-scoped active server id');
  assert.ok(String(data.env.HAPPIER_STACK_LOG_TEE_DIR ?? '').trim() !== '', 'expected wrapper to set a stack-scoped log tee dir');
  assert.ok(String(data.env.HAPPIER_STACK_INVOKED_CWD ?? '').trim() !== '');
});

test('repo-local wrapper defaults `tui` to `tui dev` when no forwarded args are provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], 'dev');
});

test('repo-local wrapper preserves explicit `tui` forwarded args', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', 'stack', 'dev', 'exp1', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], 'stack');
  assert.equal(data.args[3], 'dev');
  assert.equal(data.args[4], 'exp1');
});

test('repo-local wrapper preserves flag-only tui args', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'tui', '--json', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'tui');
  assert.equal(data.args[2], '--json');
});

test('repo-local wrapper forwards --help when a subcommand is provided', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'auth', '--help', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'auth');
  assert.equal(data.args[2], '--help');
});

test('repo-local wrapper maps `stop` to stack stop for the repo-local stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'stop', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'stack');
  assert.equal(data.args[2], 'stop');
  assert.ok(String(data.args[3] ?? '').trim() !== '');
});

test('repo-local wrapper maps `mobile:install` to stack mobile:install for the repo-local stack', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const res = await runNode(
    [join(packageRoot, 'scripts', 'repo_local.mjs'), 'mobile:install', '--dry-run'],
    {
      cwd: repoRoot,
      env: process.env,
    }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.args[1], 'stack');
  assert.equal(data.args[2], 'mobile:install');
  assert.ok(String(data.args[3] ?? '').trim().startsWith('repo-'), `expected repo-local stack name, got: ${data.args[3]}`);

  // Convenience: default name should be user-friendly (the repo-local stack name can be noisy).
  assert.ok(
    data.args.some((a) => String(a).startsWith('--name=')),
    `expected wrapper to set a default --name=... for mobile:install:\n${JSON.stringify(data.args, null, 2)}`
  );
});

test('repo-local wrapper auto-installs deps when node_modules are missing', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const preflightRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-preflight-'));
  try {
    writeFileSync(join(preflightRoot, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));

    const binDir = join(preflightRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const logPath = join(preflightRoot, 'yarn.log');
    const yarnBin = join(binDir, 'yarn');
    writeFileSync(
      yarnBin,
      [
        '#!/usr/bin/env node',
        "import { appendFileSync, mkdirSync } from 'node:fs';",
        "import { dirname, join } from 'node:path';",
        'const logPath = process.env.YARN_LOG;',
        "appendFileSync(logPath, process.argv.slice(2).join(' ') + '\\n');",
        "if (process.argv.includes('install')) {",
        "  const nodeModules = join(process.cwd(), 'node_modules');",
        "  mkdirSync(nodeModules, { recursive: true });",
        '}',
        'process.exit(0);',
      ].join('\n') + '\n',
    );
    chmodSync(yarnBin, 0o755);

    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          YARN_LOG: logPath,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT: preflightRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );

    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const log = readFileSync(logPath, 'utf-8');
    assert.match(log, /\binstall\b/);
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
  }
});

test('repo-local wrapper preserves user-defined env keys while managing stack-owned keys', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir); // apps/stack
  const repoRoot = dirname(dirname(packageRoot)); // repo root

  const stacksRoot = mkdtempSync(join(tmpdir(), 'happier-repo-local-stacks-'));
  try {
    // First: compute the repo-local stack env file path without mutating the real repo checkout.
    // (We use --dry-run so the wrapper doesn't create/update any local state.)
    const dry = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'dev', '--dry-run'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
        },
      }
    );
    assert.equal(dry.code, 0, `expected exit 0, got ${dry.code}\nstdout:\n${dry.stdout}\nstderr:\n${dry.stderr}`);
    const dryData = JSON.parse(dry.stdout);
    const envPath = String(dryData?.env?.HAPPIER_STACK_ENV_FILE ?? '').trim();
    assert.ok(envPath, 'expected dry-run to include HAPPIER_STACK_ENV_FILE');

    // Seed env file with a user-defined key and pinned ports.
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(
      envPath,
      ['CUSTOM_KEY=1', 'HAPPIER_STACK_SERVER_PORT=9999', 'HAPPIER_STACK_EXPO_DEV_PORT=19999', ''].join('\n')
    );

    // Next: run a command that exercises the wrapper's env-file sync logic but does not spawn hstack.
    const res = await runNode(
      [join(packageRoot, 'scripts', 'repo_local.mjs'), 'stop'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HAPPIER_STACK_STORAGE_DIR: stacksRoot,
          HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY: '1',
        },
      }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const updated = readFileSync(envPath, 'utf-8');
    assert.match(updated, /\bCUSTOM_KEY=1\b/, `expected user key to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_SERVER_PORT=9999\b/, `expected pinned port to be preserved:\n${updated}`);
    assert.match(updated, /\bHAPPIER_STACK_EXPO_DEV_PORT=19999\b/, `expected pinned expo port to be preserved:\n${updated}`);
  } finally {
    rmSync(stacksRoot, { recursive: true, force: true });
  }
});
