import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startOwnerDaemonLifecycleReconciler } from './daemonLifecycleReconciler.mjs';
import { syncStackRuntimeDaemonPidFromDaemonState } from '../stack/runtime_daemon_state.mjs';
import { recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';

test('owner stop suppresses recovery across cadence and reinstallation until explicit running desire', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-daemon-desire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStatePath = join(root, 'stack.runtime.json');
  await recordStackRuntimeUpdate(runtimeStatePath, {
    daemon: { desiredStateByIdentity: { default: 'stopped', peer: 'running' } },
  });
  let recoveries = 0;
  const install = (cliIdentity = 'default') => startOwnerDaemonLifecycleReconciler({
    enabled: true, runtimeStatePath, cliIdentity,
    observe: async () => ({ status: 'stopped' }),
    recover: async () => { recoveries++; return { started: true }; },
  }, { setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  for (let installation = 0; installation < 2; installation++) {
    const reconciler = install();
    try {
      for (let tick = 0; tick < 5; tick++) await reconciler.reconcileNow();
      assert.equal(recoveries, 0, 'stopped desire must prevent every recovery');
    } finally { reconciler.close(); }
  }
  const peer = install('peer');
  try {
    await peer.reconcileNow();
    await peer.reconcileNow();
    assert.equal(recoveries, 1, 'one identity stop must not suppress another identity');
  } finally { peer.close(); }
  await recordStackRuntimeUpdate(runtimeStatePath, { daemon: { desiredStateByIdentity: { default: 'running' } } });
  const reconciler = install();
  try {
    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    assert.equal(recoveries, 2, 'resumed desire retains one recovery per confirmed absence');
  } finally { reconciler.close(); }
});

test('owner daemon observation persists state in service mode without enabling recovery', async () => {
  const persisted = [];
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => ({ status: 'stopped', pid: null }),
      onObservation: async (observation) => persisted.push(observation),
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );
  assert.ok(reconciler);
  try {
    assert.equal((await reconciler.reconcileNow()).reason, 'observation-only');
    assert.equal((await reconciler.reconcileNow()).reason, 'observation-only');
    assert.deepEqual(persisted, [{ status: 'stopped', pid: null }, { status: 'stopped', pid: null }]);
  } finally {
    reconciler.close();
  }
});

test('owner daemon observation clears dead membership before recovery consumes it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-daemon-observation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStatePath = join(root, 'stack.runtime.json');
  await writeFile(runtimeStatePath, JSON.stringify({
    stackName: 'test-observer',
    processes: { daemonPid: 101, daemonPids: [101] },
    daemon: { distClosureFingerprint: 'old-fingerprint' },
  }));
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => ({ status: 'stopped', pid: null }),
      onObservation: async (daemonState) => await syncStackRuntimeDaemonPidFromDaemonState({
        runtimeStatePath, cliHomeDir: join(root, 'cli'), env: {}, daemonState,
      }, { isPidAliveImpl: () => false }),
      recover: async () => {
        const state = JSON.parse(await readFile(runtimeStatePath, 'utf8'));
        return { started: true, daemonPid: state.processes.daemonPid, daemonPids: state.processes.daemonPids };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );
  try {
    assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
    assert.deepEqual(await reconciler.reconcileNow(), { started: true, daemonPid: null, daemonPids: [] });
  } finally {
    reconciler.close();
  }
});

test('owner daemon observation retains the membership consumer cadence within its single poll', async () => {
  let now = 0;
  const persisted = [];
  const timers = [];
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => ({ status: 'running', pid: now < 10_000 ? 101 : 202 }),
      onObservation: async (observation) => persisted.push(observation.pid),
      onObservationIntervalMs: 10_000,
      recover: async () => { throw new Error('present daemon must not recover'); },
    },
    {
      nowImpl: () => now,
      setIntervalImpl: (fn) => { timers.push(fn); return { unref() {} }; },
      clearIntervalImpl: () => {},
    },
  );
  try {
    await reconciler.reconcileNow();
    now = 1_000;
    await reconciler.reconcileNow();
    assert.deepEqual(persisted, [101]);
    now = 10_000;
    await reconciler.reconcileNow();
    assert.deepEqual(persisted, [101, 202]);
    assert.equal(timers.length, 1, 'membership and recovery share the observation timer');
  } finally {
    reconciler.close();
  }
});

test('auth-gated recovery retains membership observation cadence and never starts the daemon', async () => {
  let now = 0;
  let probes = 0;
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler({
    enabled: true,
    observe: async () => { probes += 1; return { status: 'stopped' }; },
    onObservation: async () => {},
    onObservationIntervalMs: 10_000,
    isRecoveryEnabled: () => false,
    recover: async () => { recoveries += 1; },
  }, {
    nowImpl: () => now,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  try {
    await reconciler.reconcileNow();
    now = 1_000;
    await reconciler.reconcileNow();
    assert.equal(probes, 1);
    assert.equal(recoveries, 0);
    now = 10_000;
    await reconciler.reconcileNow();
    assert.equal(probes, 2);
    assert.equal(recoveries, 0);
  } finally {
    reconciler.close();
  }
});

test('owner daemon reconciliation requires corroborated absence and preserves present or inconclusive state', async () => {
  const observations = [
    { status: 'stopped', pid: null },
    { status: 'running', pid: 16439 },
    { status: 'unreachable', pid: 16439 },
    { status: 'stopped', pid: null },
    { status: 'stopped', pid: null },
  ];
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => observations.shift(),
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-present');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-present');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 1);
  reconciler.close();
});

test('owner daemon reconciliation is single-flight and recovers only once per confirmed absence episode', async () => {
  let releaseObservation;
  let observations = 0;
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => {
        observations += 1;
        if (observations === 1) {
          await new Promise((resolve) => {
            releaseObservation = resolve;
          });
        }
        return { status: 'stopped', pid: null };
      },
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  const first = reconciler.reconcileNow();
  const concurrent = reconciler.reconcileNow();
  await Promise.resolve();
  assert.equal(observations, 1);
  releaseObservation();
  assert.deepEqual(await first, await concurrent);
  assert.equal((await reconciler.reconcileNow()).started, true);
  assert.equal(recoveries, 1);

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-recovery-already-attempted');
  assert.equal(recoveries, 1);

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-recovery-already-attempted');
  assert.equal(recoveries, 1);
  reconciler.close();
});

test('owner daemon reconciliation re-arms recovery after present or inconclusive state', async () => {
  const observations = [
    { status: 'stopped' },
    { status: 'stopped' },
    { status: 'stopped' },
    { status: 'running', pid: 101 },
    { status: 'stopped' },
    { status: 'stopped' },
    { status: 'malformed' },
    { status: 'stopped' },
    { status: 'stopped' },
  ];
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => observations.shift(),
      recover: async () => {
        recoveries += 1;
        return { started: false };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: false });
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-recovery-already-attempted');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-present');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: false });
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-state-inconclusive');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: false });
  assert.equal(recoveries, 3);
  reconciler.close();
});

test('owner daemon reconciliation resets absence proof after malformed or failed observation', async () => {
  const observations = [
    { status: 'stopped' },
    { status: 'malformed' },
    { status: 'stopped' },
    new Error('state read failed'),
    { status: 'stopped' },
    { status: 'stopped' },
  ];
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => {
        const observation = observations.shift();
        if (observation instanceof Error) throw observation;
        return observation;
      },
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
      logger: { warn() {} },
    },
  );

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-state-inconclusive');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.equal((await reconciler.reconcileNow()).reason, 'reconcile-failed');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 1);
  reconciler.close();
});

test('owner daemon reconciliation waits for recovery readiness before counting daemon absence', async () => {
  const recoveryReadiness = [false, false, true, true];
  let recoveries = 0;
  const reconciler = startOwnerDaemonLifecycleReconciler(
    {
      enabled: true,
      observe: async () => ({ status: 'stopped', pid: null }),
      isRecoveryReady: async () => recoveryReadiness.shift(),
      recover: async () => {
        recoveries += 1;
        return { started: true };
      },
    },
    {
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    },
  );

  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-recovery-not-ready');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-recovery-not-ready');
  assert.equal((await reconciler.reconcileNow()).reason, 'daemon-absence-unconfirmed');
  assert.deepEqual(await reconciler.reconcileNow(), { started: true });
  assert.equal(recoveries, 1);
  reconciler.close();
});
