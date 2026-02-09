import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

const BASE_ENV_LINES = [
  'HAPPIER_STACK_STACK=main',
  'HAPPIER_STACK_SERVER_PORT=4102',
  'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
  'HAPPIER_STACK_TAILSCALE_SERVE=0',
];

async function runLoginPrintJson({ rootDir, fixture, args = [] }) {
  const res = await runNodeCapture(
    [hstackBinPath(rootDir), 'auth', 'login', '--print', '--no-open', '--json', ...args],
    { cwd: rootDir, env: fixture.buildEnv() }
  );
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  return JSON.parse(res.stdout.trim());
}

test('hstack auth login does not pass --force by default', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-force-default-',
    stackEnvLines: BASE_ENV_LINES,
  });
  try {
    const parsed = await runLoginPrintJson({ rootDir, fixture });
    assert.doesNotMatch(parsed.cmd, /\s--force(\s|$)/, `expected command to omit --force by default\n${parsed.cmd}`);
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login passes --force when explicitly requested', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-force-explicit-',
    stackEnvLines: BASE_ENV_LINES,
  });
  try {
    const parsed = await runLoginPrintJson({ rootDir, fixture, args: ['--force'] });
    assert.match(parsed.cmd, /\s--force(\s|$)/, `expected command to include --force when requested\n${parsed.cmd}`);
  } finally {
    await fixture.cleanup();
  }
});

test('hstack auth login prints stable active server scope env by default', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'hstack-auth-scope-env-',
    stackEnvLines: BASE_ENV_LINES,
  });
  try {
    const parsed = await runLoginPrintJson({ rootDir, fixture });
    assert.match(
      parsed.cmd,
      /HAPPIER_ACTIVE_SERVER_ID="stack_main__id_default"/,
      `expected printed command to include stable scope env\n${parsed.cmd}`
    );
  } finally {
    await fixture.cleanup();
  }
});
