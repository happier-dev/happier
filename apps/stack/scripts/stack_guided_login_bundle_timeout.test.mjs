import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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

