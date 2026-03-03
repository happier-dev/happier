import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';

function resolveRootDir() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  return dirname(scriptsDir);
}

test('hstack setup prints a deprecation warning (non-JSON)', async () => {
  const rootDir = resolveRootDir();
  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'setup', '--help'], { cwd: rootDir });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, /deprecated/i);
  assert.match(res.stderr, /setup-from-source/);
});

test('hstack setup-from-source does not print the deprecation warning', async () => {
  const rootDir = resolveRootDir();
  const res = await runNode([join(rootDir, 'bin', 'hstack.mjs'), 'setup-from-source', '--help'], { cwd: rootDir });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /deprecated/i);
});

test('hstack setup does not print the warning in --json mode', async () => {
  const rootDir = resolveRootDir();
  const res = await runNode(
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
    ],
    { cwd: rootDir, env: { ...process.env, HAPPIER_STACK_TEST_TTY: '0' } }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.doesNotMatch(res.stderr, /deprecated/i);
});

