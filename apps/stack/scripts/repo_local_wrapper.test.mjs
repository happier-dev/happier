import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
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
  assert.equal(data.env.HAPPIER_STACK_REPO_DIR, '');
  assert.equal(data.env.HAPPIER_STACK_STACK, '');
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
