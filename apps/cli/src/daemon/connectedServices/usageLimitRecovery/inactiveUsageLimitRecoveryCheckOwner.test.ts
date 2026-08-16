import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import { UsageLimitRecoveryScheduler } from './UsageLimitRecoveryScheduler';
import { createInactiveUsageLimitRecoveryCheckOwner } from './inactiveUsageLimitRecoveryCheckOwner';

function recovery(
  issueFingerprint: string,
  armedAtMs: number,
  runtimeAuthRecoveryAttemptId?: string,
): SessionUsageLimitRecoveryV1 {
  return {
    v: 1,
    status: 'waiting',
    issueFingerprint,
    armedAtMs,
    resetAtMs: 5_000,
    nextCheckAtMs: 5_000,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: 'standard',
    selectedAuth: { kind: 'native' },
    ...(runtimeAuthRecoveryAttemptId ? { runtimeAuthRecoveryAttemptId } : {}),
  };
}

it('cancels the current session recovery and removes its runnable check after explicit Stop', async () => {
  const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
  const owner = createInactiveUsageLimitRecoveryCheckOwner();
  const current = recovery('usage-limit:stop', 1_000);
  await scheduler.upsert({ sessionId: 'session-stop', intent: current });
  owner.observe({
    sessionId: 'session-stop',
    recovery: current,
    runCheckNow: async () => ({ ok: true }),
  });

  await expect(owner.cancelSession({
    sessionId: 'session-stop',
    scheduler,
  })).resolves.toMatchObject({ status: 'cancelled', nextCheckAtMs: null });
  expect(owner.hasRunner('session-stop')).toBe(false);
});

it('keeps attempt B runner ownership when its real file-store write races exact cancellation of A', async () => {
  const root = await createTempDir('inactive-usage-limit-owner-race-');
  try {
    const filePath = join(root, 'recovery.json');
    const durableStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath);
    const schedulerA = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: durableStore });
    const attemptA = recovery('attempt-a', 1_000);
    const attemptB = recovery('attempt-b', 1_001);
    await schedulerA.upsert({ sessionId: 'session-race', intent: attemptA });

    let releaseBWrite!: () => void;
    const bWriteRelease = new Promise<void>((resolve) => { releaseBWrite = resolve; });
    let markBWriteStarted!: () => void;
    const bWriteStarted = new Promise<void>((resolve) => { markBWriteStarted = resolve; });
    const schedulerB = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: {
        ...durableStore,
        merge: async (sessionId, intent, merge) => {
          markBWriteStarted();
          await bWriteRelease;
          return await durableStore.merge!(sessionId, intent, merge);
        },
      },
    });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const runB = vi.fn(async () => ({ ok: true }));
    owner.schedule({
      sessionId: 'session-race',
      recovery: attemptB,
      runCheckNow: runB,
      scheduler: schedulerB,
      onPersistenceError: (error) => { throw error; },
    });
    await bWriteStarted;

    const cancelledA = await owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptA.issueFingerprint,
      armedAtMs: attemptA.armedAtMs,
      scheduler: schedulerA,
    });
    expect(cancelledA.status).toBe('cancelled');

    releaseBWrite();
    await vi.waitFor(() => {
      expect(schedulerA.read('session-race')).toMatchObject({
        issueFingerprint: 'attempt-b',
        armedAtMs: 1_001,
        status: 'waiting',
      });
    });
    await vi.waitFor(() => expect(owner.hasRunner('session-race')).toBe(true));
    await owner.run('session-race');
    expect(runB).toHaveBeenCalledTimes(1);

    await expect(owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      scheduler: schedulerA,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(owner.hasRunner('session-race')).toBe(false);
  } finally {
    await removeTempDir(root);
  }
});

it('keeps current runtime B and its runner when delayed runtime A has the same usage tuple', async () => {
  const root = await createTempDir('inactive-usage-limit-owner-runtime-identity-');
  try {
    const durableStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(join(root, 'recovery.json'));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: durableStore });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const runtimeB = recovery('same-usage', 1_001, 'runtime-b');
    const delayedRuntimeA: SessionUsageLimitRecoveryV1 = {
      ...recovery('same-usage', 1_001, 'runtime-a'),
      attemptCount: 2,
      nextCheckAtMs: 7_000,
      maxAttempts: 2,
    };
    const runB = vi.fn(async () => ({ attempt: 'b' }));
    const runA = vi.fn(async () => ({ attempt: 'a' }));
    const onPersistenceError = (error: unknown) => { throw error; };

    owner.schedule({ sessionId: 'session-runtime', recovery: runtimeB, runCheckNow: runB, scheduler, onPersistenceError });
    await vi.waitFor(() => expect(scheduler.read('session-runtime')).toMatchObject(runtimeB));
    await vi.waitFor(() => expect(owner.hasRunner('session-runtime')).toBe(true));

    owner.schedule({
      sessionId: 'session-runtime',
      recovery: delayedRuntimeA,
      runCheckNow: runA,
      scheduler,
      onPersistenceError,
    });
    await vi.waitFor(() => expect(scheduler.read('session-runtime')).toMatchObject(runtimeB));

    await expect(owner.cancelExact({
      sessionId: 'session-runtime',
      issueFingerprint: delayedRuntimeA.issueFingerprint,
      armedAtMs: delayedRuntimeA.armedAtMs,
      runtimeAuthRecoveryAttemptId: delayedRuntimeA.runtimeAuthRecoveryAttemptId,
      scheduler,
    })).resolves.toMatchObject({ status: 'superseded' });
    expect(owner.hasRunner('session-runtime')).toBe(true);

    await owner.run('session-runtime');
    expect(runA).not.toHaveBeenCalled();
    expect(runB).toHaveBeenCalledTimes(1);

    await expect(owner.cancelExact({
      sessionId: 'session-runtime',
      issueFingerprint: runtimeB.issueFingerprint,
      armedAtMs: runtimeB.armedAtMs,
      runtimeAuthRecoveryAttemptId: runtimeB.runtimeAuthRecoveryAttemptId,
      scheduler,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(owner.hasRunner('session-runtime')).toBe(false);
  } finally {
    await removeTempDir(root);
  }
});

it('returns superseded and preserves B runner when B commits after A observation but before A file-store transaction', async () => {
  const root = await createTempDir('inactive-usage-limit-owner-cancel-cas-');
  try {
    const filePath = join(root, 'recovery.json');
    const durableStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath);
    const attemptA = recovery('attempt-a', 1_000);
    const attemptB = recovery('attempt-b', 1_001);
    await durableStore.write('session-race', attemptA);

    let releaseCancelTransaction!: () => void;
    const cancelTransactionRelease = new Promise<void>((resolve) => { releaseCancelTransaction = resolve; });
    let markCancelTransactionStarted!: () => void;
    const cancelTransactionStarted = new Promise<void>((resolve) => { markCancelTransactionStarted = resolve; });
    const cancelStore = {
      ...durableStore,
      transact: async (
        sessionId: string,
        transaction: Parameters<NonNullable<typeof durableStore.transact>>[1],
      ) => {
        markCancelTransactionStarted();
        await cancelTransactionRelease;
        return await durableStore.transact!(sessionId, transaction);
      },
    };
    const schedulerA = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: cancelStore,
    });
    const schedulerB = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: durableStore });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const cancelA = owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptA.issueFingerprint,
      armedAtMs: attemptA.armedAtMs,
      scheduler: schedulerA,
    });
    await cancelTransactionStarted;

    const runB = vi.fn(async () => ({ ok: true }));
    owner.schedule({
      sessionId: 'session-race',
      recovery: attemptB,
      runCheckNow: runB,
      scheduler: schedulerB,
      onPersistenceError: (error) => { throw error; },
    });
    await vi.waitFor(() => {
      expect(schedulerB.read('session-race')).toMatchObject({ issueFingerprint: 'attempt-b', armedAtMs: 1_001 });
    });
    releaseCancelTransaction();

    await expect(cancelA).resolves.toMatchObject({
      status: 'superseded',
      intent: { issueFingerprint: 'attempt-b', armedAtMs: 1_001, status: 'waiting' },
    });
    expect(owner.hasRunner('session-race')).toBe(true);
    await owner.run('session-race');
    expect(runB).toHaveBeenCalledTimes(1);
  } finally {
    await removeTempDir(root);
  }
});

it('retains newer B when delayed lower-epoch or equal-epoch distinct schedules arrive', async () => {
  const root = await createTempDir('inactive-usage-limit-owner-stale-schedule-');
  try {
    const durableStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(join(root, 'recovery.json'));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: durableStore });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const attemptA = recovery('attempt-a', 1_000);
    const attemptB = recovery('attempt-b', 1_001);
    const ambiguousC = recovery('attempt-c', 1_001);
    const runA = vi.fn(async () => ({ attempt: 'a' }));
    const runB = vi.fn(async () => ({ attempt: 'b' }));
    const runC = vi.fn(async () => ({ attempt: 'c' }));
    const onPersistenceError = (error: unknown) => { throw error; };

    owner.schedule({ sessionId: 'session-race', recovery: attemptB, runCheckNow: runB, scheduler, onPersistenceError });
    await vi.waitFor(() => expect(scheduler.read('session-race')).toMatchObject(attemptB));

    owner.schedule({ sessionId: 'session-race', recovery: attemptA, runCheckNow: runA, scheduler, onPersistenceError });
    owner.schedule({ sessionId: 'session-race', recovery: ambiguousC, runCheckNow: runC, scheduler, onPersistenceError });
    await vi.waitFor(() => expect(scheduler.read('session-race')).toMatchObject(attemptB));

    await expect(owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptA.issueFingerprint,
      armedAtMs: attemptA.armedAtMs,
      scheduler,
    })).resolves.toMatchObject({
      status: 'superseded',
      intent: { issueFingerprint: attemptB.issueFingerprint, armedAtMs: attemptB.armedAtMs, status: 'waiting' },
    });
    expect(owner.hasRunner('session-race')).toBe(true);

    await owner.run('session-race');
    expect(runA).not.toHaveBeenCalled();
    expect(runB).toHaveBeenCalledTimes(1);
    expect(runC).not.toHaveBeenCalled();

    await expect(owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      scheduler,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(owner.hasRunner('session-race')).toBe(false);
  } finally {
    await removeTempDir(root);
  }
});

it('merges same-identity progress and refreshes its runner through the real file store', async () => {
  const root = await createTempDir('inactive-usage-limit-owner-progress-schedule-');
  try {
    const durableStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(join(root, 'recovery.json'));
    let releaseInitialCompletion!: () => void;
    const initialCompletionRelease = new Promise<void>((resolve) => { releaseInitialCompletion = resolve; });
    let markInitialCommitted!: () => void;
    const initialCommitted = new Promise<void>((resolve) => { markInitialCommitted = resolve; });
    const initialScheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: {
        ...durableStore,
        merge: async (sessionId, intent, merge) => {
          const committed = await durableStore.merge!(sessionId, intent, merge);
          markInitialCommitted();
          await initialCompletionRelease;
          return committed;
        },
      },
    });
    const progressedScheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: durableStore });
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const attemptB = recovery('attempt-b', 1_001, 'runtime-b');
    const progressedB: SessionUsageLimitRecoveryV1 = {
      ...attemptB,
      attemptCount: 2,
      nextCheckAtMs: 7_000,
      maxAttempts: 2,
    };
    const runInitialB = vi.fn(async () => ({ attempt: 'initial-b' }));
    const runProgressedB = vi.fn(async () => ({ attempt: 'progressed-b' }));
    const onPersistenceError = (error: unknown) => { throw error; };

    owner.schedule({
      sessionId: 'session-progress',
      recovery: attemptB,
      runCheckNow: runInitialB,
      scheduler: initialScheduler,
      onPersistenceError,
    });
    await initialCommitted;

    owner.schedule({
      sessionId: 'session-progress',
      recovery: progressedB,
      runCheckNow: runProgressedB,
      scheduler: progressedScheduler,
      onPersistenceError,
    });
    await vi.waitFor(() => expect(progressedScheduler.read('session-progress')).toMatchObject({
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      attemptCount: 2,
      nextCheckAtMs: 7_000,
      maxAttempts: 2,
    }));
    releaseInitialCompletion();
    await vi.waitFor(() => expect(owner.hasRunner('session-progress')).toBe(true));

    await owner.run('session-progress');
    expect(runInitialB).not.toHaveBeenCalled();
    expect(runProgressedB).toHaveBeenCalledTimes(1);

    await expect(owner.cancelExact({
      sessionId: 'session-progress',
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      ...(attemptB.runtimeAuthRecoveryAttemptId
        ? { runtimeAuthRecoveryAttemptId: attemptB.runtimeAuthRecoveryAttemptId }
        : {}),
      scheduler: progressedScheduler,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(owner.hasRunner('session-progress')).toBe(false);
  } finally {
    await removeTempDir(root);
  }
});
