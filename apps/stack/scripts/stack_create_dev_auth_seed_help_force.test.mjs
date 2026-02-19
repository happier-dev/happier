import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack stack create-dev-auth-seed --help surfaces --force for re-auth', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const env = {
    ...process.env,
    // Prevent env.mjs from auto-loading a real machine stack env file (keeps the test hermetic).
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'stack', 'create-dev-auth-seed', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--force(?:\b|\])/, `expected help to include --force\nstdout:\n${res.stdout}`);
});

test('hstack stack --help shows --force on create-dev-auth-seed usage line', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'stack', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(
    res.stdout,
    /hstack stack create-dev-auth-seed[^\n]*--force(?:\b|\])/,
    `expected stack root help to include --force on create-dev-auth-seed usage line\nstdout:\n${res.stdout}`
  );
});
