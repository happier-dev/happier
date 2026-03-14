import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { assertGuidedAuthWebappReadyOrThrow, buildStackAuthLoginInvocation } from './utils/auth/stack_guided_login.mjs';
import { createAuthStackFixture, getStackRootFromMeta } from './testkit/auth_testkit.mjs';

test('guided stack auth login invokes core happier auth login directly', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:1234';
  const inv = await buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl });
  assert.ok(Array.isArray(inv?.args));
  assert.equal(inv.command, process.execPath);
  assert.match(String(inv.args[0] ?? ''), /apps\/cli\/package-dist\/index\.mjs$/);
  assert.equal(inv.args[1], 'auth');
  assert.equal(inv.args[2], 'login');
  assert.equal(inv?.env?.HAPPIER_WEBAPP_URL, webappUrl);
  assert.notEqual(inv?.env?.HAPPIER_STACK_AUTH_INNER, '1');
});

test('guided stack auth login defaults stack name to main and preserves invocation ordering', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const webappUrl = 'http://localhost:4321';
  const inv = await buildStackAuthLoginInvocation({ rootDir, stackName: '   ', webappUrl });
  assert.equal(inv.args[1], 'auth');
  assert.equal(inv.args[2], 'login');
  assert.equal(inv.env.HAPPIER_WEBAPP_URL, webappUrl);
});

test('guided stack auth login invocation merges caller env', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const inv = await buildStackAuthLoginInvocation({
    rootDir,
    stackName: 'feature-1',
    webappUrl: 'http://localhost:5555',
    env: { CUSTOM_FLAG: 'yes', HAPPIER_STACK_AUTH_INNER: '0' },
  });
  assert.equal(inv.env.CUSTOM_FLAG, 'yes');
  assert.equal(inv.env.HAPPIER_STACK_AUTH_INNER, '0');
});

test('guided stack auth login invocation rejects empty webappUrl', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  await assert.rejects(
    () => buildStackAuthLoginInvocation({ rootDir, stackName: 'main', webappUrl: '   ' }),
    /requires a webappUrl/i
  );
});

test('guided stack auth login invocation uses the active runtime snapshot cli when runtime mode selects a snapshot', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const fixture = await createAuthStackFixture({
    prefix: 'stack-guided-login-runtime-',
    stackName: 'dev-built',
    stackEnvLines: [
      'HAPPIER_STACK_RUNTIME_MODE=prefer',
    ],
  });

  try {
    const snapshotDir = join(fixture.storageDir, 'dev-built', 'runtime', 'builds', 'snap-auth');
    await mkdir(join(snapshotDir, 'ui'), { recursive: true });
    await mkdir(join(snapshotDir, 'server'), { recursive: true });
    await mkdir(join(snapshotDir, 'cli'), { recursive: true });
    await writeFile(join(snapshotDir, 'ui', 'index.html'), '<!doctype html><html><body>runtime ui</body></html>\n', 'utf-8');
    await writeFile(join(snapshotDir, 'server', 'happier-server'), '#!/bin/sh\nexit 0\n', 'utf-8');
    await writeFile(join(snapshotDir, 'cli', 'happier'), '#!/bin/sh\nexit 0\n', 'utf-8');
    await writeFile(
      join(snapshotDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        snapshotId: 'snap-auth',
        sourceFingerprint: 'src-auth',
        components: {
          web: { artifactFingerprint: 'web-auth', entrypoint: 'ui/index.html' },
          server: { artifactFingerprint: 'srv-auth', entrypoint: 'server/happier-server' },
          daemon: { artifactFingerprint: 'cli-auth', entrypoint: 'cli/happier' },
        },
      }) + '\n',
      'utf-8',
    );
    await writeFile(
      join(fixture.storageDir, 'dev-built', 'runtime', 'current.json'),
      JSON.stringify({
        version: 1,
        snapshotId: 'snap-auth',
        snapshotPath: snapshotDir,
        sourceFingerprint: 'src-auth',
      }) + '\n',
      'utf-8',
    );

    const inv = await buildStackAuthLoginInvocation({
      rootDir,
      stackName: 'dev-built',
      webappUrl: 'http://localhost:5555',
      env: fixture.buildEnv({ HAPPIER_STACK_RUNTIME_MODE: 'prefer' }),
    });

    assert.equal(inv.command, join(snapshotDir, 'cli', 'happier'));
    assert.deepEqual(inv.args, ['auth', 'login']);
  } finally {
    await fixture.cleanup();
  }
});

test('guided stack auth login rejects generic runtime-backed HTML without the Happier readiness marker', async (t) => {
  const server = createServer((_, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>wrong origin</body></html>');
  });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.skip('sandbox disallows binding localhost test server (EPERM)');
      return;
    }
    throw error;
  }

  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);

  try {
    await assert.rejects(
      () => assertGuidedAuthWebappReadyOrThrow({
        kind: 'server',
        webappUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 20,
      }),
      /missing Happier UI readiness marker/i
    );
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
