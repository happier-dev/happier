import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import {
  fetchHappierHealth,
  isHappierServerRunning,
  resolveServerReadyTimeoutMs,
  waitForHappierHealthOk,
  waitForServerReady,
} from './server.mjs';

async function listenServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test('fetchHappierHealth accepts the canonical Happier health payload only', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const health = await fetchHappierHealth(fixture.url);
    assert.equal(health.ok, true);
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: 'ok', service: 'happier-server' });
  } finally {
    await fixture.close();
  }
});

test('fetchHappierHealth fails closed for unrelated 2xx health responses', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const health = await fetchHappierHealth(fixture.url);
    assert.equal(health.ok, false);
    assert.equal(health.status, 204);
    assert.equal(health.json, null);
  } finally {
    await fixture.close();
  }
});

test('isHappierServerRunning rejects 200 JSON responses without Happier service semantics', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const running = await isHappierServerRunning(fixture.url);
    assert.equal(running, false);
  } finally {
    await fixture.close();
  }
});

test('waitForHappierHealthOk keeps waiting when /health returns unrelated 2xx responses', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'other-service' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const ready = await waitForHappierHealthOk(fixture.url, { timeoutMs: 75, intervalMs: 20 });
    assert.equal(ready, false);
  } finally {
    await fixture.close();
  }
});

test('waitForServerReady accepts an extended timeout for delayed healthy startups', async () => {
  let readyAt = 0;
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      if (!readyAt) readyAt = Date.now() + 120;
      if (Date.now() >= readyAt) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
        return;
      }
      res.statusCode = 503;
      res.end('starting');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    await waitForServerReady(fixture.url, { timeoutMs: 400, intervalMs: 25 });
  } finally {
    await fixture.close();
  }
});

test('waitForServerReady accepts generic ok health payloads for runtime startup readiness', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', marker: 'runtime-snapshot' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    await waitForServerReady(fixture.url, { timeoutMs: 200, intervalMs: 25 });
  } finally {
    await fixture.close();
  }
});

test('waitForServerReady fails early when the child process exits before health becomes ready', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  setTimeout(() => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
  }, 30);

  await assert.rejects(
    waitForServerReady('http://127.0.0.1:1', {
      timeoutMs: 5_000,
      intervalMs: 25,
      childProcess: child,
    }),
    /exited before becoming ready/,
  );
});

test('resolveServerReadyTimeoutMs prefers an explicit override and otherwise gives light server more time', () => {
  assert.equal(resolveServerReadyTimeoutMs({ serverComponentName: 'happier-server-light', env: {} }), 120_000);
  assert.equal(resolveServerReadyTimeoutMs({ serverComponentName: 'happier-server', env: {} }), 60_000);
  assert.equal(
    resolveServerReadyTimeoutMs({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_STACK_SERVER_READY_TIMEOUT_MS: '90000' },
    }),
    90_000,
  );
});
