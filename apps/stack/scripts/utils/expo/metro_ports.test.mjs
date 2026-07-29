import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';

import { pickMetroPort, selectExpoDevMetroPort } from './metro_ports.mjs';

test('selectExpoDevMetroPort retries transient inconclusive stable-pin observations', async () => {
  let observations = 0;
  let nowMs = 0;
  const selected = await selectExpoDevMetroPort({
    env: {
      HAPPIER_STACK_EXPO_DEV_PORT: '45678',
      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
    },
    stackMode: true,
    stackName: 'dev',
    stableObservationTimeoutMs: 5,
    stableObservationRetryDelayMs: 1,
    nowImpl: () => nowMs,
    delayImpl: async (ms) => { nowMs += ms; },
    observePortImpl: async () => {
      observations += 1;
      return observations < 3
        ? { status: 'inconclusive', reason: 'listener-discovery-timeout' }
        : { status: 'free' };
    },
  });

  assert.equal(selected.port, 45678);
  assert.equal(observations, 3);
});

test('selectExpoDevMetroPort retries one stable scan candidate instead of drifting to another port', async () => {
  const observedPorts = [];
  let nowMs = 0;
  const selected = await selectExpoDevMetroPort({
    env: {
      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
    },
    stackMode: true,
    stackName: 'stable-scan-test',
    stableObservationTimeoutMs: 5,
    stableObservationRetryDelayMs: 1,
    nowImpl: () => nowMs,
    delayImpl: async (ms) => { nowMs += ms; },
    observePortImpl: async (port) => {
      observedPorts.push(port);
      return observedPorts.length < 3
        ? { status: 'inconclusive', reason: 'listener-discovery-timeout' }
        : { status: 'free' };
    },
  });

  assert.equal(selected.port, observedPorts[0]);
  assert.equal(selected.persistPin, true);
  assert.deepEqual(observedPorts, [observedPorts[0], observedPorts[0], observedPorts[0]]);
});

test('selectExpoDevMetroPort fails closed without cleanup after bounded inconclusive stable-pin retries', async () => {
  let cleanupCalls = 0;
  let observations = 0;
  let nowMs = 0;
  await assert.rejects(
    () => selectExpoDevMetroPort({
      env: {
        HAPPIER_STACK_EXPO_DEV_PORT: '45678',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
      },
      stackMode: true,
      stackName: 'dev',
      stableObservationTimeoutMs: 3,
      stableObservationRetryDelayMs: 1,
      nowImpl: () => nowMs,
      delayImpl: async (ms) => { nowMs += ms; },
      observePortImpl: async () => {
        observations += 1;
        return { status: 'inconclusive', reason: 'listener-discovery-timeout' };
      },
      onStableOccupied: async () => { cleanupCalls += 1; },
    }),
    (error) => error?.code === 'EEXPOPORTINCONCLUSIVE',
  );
  assert.equal(cleanupCalls, 0);
  assert.equal(observations, 3);
});

test('selectExpoDevMetroPort does not retry non-transient unsupported stable-pin evidence', async () => {
  let observations = 0;
  let nowMs = 0;
  await assert.rejects(
    () => selectExpoDevMetroPort({
      env: {
        HAPPIER_STACK_EXPO_DEV_PORT: '45678',
        HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: 'stable',
      },
      stackMode: true,
      stackName: 'dev',
      stableObservationTimeoutMs: 5,
      stableObservationRetryDelayMs: 1,
      nowImpl: () => nowMs,
      delayImpl: async (ms) => { nowMs += ms; },
      observePortImpl: async () => {
        observations += 1;
        return { status: 'inconclusive', reason: 'unsupported-platform' };
      },
    }),
    (error) => error?.code === 'EEXPOPORTINCONCLUSIVE',
  );
  assert.equal(observations, 1);
  assert.equal(nowMs, 0);
});

function listenEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('failed to allocate port')));
        return;
      }
      const port = Number(addr.port);
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

test('pickMetroPort does not reuse forced port when it is reserved', async () => {
  const forced = await listenEphemeralPort();
  const picked = await pickMetroPort({
    startPort: forced,
    forcedPort: String(forced),
    reservedPorts: new Set([forced]),
    host: '127.0.0.1',
  });
  assert.notEqual(picked, forced);
});

test('pickMetroPort does not reuse forced port when it is occupied by a non-metro process', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/status') {
      res.statusCode = 200;
      res.end('nope');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolvePromise) => srv.listen(0, '127.0.0.1', resolvePromise));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind test server');
  try {
    const picked = await pickMetroPort({
      startPort: port,
      forcedPort: String(port),
      reservedPorts: new Set(),
      host: '127.0.0.1',
    });
    assert.notEqual(picked, port);
  } finally {
    await new Promise((resolvePromise) => srv.close(resolvePromise));
  }
});

test('pickMetroPort does not reuse forced port when it is occupied by a Metro-like /status responder', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/status') {
      res.statusCode = 200;
      res.end('packager-status:running');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolvePromise) => srv.listen(0, '127.0.0.1', resolvePromise));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to bind test server');
  try {
    const picked = await pickMetroPort({
      startPort: port,
      forcedPort: String(port),
      reservedPorts: new Set(),
      host: '127.0.0.1',
    });
    assert.notEqual(picked, port);
  } finally {
    await new Promise((resolvePromise) => srv.close(resolvePromise));
  }
});
