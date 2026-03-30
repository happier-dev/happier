import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assertExpoWebappBundlesOrThrow } from './utils/auth/stack_guided_login.mjs';

async function createFakeMetroServer() {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head></head><body><script src="/bundle.js"></script></body></html>');
      return;
    }
    if (req.url === '/bundle.js') {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('not ready');
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);
  return { server, port };
}

async function createResolverErrorMetroServer() {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><head></head><body><script src="/bundle.js"></script></body></html>');
      return;
    }
    if (req.url === '/bundle.js') {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        type: 'UnableToResolveError',
        message: 'Unable to resolve module ../ops from /tmp/taskSessionLink.ts',
      }));
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address()?.port;
  assert.ok(Number.isFinite(port) && port > 0, `expected listening port, got ${String(port)}`);
  return { server, port };
}

test('assertExpoWebappBundlesOrThrow supports a configurable timeoutMs', async (t) => {
  let metro;
  try {
    try {
      metro = await createFakeMetroServer();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    await assert.rejects(
      async () => {
        await assertExpoWebappBundlesOrThrow({
          rootDir: process.cwd(),
          stackName: 'main',
          webappUrl: `http://127.0.0.1:${metro.port}`,
          timeoutMs: 1,
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /bundle/i);
        return true;
      }
    );
  } finally {
    if (metro?.server) {
      await new Promise((resolvePromise) => metro.server.close(resolvePromise));
    }
  }
});

test('assertExpoWebappBundlesOrThrow surfaces the symlink remediation hint for symlinked node_modules', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'stack-guided-login-symlink-'));
  let metro;
  const originalStorageDir = process.env.HAPPIER_STACK_STORAGE_DIR;
  try {
    const fakeRepoRoot = join(tempRoot, 'repo');
    const fakeUiDir = join(fakeRepoRoot, 'apps', 'ui');
    const fakeCliDir = join(fakeRepoRoot, 'apps', 'cli');
    const fakeServerDir = join(fakeRepoRoot, 'apps', 'server');
    const realNodeModulesDir = join(tempRoot, 'real-node_modules');
    const stackBaseDir = join(tempRoot, 'stack-storage', 'main');

    await mkdir(fakeUiDir, { recursive: true });
    await mkdir(fakeCliDir, { recursive: true });
    await mkdir(fakeServerDir, { recursive: true });
    await mkdir(realNodeModulesDir, { recursive: true });
    await mkdir(stackBaseDir, { recursive: true });
    await Promise.all([
      writeFile(join(fakeUiDir, 'package.json'), '{}'),
      writeFile(join(fakeCliDir, 'package.json'), '{}'),
      writeFile(join(fakeServerDir, 'package.json'), '{}'),
      writeFile(join(stackBaseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${fakeRepoRoot}\n`),
    ]);
    await symlink(realNodeModulesDir, join(fakeUiDir, 'node_modules'));

    process.env.HAPPIER_STACK_STORAGE_DIR = join(tempRoot, 'stack-storage');

    try {
      metro = await createResolverErrorMetroServer();
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'EPERM') {
        t.skip('sandbox disallows binding localhost test server (EPERM)');
        return;
      }
      throw e;
    }

    await assert.rejects(
      async () => {
        await assertExpoWebappBundlesOrThrow({
          rootDir: fakeRepoRoot,
          stackName: 'main',
          webappUrl: `http://127.0.0.1:${metro.port}`,
          timeoutMs: 250,
        });
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /symlinked node_modules/i);
        assert.match(err.message, /--deps=install/);
        return true;
      }
    );
  } finally {
    if (typeof originalStorageDir === 'string') {
      process.env.HAPPIER_STACK_STORAGE_DIR = originalStorageDir;
    } else {
      delete process.env.HAPPIER_STACK_STORAGE_DIR;
    }
    if (metro?.server) {
      await new Promise((resolvePromise) => metro.server.close(resolvePromise));
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('assertExpoWebappBundlesOrThrow treats a successful bundle response as ready without reading the full body', async (t) => {
  const originalFetch = globalThis.fetch;
  let bundleTextRead = false;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => '<html><body><script src="/bundle.js"></script></body></html>',
      };
    }

    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/javascript; charset=utf-8' }),
      text: async () => {
        bundleTextRead = true;
        throw new Error('bundle body should not be read once the response is 200');
      },
      body: {
        cancel: async () => {},
      },
    };
  };

  await assert.doesNotReject(async () => {
    await assertExpoWebappBundlesOrThrow({
      rootDir: process.cwd(),
      stackName: 'main',
      webappUrl: 'http://127.0.0.1:8081',
      timeoutMs: 50,
    });
  });

  assert.equal(bundleTextRead, false);
});
