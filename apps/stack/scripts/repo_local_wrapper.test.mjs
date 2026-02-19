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

