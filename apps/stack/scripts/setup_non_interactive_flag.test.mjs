import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';

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
