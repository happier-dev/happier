import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hstackBinPath, runNodeCapture } from './auth.testHelper.mjs';

test('hstack auth --help surfaces dev-auth seed stack command', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const env = {
    ...process.env,
    // Prevent env.mjs from auto-loading a real machine stack env file (keeps the test hermetic).
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'auth', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /\bhstack auth seed\b/, `expected help to include seed command\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /\bdev-auth\b/, `expected help to mention dev-auth\nstdout:\n${res.stdout}`);

  // Auth login targeting flags (local-first UX)
  assert.match(res.stdout, /--webapp(?:=|\b)/, `expected help to mention --webapp\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--webapp-url(?:=|\b)/, `expected help to mention --webapp-url\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--method(?:=|\b)/, `expected help to mention --method\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--start-if-needed(?:\b|$)/, `expected help to mention --start-if-needed\nstdout:\n${res.stdout}`);
});
