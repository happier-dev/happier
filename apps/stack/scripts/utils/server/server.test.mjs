import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import {
  createServerReadinessDeadline,
  fetchHappierHealth,
  isHappierServerRunning,
  resolveServerMigrationTimeoutMs,
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

test('waitForServerReady stops promptly when its lifecycle is cancelled', async () => {
  const fixture = await listenServer((_req, res) => {
    res.statusCode = 503;
    res.end('starting');
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('server readiness cancelled')), 20);
  try {
    await assert.rejects(
      waitForServerReady(fixture.url, {
        timeoutMs: 250,
        intervalMs: 25,
        signal: controller.signal,
      }),
      /server readiness cancelled/,
    );
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

test('waitForServerReady treats attended TUI deadlines as checkpoints while the child is alive', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let readyAt = 0;
  let checkpoints = 0;
  const fixture = await listenServer((_req, res) => {
    if (!readyAt) readyAt = Date.now() + 120;
    const ready = Date.now() >= readyAt;
    res.statusCode = ready ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ready
      ? { status: 'ok', service: 'happier-server' }
      : { status: 'starting' }));
  });

  try {
    await waitForServerReady(fixture.url, {
      timeoutMs: 40,
      intervalMs: 10,
      childProcess: child,
      continueWhileChildAlive: true,
      onTimeoutCheckpoint: () => { checkpoints += 1; },
    });
    assert.equal(checkpoints >= 1, true);
  } finally {
    await fixture.close();
  }
});

test('migration start switches readiness waiting to the bounded migration deadline', async () => {
  let readyAt = 0;
  const fixture = await listenServer((_req, res) => {
    if (!readyAt) readyAt = Date.now() + 120;
    if (Date.now() >= readyAt) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    res.statusCode = 503;
    res.end('migrating');
  });
  const startupDeadline = createServerReadinessDeadline({
    readinessTimeoutMs: 50,
    migrationTimeoutMs: 2_000,
  });
  startupDeadline.observeLine({
    stream: 'stdout',
    line: '{"happierStackTransition":"migration_started"}',
  });

  try {
    await waitForServerReady(fixture.url, {
      timeoutMs: 50,
      intervalMs: 20,
      startupDeadline,
    });
  } finally {
    await fixture.close();
  }
});

test('migration completion starts a fresh ordinary readiness deadline', async () => {
  const fixture = await listenServer((_req, res) => {
    res.statusCode = 503;
    res.end('starting');
  });
  const startupDeadline = createServerReadinessDeadline({ readinessTimeoutMs: 50, migrationTimeoutMs: 2_000 });
  startupDeadline.observeLine({ line: '{"happierStackTransition":"migration_started"}' });
  setTimeout(() => {
    startupDeadline.observeLine({ line: '{"happierStackTransition":"migration_completed"}' });
  }, 30);
  const startedAt = Date.now();

  try {
    await assert.rejects(
      waitForServerReady(fixture.url, { timeoutMs: 50, intervalMs: 10, startupDeadline }),
      /Timed out waiting for server/,
    );
    assert.ok(Date.now() - startedAt < 1_000, 'completion must restore the short readiness deadline');
  } finally {
    await fixture.close();
  }
});

test('migration deadline stays bounded and child early exit still wins', async () => {
  const fixture = await listenServer((_req, res) => {
    res.statusCode = 503;
    res.end('migrating');
  });
  const boundedDeadline = createServerReadinessDeadline({ readinessTimeoutMs: 30, migrationTimeoutMs: 70 });
  boundedDeadline.observeLine({ line: '{"happierStackTransition":"migration_started"}' });
  try {
    await assert.rejects(
      waitForServerReady(fixture.url, { timeoutMs: 30, intervalMs: 10, startupDeadline: boundedDeadline }),
      /migration.*timed out|timed out.*migration/i,
    );
    const child = new EventEmitter();
    child.exitCode = null;
    const exitDeadline = createServerReadinessDeadline({ readinessTimeoutMs: 30, migrationTimeoutMs: 500 });
    exitDeadline.observeLine({ line: '{"happierStackTransition":"migration_started"}' });
    setTimeout(() => {
      child.exitCode = 2;
      child.emit('exit', 2, null);
    }, 20);
    await assert.rejects(
      waitForServerReady(fixture.url, {
        timeoutMs: 30,
        intervalMs: 10,
        childProcess: child,
        startupDeadline: exitDeadline,
      }),
      /exited before becoming ready/,
    );
  } finally {
    await fixture.close();
  }
});

test('resolveServerReadyTimeoutMs prefers an explicit override and does not over-gate a progressing default startup', () => {
  assert.equal(resolveServerReadyTimeoutMs({ serverComponentName: 'happier-server-light', env: {} }), 600_000);
  assert.equal(resolveServerReadyTimeoutMs({ serverComponentName: 'happier-server', env: {} }), 600_000);
  assert.equal(
    resolveServerReadyTimeoutMs({
      serverComponentName: 'happier-server-light',
      env: { HAPPIER_STACK_SERVER_READY_TIMEOUT_MS: '90000' },
    }),
    90_000,
  );
  assert.equal(resolveServerMigrationTimeoutMs({ env: {} }), 30 * 60_000);
  assert.equal(
    resolveServerMigrationTimeoutMs({ env: { HAPPIER_STACK_SERVER_MIGRATION_TIMEOUT_MS: '240000' } }),
    240_000,
  );
  assert.equal(
    resolveServerMigrationTimeoutMs({ env: { HAPPIER_STACK_SERVER_MIGRATION_TIMEOUT_MS: '86400001' } }),
    30 * 60_000,
  );
});
