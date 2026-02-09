import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from './testkit/stack_script_command_testkit.mjs';

test('hstack service --help documents systemd mode flag', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const res = await runNode([join(rootDir, 'scripts', 'service.mjs'), '--help'], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /--mode=system\|user/);
});

test('hstack service --help tolerates invalid mode values', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const res = await runNode([join(rootDir, 'scripts', 'service.mjs'), '--help', '--mode=not-a-mode'], {
    cwd: rootDir,
    env: process.env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.match(res.stdout, /hstack service/);
  assert.match(res.stdout, /--mode=system\|user/);
});
