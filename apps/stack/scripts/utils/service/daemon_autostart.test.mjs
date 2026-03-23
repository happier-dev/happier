import test from 'node:test';
import assert from 'node:assert/strict';

import { createServiceDaemonAutostarter } from './daemon_autostart.mjs';

function createFakeScheduler() {
  let nowMs = 0;
  const queue = [];
  const schedule = (fn, delayMs) => {
    queue.push({ fn, delayMs: Number(delayMs) || 0 });
    return queue.length;
  };
  const cancel = () => {};
  const advanceOne = async () => {
    assert.ok(queue.length > 0, 'expected a scheduled task');
    const next = queue.shift();
    nowMs += Math.max(0, next.delayMs);
    await next.fn();
  };
  return {
    schedule,
    cancel,
    now: () => nowMs,
    setNow: (n) => {
      nowMs = Number(n) || 0;
    },
    queued: () => queue.slice(),
    advanceOne,
  };
}

test('createServiceDaemonAutostarter does nothing when disabled', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0 };
  const autostarter = createServiceDaemonAutostarter({
    enabled: false,
    isShuttingDown: () => false,
    isServerReady: async () => true,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => 'cred:a',
    isDaemonRunning: () => false,
    startDaemon: async () => {
      calls.start += 1;
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  assert.equal(scheduler.queued().length, 0);
  assert.equal(calls.start, 0);
});

test('createServiceDaemonAutostarter polls until credentials exist, then starts daemon once', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0 };
  const fingerprints = [null, null, 'cred:a'];

  const autostarter = createServiceDaemonAutostarter({
    enabled: true,
    isShuttingDown: () => false,
    isServerReady: async () => true,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => fingerprints.shift() ?? null,
    isDaemonRunning: () => false,
    startDaemon: async () => {
      calls.start += 1;
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  assert.equal(scheduler.queued().length, 1);

  await scheduler.advanceOne();
  assert.equal(calls.start, 0);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 5000);

  await scheduler.advanceOne();
  assert.equal(calls.start, 0);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 5000);

  await scheduler.advanceOne();
  assert.equal(calls.start, 1);
  assert.equal(scheduler.queued().length, 0);
});

test('createServiceDaemonAutostarter rate limits retries per credential fingerprint', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0 };
  let fingerprint = 'cred:a';
  let fail = true;

  const autostarter = createServiceDaemonAutostarter({
    enabled: true,
    isShuttingDown: () => false,
    isServerReady: async () => true,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => fingerprint,
    isDaemonRunning: () => false,
    startDaemon: async () => {
      calls.start += 1;
      if (fail) throw new Error('start failed');
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  await scheduler.advanceOne(); // attempt 1
  assert.equal(calls.start, 1);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 1000);

  await scheduler.advanceOne(); // attempt 2
  assert.equal(calls.start, 2);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 2000);

  await scheduler.advanceOne(); // maxed out → poll (no start)
  assert.equal(calls.start, 2);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 5000);

  // Same credentials fingerprint: still no start attempts.
  await scheduler.advanceOne();
  assert.equal(calls.start, 2);

  // New credentials fingerprint: reset attempts, allow start.
  fingerprint = 'cred:b';
  fail = false;
  await scheduler.advanceOne();
  assert.equal(calls.start, 3);
  assert.equal(scheduler.queued().length, 0);
});

test('createServiceDaemonAutostarter stops once daemon is running', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0 };
  let daemonRunning = false;

  const autostarter = createServiceDaemonAutostarter({
    enabled: true,
    isShuttingDown: () => false,
    isServerReady: async () => true,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => null,
    isDaemonRunning: () => daemonRunning,
    startDaemon: async () => {
      calls.start += 1;
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  assert.equal(scheduler.queued().length, 1);
  daemonRunning = true;
  await scheduler.advanceOne();
  assert.equal(calls.start, 0);
  assert.equal(scheduler.queued().length, 0);
});

test('createServiceDaemonAutostarter waits for server readiness before starting daemon', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0 };
  let serverReady = false;

  const autostarter = createServiceDaemonAutostarter({
    enabled: true,
    isShuttingDown: () => false,
    isServerReady: async () => true,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => 'cred:a',
    isServerReady: async () => serverReady,
    isDaemonRunning: () => false,
    startDaemon: async () => {
      calls.start += 1;
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  await scheduler.advanceOne();
  assert.equal(calls.start, 0);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 5000);

  serverReady = true;
  await scheduler.advanceOne();
  assert.equal(calls.start, 1);
  assert.equal(scheduler.queued().length, 0);
});

test('createServiceDaemonAutostarter tolerates credential probe errors and keeps polling', async () => {
  const scheduler = createFakeScheduler();
  const calls = { start: 0, probes: 0 };

  const autostarter = createServiceDaemonAutostarter({
    enabled: true,
    isShuttingDown: () => false,
    pollMs: 5000,
    maxAttemptsPerCredentials: 2,
    retryBaseMs: 1000,
    retryMaxMs: 10_000,
    nowMs: scheduler.now,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    getCredentialFingerprint: async () => {
      calls.probes += 1;
      if (calls.probes === 1) throw new Error('probe failed');
      return null;
    },
    isDaemonRunning: () => false,
    startDaemon: async () => {
      calls.start += 1;
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  autostarter.start();
  assert.equal(scheduler.queued().length, 1);

  await scheduler.advanceOne();
  assert.equal(calls.start, 0);
  assert.equal(scheduler.queued().length, 1);
  assert.equal(scheduler.queued()[0].delayMs, 5000);
});
