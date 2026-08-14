import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthStackFixture, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

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
  assert.match(
    res.stdout,
    /\bhstack auth seed\b[^\n]*--force(?:\b|\])/,
    `expected seed help to include --force for re-auth\nstdout:\n${res.stdout}`
  );

  // Auth login targeting flags (local-first UX)
  assert.match(res.stdout, /--webapp(?:=|\b)/, `expected help to mention --webapp\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--webapp-url(?:=|\b)/, `expected help to mention --webapp-url\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--method(?:=|\b)/, `expected help to mention --method\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /--start-if-needed(?:\b|$)/, `expected help to mention --start-if-needed\nstdout:\n${res.stdout}`);
});

test('hstack stack auth copy-from help shows the stack-scoped force recovery command', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const stackName = 'controlled-qa';
  const sourceStackName = 'dev-auth';

  const env = {
    ...process.env,
    // Exercise the auth owner's scoped help branch without reading machine stack state.
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
  };

  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'auth', 'copy-from', sourceStackName, '--help'],
    { cwd: rootDir, env },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(
    res.stdout,
    new RegExp(`hstack stack auth ${stackName} copy-from <sourceStack>[^\\n]*--force`),
    `expected scoped copy-from help to expose --force recovery\nstdout:\n${res.stdout}`,
  );
  assert.doesNotMatch(
    res.stdout,
    /hstack auth copy-from[^\n]*--all/,
    `scoped help must not prescribe the global --all command\nstdout:\n${res.stdout}`,
  );
});

test('hstack stack auth copy-from --help delegates to the stack-scoped auth owner', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const stackName = 'controlled-qa';
  const fixture = await createAuthStackFixture({
    t,
    prefix: 'hstack-auth-scoped-copy-help-',
    stackName,
  });

  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'stack', 'auth', stackName, 'copy-from', 'dev-auth', '--help'],
    { cwd: rootDir, env: fixture.buildEnv() },
  );

  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(
    res.stdout,
    new RegExp(`hstack stack auth ${stackName} copy-from <sourceStack>[^\\n]*--force`),
    `expected scoped copy-from help to expose --force recovery\nstdout:\n${res.stdout}`,
  );
  assert.doesNotMatch(
    res.stdout,
    /hstack auth copy-from[^\n]*--all/,
    `scoped help must not prescribe the global --all command\nstdout:\n${res.stdout}`,
  );
});
