import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

test('hstack auth login --method=mobile sets HAPPIER_AUTH_METHOD in --print --json output', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-method-',
    stackEnvLines: [
      'HAPPIER_STACK_STACK=main',
      'HAPPIER_STACK_SERVER_PORT=4102',
      'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
      'HAPPIER_STACK_TAILSCALE_SERVE=0',
    ],
  });
  try {
    const res = await runNodeCapture(
      [
        hstackBinPath(rootDir),
        'auth',
        'login',
        '--print',
        '--no-open',
        '--json',
        '--method=mobile',
      ],
      { cwd: rootDir, env: fixture.buildEnv() }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code} (signal=${res.signal ?? 'none'})\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.ok(
      parsed?.cmd?.includes('HAPPIER_AUTH_METHOD="mobile"'),
      `expected printed cmd to include HAPPIER_AUTH_METHOD\n${parsed?.cmd}`
    );
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login invalid --method error mentions browser alias', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);

  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-method-invalid-',
    stackEnvLines: ['HAPPIER_STACK_STACK=main'],
  });
  try {
    const res = await runNodeCapture(
      [
        hstackBinPath(rootDir),
        'auth',
        'login',
        '--method=invalid',
      ],
      { cwd: rootDir, env: fixture.buildEnv() }
    );

    assert.ok(res.code !== 0 || res.signal, `expected non-zero exit for invalid --method\nstdout:\n${res.stdout}`);
    assert.match(res.stderr, /invalid --method=invalid/, `expected invalid method label in error\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /\bweb\b/, `expected web alias in error\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /\bbrowser\b/, `expected browser alias in error\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /\bmobile\b/, `expected mobile alias in error\nstderr:\n${res.stderr}`);
  } finally {
    await fixture.cleanup();
  }
});
