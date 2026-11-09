// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { waitForBackgroundStackReadiness } from '../../stack/run_script_with_stack_env.mjs';

import {
  createServerReadinessDeadline,
  fetchHappierHealth,
  getServerComponentName,
  isHappierServerRunning,
  resolveServerMigrationTimeoutMs,
  resolveServerReadyTimeoutMs,
  waitForHappierHealthOk,
  waitForServerReady,
  waitForHttpOk,
} from './server.mjs';

test('start, dev and source reload share server flavor and component normalization', () => {
  assert.equal(getServerComponentName({ kv: new Map([['--server-flavor', 'full']]), env: {} }), 'happier-server');
  assert.equal(getServerComponentName({ kv: new Map([['--server', 'light'], ['--server-flavor', 'full']]), env: {} }), 'happier-server-light');
  assert.equal(getServerComponentName({ kv: new Map(), env: { HAPPIER_STACK_SERVER_COMPONENT: 'happy-server-light' } }), 'happier-server-light');
  assert.throws(() => getServerComponentName({ kv: new Map([['--server-flavor', 'unknown']]), env: {} }));
});

test('HTTP readiness does not probe after its startup owner has cancelled', async t => {
  const controller = new AbortController();
  controller.abort(new DOMException('Startup cancelled', 'AbortError'));
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(waitForHttpOk('http://127.0.0.1:3340/healthz', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('HTTP readiness cancels an active request and releases child listeners', async t => {
  const controller = new AbortController();
  const child = new EventEmitter();
  let started;
  const request = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    started();
    return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = waitForHttpOk('http://127.0.0.1:3340/healthz', { signal: controller.signal, childProcess: child });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await request;
  controller.abort();
  await rejected;
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

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

test('server readiness accepts an unbounded caller lifetime without losing cancellation', async (t) => {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (probes++ === 0) {
      clock += 2 * 60 * 60_000;
      return new Response('', { status: 503 });
    }
    return String(url).endsWith('/health')
      ? Response.json({ status: 'ok', service: 'happier-server' })
      : new Response('', { status: 503 });
  });
  await waitForServerReady('http://localhost:3005', { timeoutMs: Infinity, intervalMs: 1 });
  const controller = new AbortController();
  controller.abort(new Error('owner cancelled readiness'));
  await assert.rejects(waitForServerReady('http://localhost:3005', {
    timeoutMs: Infinity, signal: controller.signal,
  }), /owner cancelled readiness/);
});

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

test('Stack readiness permits a healthy response beyond the old private probe cutoff', async () => {
  const fixture = await listenServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', service: 'happier-server' }));
    }, 1_650);
  });
  try {
    assert.equal((await fetchHappierHealth(fixture.url)).ready, true);
  } finally {
    await fixture.close();
  }
});

test('HTTP readiness spends the remaining observation budget rather than the polling interval', async () => {
  const fixture = await listenServer((_req, res) => {
    setTimeout(() => res.end('ready'), 600);
  });
  try {
    await waitForHttpOk(fixture.url, { timeoutMs: 1_200 });
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

async function descriptorReadinessFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-descriptor-readiness-' });
  const serverId = 'stack_descriptor__id_default';
  const url = 'http://127.0.0.1:41234';
  const descriptor = { v: 1, homeServerIdentityId: 'srv_expected_home', revision: 2,
    canonicalServerUrl: url, endpoints: [{ kind: 'https', url }] };
  const token = randomUUID();
  await mkdir(fixture.path('servers', serverId), { recursive: true });
  await writeFile(fixture.path('servers', serverId, 'access.key'), JSON.stringify({ token }));
  await writeFile(fixture.path('settings.json'), JSON.stringify({ schemaVersion: 6,
    activeServerId: serverId, servers: { [serverId]: { id: serverId, serverUrl: url,
      webappUrl: url, homeConnectionDescriptor: descriptor } } }));
  return { url, descriptor, token, env: { HAPPIER_STACK_CLI_HOME_DIR: fixture.root,
    HAPPIER_ACTIVE_SERVER_ID: serverId } };
}

for (const surface of ['server', 'background']) {
test(`${surface} readiness holds endpoint refresh and daemon preflight until the authenticated expected Home descriptor is published`,
  { timeout: 5_000 }, async t => {
    const fixture = await descriptorReadinessFixture(t);
    const phases = [];
    let descriptorReads = 0;
    let observeWaiting;
    const waiting = new Promise(resolve => { observeWaiting = resolve; });
    let publish;
    const published = new Promise(resolve => { publish = resolve; });
    const controller = new AbortController();
    t.after(() => controller.abort());
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).endsWith('/health')) return Response.json({ status: 'ok', service: 'happier-server' });
      assert.equal(new URL(url).pathname, '/v1/features/authenticated');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, `Bearer ${fixture.token}`);
      descriptorReads += 1;
      if (descriptorReads === 1) return Response.json({ features: {}, capabilities: {} });
      observeWaiting();
      await published;
      assert.deepEqual(phases, [], 'endpoint refresh and daemon preflight must still be held');
      return Response.json({ features: {}, capabilities: { serverIdentity: {
        serverIdentityId: fixture.descriptor.homeServerIdentityId } }, homeConnectionDescriptor: fixture.descriptor });
    });
    const pending = (surface === 'server'
      ? waitForServerReady(fixture.url, { env: fixture.env, intervalMs: 0, signal: controller.signal })
      : waitForBackgroundStackReadiness({ stackName: 'descriptor', scriptPath: 'run.mjs', args: ['--no-daemon'],
        env: fixture.env, internalServerUrl: fixture.url, timeoutMs: 1_000 }))
      .then(() => { phases.push('server_set', 'daemon_preflight'); });
    try {
      assert.equal(await Promise.race([pending.then(() => 'ready'), waiting.then(() => 'waiting')]), 'waiting');
      assert.deepEqual(phases, []);
    } finally {
      publish();
    }
    await pending;
    assert.deepEqual(phases, ['server_set', 'daemon_preflight']);
    assert.equal(descriptorReads, 2, 'one fresh authenticated read per existing readiness attempt');
  });
}

for (const surface of ['server', 'background']) {
test(`${surface} readiness never admits an authenticated descriptor for a different Home`, async t => {
  const fixture = await descriptorReadinessFixture(t);
  const phases = [];
  t.mock.method(globalThis, 'fetch', async url => String(url).endsWith('/health')
    ? Response.json({ status: 'ok', service: 'happier-server' })
    : Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_other_home' } },
      homeConnectionDescriptor: { ...fixture.descriptor, homeServerIdentityId: 'srv_other_home' } }));
  const starting = surface === 'server'
    ? waitForServerReady(fixture.url, { env: fixture.env, intervalMs: 0, timeoutMs: 100 })
    : waitForBackgroundStackReadiness({ stackName: 'descriptor', scriptPath: 'dev.mjs',
      env: fixture.env, internalServerUrl: fixture.url, timeoutMs: 100 });
  await assert.rejects(starting.then(() => { phases.push('server_set', 'daemon_preflight'); }), /Home.*identity|identity.*Home/i);
  assert.deepEqual(phases, []);
});
}

for (const status of [401, 403]) {
for (const surface of ['server', 'background']) {
test(`${surface} readiness leaves a signed-out local server running and reports sign-in-required after HTTP ${status}`, async t => {
  const fixture = await descriptorReadinessFixture(t);
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/v1/features/authenticated') return new Response(null, { status });
    return Response.json({ status: 'ok', service: 'happier-server', features: {}, capabilities: {
      serverIdentity: { serverIdentityId: fixture.descriptor.homeServerIdentityId } },
      homeConnectionDescriptor: fixture.descriptor });
  });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const result = surface === 'server'
    ? await waitForServerReady(fixture.url, { env: fixture.env, childProcess: child })
    : await waitForBackgroundStackReadiness({ stackName: 'descriptor', scriptPath: 'dev.mjs',
      env: fixture.env, internalServerUrl: fixture.url, timeoutMs: 100,
      isRunnerAlive: () => child.exitCode === null });
  assert.deepEqual(result, { status: 'sign-in-required' });
  assert.equal(child.exitCode, null, 'signed-out readiness must settle without a server startup failure');
  assert.equal(child.listenerCount('exit'), 0);
  assert.deepEqual(paths, ['/v1/features/authenticated'], 'sign-in-required settles without re-polls or unauthenticated fallback');
});
}
}

test('server readiness preserves its existing budget while an authenticated descriptor is withheld', async t => {
  const fixture = await descriptorReadinessFixture(t);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).pathname, '/v1/features/authenticated');
    return Response.json({ features: {}, capabilities: {} });
  });
  await assert.rejects(waitForServerReady(fixture.url, { env: fixture.env, timeoutMs: 30, intervalMs: 1,
    continueWhileChildAlive: false }), /Timed out waiting for server/);
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
