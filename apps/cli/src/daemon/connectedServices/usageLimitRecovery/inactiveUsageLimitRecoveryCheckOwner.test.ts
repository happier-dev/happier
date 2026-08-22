import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { DurableBackoffRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';
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

it('cancels the session-wide active recovery generation and retires its runner after explicit Stop', async () => {
  const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
  const owner = createInactiveUsageLimitRecoveryCheckOwner();
  const active = recovery('replacement', 2_000, 'runtime-b');
  await owner.schedule({
    sessionId: 'session-stop',
    recovery: active,
    runCheckNow: vi.fn(async () => ({ status: 'waiting' })),
    scheduler,
  });

  await expect(owner.cancelSession({
    sessionId: 'session-stop',
    scheduler,
  })).resolves.toMatchObject({
    status: 'cancelled',
    issueFingerprint: 'replacement',
    runtimeAuthRecoveryAttemptId: 'runtime-b',
    nextCheckAtMs: null,
  });
  expect(owner.hasRunner('session-stop')).toBe(false);
});

it('preserves B runner when B commits after A observation and removes it only after exact B cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-cancel-cas-'));
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
    const cancelStore: DurableBackoffRecoveryStore<SessionUsageLimitRecoveryV1> = {
      ...durableStore,
      transact: async (sessionId, transaction) => {
        markCancelTransactionStarted();
        await cancelTransactionRelease;
        return await durableStore.transact!(sessionId, transaction);
      },
    };
    const schedulerA = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: cancelStore });
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
    await owner.schedule({
      sessionId: 'session-race',
      recovery: attemptB,
      runCheckNow: runB,
      scheduler: schedulerB,
    });
    releaseCancelTransaction();

    await expect(cancelA).resolves.toMatchObject({
      status: 'superseded',
      intent: { issueFingerprint: 'attempt-b', armedAtMs: 1_001, status: 'waiting' },
    });
    expect(owner.hasRunner('session-race')).toBe(true);
    await owner.run('session-race');
    expect(runB).toHaveBeenCalledTimes(1);

    await expect(owner.cancelExact({
      sessionId: 'session-race',
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      scheduler: schedulerB,
    })).resolves.toMatchObject({ status: 'cancelled' });
    expect(owner.hasRunner('session-race')).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps current runtime B and its runner when delayed runtime A has the same usage tuple', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-runtime-identity-'));
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

    await owner.schedule({ sessionId: 'session-runtime', recovery: runtimeB, runCheckNow: runB, scheduler });
    await owner.schedule({ sessionId: 'session-runtime', recovery: delayedRuntimeA, runCheckNow: runA, scheduler });
    expect(scheduler.read('session-runtime')).toMatchObject(runtimeB);

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
    await rm(root, { recursive: true, force: true });
  }
});

it('does not republish or execute B after another scheduler cancels it during delayed completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-authoritative-settlement-'));
  try {
    const filePath = join(root, 'recovery.json');
    const scheduleStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath);
    const cancellationStore = createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath);
    let markCommitted!: () => void;
    const committed = new Promise<void>((resolve) => { markCommitted = resolve; });
    let releaseCompletion!: () => void;
    const completionRelease = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const delayedStore: DurableBackoffRecoveryStore<SessionUsageLimitRecoveryV1> = {
      ...scheduleStore,
      transact: async (sessionId, transaction) => {
        const result = await scheduleStore.transact!(sessionId, transaction);
        markCommitted();
        await completionRelease;
        return result;
      },
    };
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    const schedulingScheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: delayedStore,
      recover: async (intent, { sessionId }) => {
        await owner.run(sessionId);
        return {
          status: 'wait',
          nextCheckAtMs: intent.nextCheckAtMs ?? intent.resetAtMs ?? 7_000,
        };
      },
    });
    const cancellingScheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: cancellationStore });
    const runtimeB = recovery('attempt-b', 1_001, 'runtime-b');
    const runB = vi.fn(async () => ({ status: 'wait' }));

    const schedule = owner.schedule({
      sessionId: 'session-settlement',
      recovery: runtimeB,
      runCheckNow: runB,
      scheduler: schedulingScheduler,
    });
    await committed;
    await expect(cancellingScheduler.cancelExact({
      sessionId: 'session-settlement',
      issueFingerprint: runtimeB.issueFingerprint,
      armedAtMs: runtimeB.armedAtMs,
      runtimeAuthRecoveryAttemptId: runtimeB.runtimeAuthRecoveryAttemptId,
    })).resolves.toMatchObject({ status: 'cancelled' });

    releaseCompletion();
    await schedule;

    expect(owner.hasRunner('session-settlement')).toBe(false);
    await expect(schedulingScheduler.wake({
      sessionId: 'session-settlement',
      reason: 'check_now',
    })).resolves.toEqual({ status: 'inactive' });
    expect(runB).not.toHaveBeenCalled();
    expect(cancellationStore.read('session-settlement')).toMatchObject({
      status: 'cancelled',
      runtimeAuthRecoveryAttemptId: 'runtime-b',
      attemptCount: 0,
      nextCheckAtMs: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not resurrect an exact cancellation from another scheduler while recovery is in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-inflight-cancel-'));
  try {
    const filePath = join(root, 'recovery.json');
    const owner = createInactiveUsageLimitRecoveryCheckOwner();
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => { markRecoveryStarted = resolve; });
    let releaseRecovery!: () => void;
    const recoveryRelease = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const schedulingScheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath),
      recover: async (intent) => {
        markRecoveryStarted();
        await recoveryRelease;
        return { status: 'wait', nextCheckAtMs: 7_000, intent };
      },
    });
    const cancellingScheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_000,
      store: createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath),
    });
    const runtimeB = recovery('same-usage', 1_000, 'runtime-b');
    const runB = vi.fn(async () => ({ status: 'wait' }));
    await owner.schedule({
      sessionId: 'session-inflight',
      recovery: runtimeB,
      runCheckNow: runB,
      scheduler: schedulingScheduler,
    });

    const wake = schedulingScheduler.wake({ sessionId: 'session-inflight', reason: 'check_now' });
    await recoveryStarted;
    await expect(owner.cancelExact({
      sessionId: 'session-inflight',
      issueFingerprint: runtimeB.issueFingerprint,
      armedAtMs: runtimeB.armedAtMs,
      runtimeAuthRecoveryAttemptId: runtimeB.runtimeAuthRecoveryAttemptId,
      scheduler: cancellingScheduler,
    })).resolves.toMatchObject({ status: 'cancelled' });
    releaseRecovery();

    await expect(wake).resolves.toEqual({ status: 'inactive' });
    expect(owner.hasRunner('session-inflight')).toBe(false);
    expect(runB).not.toHaveBeenCalled();
    expect(createRecoveryIntentFileStore<SessionUsageLimitRecoveryV1>(filePath).readAuthoritative?.('session-inflight'))
      .toMatchObject({ status: 'cancelled', runtimeAuthRecoveryAttemptId: 'runtime-b', nextCheckAtMs: null });
    await expect(schedulingScheduler.wake({ sessionId: 'session-inflight', reason: 'check_now' }))
      .resolves.toEqual({ status: 'inactive' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains newer B when delayed lower-epoch or equal-epoch distinct schedules arrive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-stale-schedule-'));
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

    await owner.schedule({ sessionId: 'session-race', recovery: attemptB, runCheckNow: runB, scheduler });
    await owner.schedule({ sessionId: 'session-race', recovery: attemptA, runCheckNow: runA, scheduler });
    expect(scheduler.read('session-race')).toMatchObject(attemptB);
    await owner.schedule({ sessionId: 'session-race', recovery: ambiguousC, runCheckNow: runC, scheduler });
    expect(scheduler.read('session-race')).toMatchObject(attemptB);

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
    await rm(root, { recursive: true, force: true });
  }
});

it('merges same-identity progress and refreshes its runner through the real file store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-inactive-usage-progress-schedule-'));
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
        transact: async (sessionId, transaction) => {
          const committed = await durableStore.transact!(sessionId, transaction);
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

    const initialSchedule = owner.schedule({
      sessionId: 'session-progress',
      recovery: attemptB,
      runCheckNow: runInitialB,
      scheduler: initialScheduler,
    });
    await initialCommitted;
    await owner.schedule({
      sessionId: 'session-progress',
      recovery: progressedB,
      runCheckNow: runProgressedB,
      scheduler: progressedScheduler,
    });
    expect(progressedScheduler.read('session-progress')).toMatchObject({
      issueFingerprint: attemptB.issueFingerprint,
      armedAtMs: attemptB.armedAtMs,
      attemptCount: 2,
      nextCheckAtMs: 7_000,
      maxAttempts: 2,
    });
    releaseInitialCompletion();
    await initialSchedule;

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
    await rm(root, { recursive: true, force: true });
  }
});
