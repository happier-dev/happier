import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

import { waitForExpoMetroRunning } from './expo.mjs';

test('waitForExpoMetroRunning waits until Metro reports running', async () => {
  let probes = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return probes >= 3;
    },
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.probes, 3);
});

test('waitForExpoMetroRunning returns a non-ok result when the timeout elapses', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    timeoutMs: 25,
    intervalMs: 10,
  }, {
    looksLikeExpoMetroImpl: async () => false,
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.probes >= 2, true);
});

test('waitForExpoMetroRunning treats attended TUI deadlines as checkpoints while its owner is alive', async () => {
  const ownerProc = new EventEmitter();
  ownerProc.exitCode = null;
  ownerProc.signalCode = null;
  let probes = 0;
  let checkpoints = 0;
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerProc,
    timeoutMs: 25,
    intervalMs: 10,
    env: { HAPPIER_STACK_TUI: '1' },
    onTimeoutCheckpoint: () => { checkpoints += 1; },
  }, {
    looksLikeExpoMetroImpl: async () => {
      probes += 1;
      return probes >= 5;
    },
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => { now += 10; return now; };
    })(),
  });

  assert.equal(result.ok, true);
  assert.equal(checkpoints >= 1, true);
});

test('waitForExpoMetroRunning rejects a foreign Metro-shaped listener', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerPid: 100,
    timeoutMs: 25,
    intervalMs: 10,
    env: { TEST_READY_ENV: 'yes' },
  }, {
    looksLikeExpoMetroImpl: async ({ env }) => {
      assert.equal(env.TEST_READY_ENV, 'yes');
      return true;
    },
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', pids: [200] }),
    getProcessGroupIdImpl: async (pid) => pid,
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => { now += 10; return now; };
    })(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'listener_not_owned');
  assert.deepEqual(result.listenerPids, [200]);
});

test('waitForExpoMetroRunning accepts a listener in the spawned process group', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerPid: 100,
    env: { TEST_READY_ENV: 'yes' },
  }, {
    looksLikeExpoMetroImpl: async ({ env }) => env.TEST_READY_ENV === 'yes',
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', pids: [101] }),
    getProcessGroupIdImpl: async () => 500,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.listenerPids, [101]);
});

test('waitForExpoMetroRunning preserves unsupported ownership evidence as inconclusive', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerPid: 100,
    timeoutMs: 1,
    intervalMs: 1,
  }, {
    looksLikeExpoMetroImpl: async () => true,
    listListenPidsWithStatusImpl: async () => ({ status: 'unsupported', pids: [], reason: 'unsupported-platform' }),
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => { now += 1; return now; };
    })(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'listener_ownership_inconclusive');
  assert.equal(result.observation.reason, 'unsupported-platform');
});

test('waitForExpoMetroRunning does not downgrade a missing tracked owner to HTTP-only readiness', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerPid: () => null,
    timeoutMs: 1,
    intervalMs: 1,
  }, {
    looksLikeExpoMetroImpl: async () => true,
    delayImpl: async () => {},
    nowMsImpl: (() => {
      let now = 0;
      return () => { now += 1; return now; };
    })(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'owner_process_missing');
});

test('waitForExpoMetroRunning fails promptly when the watched owner exits before HTTP readiness', async () => {
  const ownerProc = new EventEmitter();
  ownerProc.exitCode = null;
  ownerProc.signalCode = null;
  const pending = waitForExpoMetroRunning({
    port: 8081,
    ownerPid: 100,
    ownerProc,
    timeoutMs: 120_000,
  }, {
    looksLikeExpoMetroImpl: async () => await new Promise(() => {}),
  });
  queueMicrotask(() => ownerProc.emit('exit', 1, null));
  const result = await pending;
  assert.deepEqual(result, { ok: false, reason: 'owner_process_exited', probes: 0 });
});

test('waitForExpoMetroRunning certifies a Windows wrapper descendant listener', async () => {
  const result = await waitForExpoMetroRunning({ port: 8081, ownerPid: 100 }, {
    platform: 'win32',
    looksLikeExpoMetroImpl: async () => true,
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', pids: [200] }),
    isWindowsDescendantProcessImpl: async (listenerPid, ownerPid) => listenerPid === 200 && ownerPid === 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ownerPid, 100);
  assert.equal(result.listenerPid, 200);
});

test('waitForExpoMetroRunning rejects mixed owned and foreign listeners without naming the foreign PID', async () => {
  const result = await waitForExpoMetroRunning({
    port: 8081,
    ownerPid: 100,
    timeoutMs: 1,
    intervalMs: 1,
  }, {
    looksLikeExpoMetroImpl: async () => true,
    listListenPidsWithStatusImpl: async () => ({ status: 'ok', pids: [200, 100] }),
    getProcessGroupIdImpl: async (pid) => pid,
    delayImpl: async () => {},
    nowMsImpl: (() => { let now = 0; return () => { now += 1; return now; }; })(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'competing_listener');
  assert.deepEqual(result.listenerPids, [200, 100]);
  assert.equal('listenerPid' in result, false);
});

test('waitForExpoMetroRunning rejects a real owned-wildcard plus foreign-specific listener attack', { skip: process.platform !== 'darwin' }, async (t) => {
  const owned = createServer((_req, res) => res.end('packager-status:running'));
  await new Promise((resolve, reject) => {
    owned.once('error', reject);
    owned.listen(0, undefined, resolve);
  });
  const address = owned.address();
  const port = typeof address === 'object' && address ? address.port : null;
  assert.ok(port);
  const source = `const http=require('node:http');const s=http.createServer((q,r)=>r.end('packager-status:running'));s.once('error',e=>{console.log('error:'+e.code);process.exit(0)});s.listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const foreign = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const line = await new Promise((resolve) => foreign.stdout.once('data', (chunk) => resolve(String(chunk).trim())));
    if (line !== 'ready') {
      t.skip(`specific-listener coexistence unavailable: ${line}`);
      return;
    }
    const result = await waitForExpoMetroRunning({ port, ownerPid: process.pid, timeoutMs: 2000, intervalMs: 25 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'competing_listener');
    assert.ok(result.ownedListenerPids.includes(process.pid));
    assert.ok(result.foreignListenerPids.includes(foreign.pid));
  } finally {
    try { process.kill(-foreign.pid, 'SIGKILL'); } catch {}
    await new Promise((resolve) => owned.close(resolve));
  }
});
