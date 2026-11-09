import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import {
  createServerReadinessDeadline,
  fetchExactServerReadyIdentity,
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

test('isHappierServerRunning uses DB-free liveness when readiness is unavailable', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    if (req.url === '/ready') {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'error', service: 'happier-server' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    const running = await isHappierServerRunning(fixture.url);
    assert.equal(running, true);
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

test('waitForServerReady polls /ready for delayed database-ready startups', async () => {
  let readyAt = 0;
  const seenUrls = [];
  const fixture = await listenServer((req, res) => {
    seenUrls.push(req.url);
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    if (req.url === '/ready') {
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
    assert.ok(seenUrls.includes('/ready'), 'expected waitForServerReady to poll /ready');
  } finally {
    await fixture.close();
  }
});

test('waitForServerReady does not accept /health liveness while /ready is unavailable', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
      return;
    }
    if (req.url === '/ready') {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'error', service: 'happier-server', reason: 'db_error' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    await assert.rejects(
      () => waitForServerReady(fixture.url, { timeoutMs: 80, intervalMs: 20 }),
      /Timed out waiting for server/,
    );
  } finally {
    await fixture.close();
  }
});

test('waitForServerReady does not accept the root welcome page while /ready is unavailable', async () => {
  const fixture = await listenServer((req, res) => {
    if (req.url === '/ready') {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'error', service: 'happier-server', reason: 'db_error' }));
      return;
    }
    if (req.url === '/') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body>Welcome to Happier Server!</body>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  try {
    await assert.rejects(
      () => waitForServerReady(fixture.url, { timeoutMs: 80, intervalMs: 20 }),
      /Timed out waiting for server/,
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

test('waitForServerReady rejects when the child exits during the successful readiness probe', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const fixture = await listenServer((req, res) => {
    if (req.url !== '/ready') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    child.exitCode = 9;
    child.emit('exit', 9, null);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
  });

  try {
    await assert.rejects(
      waitForServerReady(fixture.url, {
        timeoutMs: 500,
        intervalMs: 25,
        childProcess: child,
      }),
      /exited before becoming ready/,
    );
  } finally {
    await fixture.close();
  }
});

test('migration start switches readiness waiting to the bounded migration deadline', async () => {
  let readyAt = 0;
  const fixture = await listenServer((req, res) => {
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
  const startupDeadline = createServerReadinessDeadline({
    readinessTimeoutMs: 50,
    migrationTimeoutMs: 2_000,
  });
  startupDeadline.observeLine({ line: '{"happierStackTransition":"migration_started"}' });
  setTimeout(() => {
    startupDeadline.observeLine({ line: '{"happierStackTransition":"migration_completed"}' });
  }, 30);
  const startedAt = Date.now();

  try {
    await assert.rejects(
      waitForServerReady(fixture.url, {
        timeoutMs: 50,
        intervalMs: 10,
        startupDeadline,
      }),
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
  const boundedDeadline = createServerReadinessDeadline({
    readinessTimeoutMs: 30,
    migrationTimeoutMs: 70,
  });
  boundedDeadline.observeLine({ line: '{"happierStackTransition":"migration_started"}' });
  try {
    await assert.rejects(
      waitForServerReady(fixture.url, {
        timeoutMs: 30,
        intervalMs: 10,
        startupDeadline: boundedDeadline,
      }),
      /migration.*timed out|timed out.*migration/i,
    );
    const child = new EventEmitter();
    child.exitCode = null;
    const exitDeadline = createServerReadinessDeadline({
      readinessTimeoutMs: 30,
      migrationTimeoutMs: 500,
    });
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

async function withReadyResponder(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { host: '127.0.0.1', port: server.address().port };
}

const sendReady = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('fetchExactServerReadyIdentity reads the identity from the exact endpoint', async (t) => {
  const paths = [];
  const endpoint = await withReadyResponder(t, (req, res) => {
    paths.push(req.url);
    sendReady(res, 200, { status: 'ok', service: 'happier-server', apiStartupIdentity: { instanceId: 'instance-1' } });
  });
  assert.deepEqual(
    await fetchExactServerReadyIdentity({ ...endpoint, timeoutMs: 2_000 }),
    { status: 'identity', instanceId: 'instance-1' },
  );
  assert.deepEqual(paths, ['/ready']);
});

test('fetchExactServerReadyIdentity accepts nothing but a direct healthy identity response', async (t) => {
  const redirect = await withReadyResponder(t, (_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:9/ready' });
    res.end();
  });
  const unhealthy = await withReadyResponder(t, (_req, res) => {
    sendReady(res, 503, { status: 'ok', service: 'happier-server', apiStartupIdentity: { instanceId: 'instance-1' } });
  });
  for (const endpoint of [redirect, unhealthy]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await fetchExactServerReadyIdentity({ ...endpoint, timeoutMs: 2_000 })).status, 'invalid');
  }

  const movedResponse = await fetchExactServerReadyIdentity(
    { host: '127.0.0.1', port: 53944, timeoutMs: 2_000 },
    {
      fetchImpl: async () => ({
        url: 'http://127.0.0.1:1/ready',
        status: 200,
        json: async () => ({ status: 'ok', service: 'happier-server', apiStartupIdentity: { instanceId: 'instance-1' } }),
      }),
    },
  );
  assert.equal(movedResponse.status, 'invalid');
});

test('fetchExactServerReadyIdentity honors caller cancellation', async (t) => {
  const endpoint = await withReadyResponder(t, () => {});
  const controller = new AbortController();
  const pending = fetchExactServerReadyIdentity({ ...endpoint, timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  assert.equal((await pending).status, 'invalid');
});

test('fetchExactServerReadyIdentity separates affirmative legacy readiness from failed evidence', async (t) => {
  const legacy = await withReadyResponder(t, (_req, res) => {
    sendReady(res, 200, { status: 'ok', service: 'happier-server' });
  });
  const unhealthy = await withReadyResponder(t, (_req, res) => {
    sendReady(res, 503, { status: 'ok', service: 'happier-server' });
  });
  assert.deepEqual(await fetchExactServerReadyIdentity({ ...legacy, timeoutMs: 2_000 }), { status: 'legacy' });
  assert.equal((await fetchExactServerReadyIdentity({ ...unhealthy, timeoutMs: 2_000 })).status, 'invalid');
});

test('startup readiness accepts only a happier-server answer', async (t) => {
  const canonical = await withReadyResponder(t, (_req, res) => sendReady(res, 200, { status: 'ok', service: 'happier-server' }));
  await waitForServerReady(`http://${canonical.host}:${canonical.port}`, { timeoutMs: 400, intervalMs: 20 });

  for (const body of [{ status: 'ok', service: 'other-service' }, { status: 'ok' }]) {
    // eslint-disable-next-line no-await-in-loop
    const endpoint = await withReadyResponder(t, (_req, res) => sendReady(res, 200, body));
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      waitForServerReady(`http://${endpoint.host}:${endpoint.port}`, { timeoutMs: 80, intervalMs: 20 }),
      /Timed out waiting for server/,
    );
  }
});

async function assertReadinessCancelsPromptly(wait, controller) {
  const startedAt = Date.now();
  const cancelled = assert.rejects(wait, (error) => error.code === 'ESERVERREADINESSCANCELLED');
  setTimeout(() => controller.abort(), 20);
  await Promise.race([
    cancelled,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('readiness outlived its cancellation')), 1_000)),
  ]);
  assert.ok(Date.now() - startedAt < 1_000);
}

test('cancellation settles a readiness wait stuck in its fetch, with the child alive', async (t) => {
  const stalled = await withReadyResponder(t, () => {});
  const controller = new AbortController();
  await assertReadinessCancelsPromptly(waitForServerReady(`http://${stalled.host}:${stalled.port}`, {
    timeoutMs: 30_000,
    childProcess: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
    signal: controller.signal,
  }), controller);
});

test('cancellation settles a readiness wait in its delay and an attended wait that would extend forever', async (t) => {
  const notReady = await withReadyResponder(t, (_req, res) => sendReady(res, 503, {}));
  const controller = new AbortController();
  await assertReadinessCancelsPromptly(waitForServerReady(`http://${notReady.host}:${notReady.port}`, {
    timeoutMs: 1,
    intervalMs: 30_000,
    continueWhileChildAlive: true,
    onTimeoutCheckpoint: () => {},
    childProcess: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
    signal: controller.signal,
  }), controller);
});

test('a readiness wait cancelled before it starts never probes', async (t) => {
  let probes = 0;
  const endpoint = await withReadyResponder(t, (_req, res) => {
    probes += 1;
    sendReady(res, 200, { status: 'ok', service: 'happier-server' });
  });
  await assert.rejects(
    waitForServerReady(`http://${endpoint.host}:${endpoint.port}`, { timeoutMs: 400, signal: AbortSignal.abort() }),
    (error) => error.code === 'ESERVERREADINESSCANCELLED',
  );
  assert.equal(probes, 0);
});

test('a child exit stays the readiness failure even though it also cancels the attempt', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const controller = new AbortController();
  child.once('exit', () => controller.abort());
  const wait = waitForServerReady('http://127.0.0.1:1', {
    timeoutMs: 5_000,
    intervalMs: 30_000,
    childProcess: child,
    signal: controller.signal,
  });
  setTimeout(() => {
    child.exitCode = 1;
    child.emit('exit', 1, null);
  }, 20);
  await assert.rejects(wait, /exited before becoming ready/);
});
