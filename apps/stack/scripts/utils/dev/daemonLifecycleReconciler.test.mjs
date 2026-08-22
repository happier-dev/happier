import test from 'node:test';
import assert from 'node:assert/strict';

import { startOwnerDaemonLifecycleReconciler } from './daemonLifecycleReconciler.mjs';

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
