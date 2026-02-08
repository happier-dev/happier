import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './auth.testHelper.mjs';

async function createTtyFixture(prefix) {
  return await createAuthStackFixture({
    prefix,
    stackEnvLines: [
      'HAPPIER_STACK_STACK=main',
      'HAPPIER_STACK_SERVER_PORT=4101',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
    ],
  });
}

async function runAuthLoginPrintJson(rootDir, env, extraArgs = []) {
  return await runNodeCapture(
    [hstackBinPath(rootDir), 'auth', 'login', '--print', '--no-open', '--json', ...extraArgs],
    { cwd: rootDir, env }
  );
}

test('hstack auth login reports guided flow by default in tty contexts (via --print --json)', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createTtyFixture('hstack-auth-flow-tty-');
  try {
    const env = fixture.buildEnv({
      HAPPIER_STACK_TEST_TTY: '1',
    });

    const res = await runAuthLoginPrintJson(rootDir, env);
    assert.equal(
      res.code,
      0,
      `expected exit 0, got ${res.code}${res.signal ? ` (signal=${res.signal})` : ''}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`
    );
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.flow, 'guided');
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login keeps guided flow in tty when --method=mobile is provided', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createTtyFixture('hstack-auth-flow-tty-method-');
  try {
    const env = fixture.buildEnv({
      HAPPIER_STACK_TEST_TTY: '1',
    });

    const res = await runAuthLoginPrintJson(rootDir, env, ['--method=mobile']);
    assert.equal(
      res.code,
      0,
      `expected exit 0, got ${res.code}${res.signal ? ` (signal=${res.signal})` : ''}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`
    );
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed?.flow, 'guided');
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login rejects --flow override (guided is always used)', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createTtyFixture('hstack-auth-flow-tty-raw-');
  try {
    const env = fixture.buildEnv({
      HAPPIER_STACK_TEST_TTY: '1',
    });

    const res = await runAuthLoginPrintJson(rootDir, env, ['--flow=raw']);
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /--flow is no longer supported/i);
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login rejects invalid --flow values', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createTtyFixture('hstack-auth-flow-tty-invalid-');
  try {
    const env = fixture.buildEnv({
      HAPPIER_STACK_TEST_TTY: '1',
    });

    const res = await runAuthLoginPrintJson(rootDir, env, ['--flow=weird']);
    assert.notEqual(res.code, 0, `expected non-zero exit\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /--flow is no longer supported/i);
  } finally {
    await fixture.cleanup();
  }
});
