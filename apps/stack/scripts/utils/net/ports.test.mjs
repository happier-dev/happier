import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isTcpPortFree,
  killPortListeners,
  listListenPidsWithStatus,
  observeTcpPortAvailability,
  pickNextFreeTcpPort,
  waitForTcpPortFree,
} from './ports.mjs';

async function waitForProbeProcessPid(path) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 1) return pid;
    } catch {
      // The probe process has not recorded its PID yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for listener probe PID at ${path}`);
}

test('killPortListeners returns only listeners terminated through incarnation-aware teardown', async () => {
  const calls = [];
  const killed = await killPortListeners(34567, {
    platform: 'linux',
    listListenPidsImpl: async () => [701, 702],
    terminateProcessPidImpl: async (pid) => {
      calls.push(pid);
      return pid === 701
        ? { ok: true, signal: 'SIGTERM' }
        : { ok: false, reason: 'process_instance_changed' };
    },
    logImpl: () => {},
  });

  assert.deepEqual(calls, [701, 702]);
  assert.deepEqual(killed, [701]);
});

test('listener discovery preserves timeout instead of manufacturing an empty listener set', async () => {
  const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const result = await listListenPidsWithStatus(34567, {
    platform: 'linux',
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async () => { throw error; },
  });

  assert.deepEqual(result, {
    status: 'timeout',
    supported: true,
    pids: [],
    reason: 'listener-discovery-timeout',
  });
});

test('listener discovery returns a typed timeout when lsof cannot close after its deadline', { timeout: 3_000 }, async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process-group cleanup contract');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'happy-listener-timeout-'));
  const lsofPath = join(root, 'lsof');
  const pidPath = join(root, 'lsof.pid');
  const originalKill = process.kill;
  let lsofPid = null;
  let pending = null;
  t.after(async () => {
    if (Number.isInteger(lsofPid) && lsofPid > 1) {
      try {
        originalKill(-lsofPid, 'SIGKILL');
      } catch {
        try { originalKill(lsofPid, 'SIGKILL'); } catch {}
      }
    }
    if (pending) {
      await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(lsofPath, [
    '#!/bin/sh',
    `printf '%s' "$$" > ${JSON.stringify(pidPath)}`,
    'while :; do sleep 1; done',
  ].join('\n'), 'utf8');
  await chmod(lsofPath, 0o755);

  t.mock.method(process, 'kill', (pid, signal) => {
    if (signal === 0) return originalKill(pid, signal);
    return true;
  });
  pending = listListenPidsWithStatus(34567, {
    platform: 'darwin',
    timeoutMs: 150,
    resolveCommandPathImpl: async () => lsofPath,
  });
  lsofPid = await waitForProbeProcessPid(pidPath);

  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ status: 'still-pending' }), 1_500)),
  ]);

  assert.deepEqual(result, {
    status: 'timeout',
    supported: true,
    pids: [],
    reason: 'listener-discovery-timeout',
  });
});

test('Windows listener discovery parses only LISTENING rows for the exact port', async () => {
  const result = await listListenPidsWithStatus(34567, {
    platform: 'win32',
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => [
      'TCP    0.0.0.0:34567    0.0.0.0:0    LISTENING    701',
      'TCP    0.0.0.0:345670   0.0.0.0:0    LISTENING    702',
      'TCP    127.0.0.1:34567  127.0.0.1:50000 ESTABLISHED 703',
    ].join('\n'),
  });

  assert.deepEqual(result, { status: 'ok', supported: true, pids: [701] });
});

test('listener discovery filters Windows evidence to exact candidate pids', async () => {
  const result = await listListenPidsWithStatus(34567, {
    candidatePids: [701],
    platform: 'win32',
    resolveCommandPathImpl: async () => 'C:\\Windows\\System32\\netstat.exe',
    runCaptureImpl: async () => [
      'TCP 0.0.0.0:34567 0.0.0.0:0 LISTENING 701',
      'TCP [::]:34567 [::]:0 LISTENING 702',
    ].join('\n'),
  });

  assert.deepEqual(result, { status: 'ok', supported: true, pids: [701] });
});

test('listener discovery constrains Unix lsof to exact candidate pids', async () => {
  let capturedArgs = null;
  const result = await listListenPidsWithStatus(34567, {
    candidatePids: [701, 702, 701, 0],
    platform: 'darwin',
    resolveCommandPathImpl: async () => '/usr/bin/lsof',
    runCaptureImpl: async (_command, args) => {
      capturedArgs = args;
      return '701\n999\n';
    },
  });

  assert.deepEqual(result, { status: 'ok', supported: true, pids: [701] });
  assert.deepEqual(capturedArgs, [
    '-nP',
    '-a',
    '-p',
    '701,702',
    '-iTCP:34567',
    '-sTCP:LISTEN',
    '-t',
  ]);
});

function completeNetworkInterfaceInventory(interfaces) {
  return { status: 'complete', interfaces };
}

async function getUnusedLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolvePromise, reject) => {
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0 }, () => resolvePromise());
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : null;
  if (!port) throw new Error('failed to allocate a free TCP port');
  await new Promise((resolvePromise) => srv.close(resolvePromise));
  return port;
}

test(
  'isTcpPortFree resolves (fails closed) when the bind-probe cannot close cleanly',
  { timeout: 2000 },
  async (t) => {
    const port = await getUnusedLoopbackPort();

    t.mock.method(net, 'createServer', () => {
      return {
        unref() {},
        on() {
          return this;
        },
        listen(_opts, cb) {
          queueMicrotask(cb);
          return this;
        },
        close() {
          // Simulate a broken/never-closing server.close callback.
        },
      };
    });

    const out = await isTcpPortFree(port, { host: '127.0.0.1', timeoutMs: 25 });
    assert.equal(out, false);
  }
);

test('isTcpPortFree delegates its decision to typed availability evidence', async () => {
  let observed = null;
  const free = await isTcpPortFree(34567, {
    observeTcpPortAvailabilityImpl: async (port, options) => {
      observed = { port, host: options.host, timeoutMs: options.timeoutMs };
      return { status: 'inconclusive', reason: 'interface-inventory-unavailable' };
    },
  });

  assert.equal(free, false);
  assert.deepEqual(observed, { port: 34567, host: '127.0.0.1', timeoutMs: 250 });
});

test('waitForTcpPortFree preserves typed final evidence under one absolute deadline', async () => {
  let now = 0;
  const budgets = [];
  const result = await waitForTcpPortFree(34567, {
    timeoutMs: 100,
    intervalMs: 25,
    nowImpl: () => now,
    delayImpl: async (delayMs) => { now += delayMs; },
    observeTcpPortAvailabilityImpl: async (_port, options) => {
      budgets.push(options.timeoutMs);
      now += 30;
      return budgets.length === 1
        ? { status: 'occupied', reason: 'address-in-use' }
        : { status: 'inconclusive', reason: 'port-bind-timeout' };
    },
  });

  assert.deepEqual(result, { status: 'inconclusive', reason: 'port-bind-timeout' });
  assert.deepEqual(budgets, [100, 45]);
  assert.equal(now, 100);
});

test('waitForTcpPortFree default delay advances after an occupied observation', async () => {
  let observations = 0;
  const result = await waitForTcpPortFree(34567, {
    timeoutMs: 100,
    intervalMs: 1,
    observeTcpPortAvailabilityImpl: async () => {
      observations += 1;
      return observations === 1
        ? { status: 'occupied', reason: 'address-in-use' }
        : { status: 'free' };
    },
  });

  assert.deepEqual(result, { status: 'free' });
  assert.equal(observations, 2);
});

test('pickNextFreeTcpPort does not accept late free evidence beyond its absolute deadline', async () => {
  let now = 0;
  await assert.rejects(
    () => pickNextFreeTcpPort(43100, {
      totalTimeoutMs: 50,
      nowImpl: () => now,
      observeTcpPortAvailabilityImpl: async () => {
        now = 51;
        return { status: 'free' };
      },
    }),
    (error) => error?.code === 'EPORTALLOCATIONTIMEOUT',
  );
});

test('typed availability checks non-loopback interfaces and occupied evidence dominates probe errors', async () => {
  const probed = [];
  const result = await observeTcpPortAvailability(43100, {
    timeoutMs: 500,
    networkInterfacesImpl: () => completeNetworkInterfaceInventory({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '192.0.2.15', family: 'IPv4', internal: false }],
    }),
    probeTcpPortBindingImpl: async (_port, { host }) => {
      probed.push(host);
      if (host === '127.0.0.1') return { status: 'error', reason: 'port-bind-error' };
      if (host === '192.0.2.15') return { status: 'in_use', reason: 'address-in-use' };
      return { status: 'free' };
    },
  });

  assert.deepEqual(result, { status: 'occupied', reason: 'address-in-use' });
  assert.deepEqual(probed, ['127.0.0.1', '192.0.2.15']);
});

test('typed availability treats partial interface inventory as inconclusive without probing', async () => {
  let probes = 0;
  const result = await observeTcpPortAvailability(43100, {
    networkInterfacesImpl: () => ({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    }),
    probeTcpPortBindingImpl: async () => {
      probes += 1;
      return { status: 'free' };
    },
  });

  assert.deepEqual(result, { status: 'inconclusive', reason: 'interface-inventory-unavailable' });
  assert.equal(probes, 0);
});
