import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
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

function runSetupJson({ rootDir, extraArgs = [], env }) {
  return runNode(
    [
      join(rootDir, 'bin', 'hstack.mjs'),
      'setup',
      '--json',
      '--profile=selfhost',
      '--server=happier-server-light',
      '--no-auth',
      '--no-tailscale',
      '--no-autostart',
      '--no-menubar',
      '--no-start-now',
      ...extraArgs,
    ],
    { cwd: rootDir, env }
  );
}

test('hstack setup --non-interactive forces interactive=false', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const env = { ...process.env, HAPPIER_STACK_TEST_TTY: '1' };
  const res = await runSetupJson({ rootDir, env, extraArgs: ['--non-interactive'] });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.interactive, false);
});

test('HAPPIER_STACK_NON_INTERACTIVE=1 forces interactive=false', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const env = { ...process.env, HAPPIER_STACK_TEST_TTY: '1', HAPPIER_STACK_NON_INTERACTIVE: '1' };
  const res = await runSetupJson({ rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.interactive, false);
});

test('--interactive does not override HAPPIER_STACK_NON_INTERACTIVE=1', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const env = { ...process.env, HAPPIER_STACK_TEST_TTY: '1', HAPPIER_STACK_NON_INTERACTIVE: '1' };
  const res = await runSetupJson({ rootDir, env, extraArgs: ['--interactive'] });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const data = JSON.parse(res.stdout);
  assert.equal(data.interactive, false);
});
