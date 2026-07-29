import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryAuthSelectionV1,
} from '@happier-dev/protocol';

import {
  METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY,
  RUNTIME_USAGE_LIMIT_RECOVERY_FIELD,
  UsageLimitRecoveryScheduler,
  type UsageLimitRecoveryIntent,
} from './UsageLimitRecoveryScheduler';
import { createUsageLimitRecoveryWakeGate } from './usageLimitRecoveryWakeGate';
import { createRecoveryIntentFileStore } from '../recoveryScheduler/recoveryIntentFileStore';
import type { DurableBackoffRecoveryStore } from '../recoveryScheduler/DurableBackoffRecoveryScheduler';

describe('UsageLimitRecoveryScheduler', () => {
  it('hydrates persisted state passively until an explicit current-generation check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const persisted = {
      v: 1 as const,
      issueFingerprint: 'persisted-limit',
      status: 'waiting' as const,
      resumePromptMode: 'standard' as const,
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' as const },
    };
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      store: {
        read: () => persisted,
        readAll: () => [['session-1', persisted] as const],
        write: vi.fn(),
      },
      recover,
    });

    expect(scheduler.hydratePassive()).toEqual([persisted]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).not.toHaveBeenCalled();
    await scheduler.wake({ sessionId: 'session-1', reason: 'check_now' });
    expect(recover).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores one active intent per session and supersedes older intents', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'old',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
    });
    const intent = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'new',
      resetAtMs: 3_000,
      selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
    });

    expect(intent.issueFingerprint).toBe('new');
    expect(scheduler.read('session-1')?.resetAtMs).toBe(3_000);
    expect(RUNTIME_USAGE_LIMIT_RECOVERY_FIELD).toBe(SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID);
    expect(METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY).toBe(SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY);
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(intent).success).toBe(true);
  });

  it('allocates a strictly newer epoch for a fresh issue when the clock has not advanced', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'cancelled',
        resumePromptMode: 'standard',
        issueFingerprint: 'issue-z',
        armedAtMs: 1_000,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });
    const fresh = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'issue-a',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    expect(fresh).toMatchObject({ issueFingerprint: 'issue-a', armedAtMs: 1_001, status: 'waiting' });
  });

  it.each([
    ['issue-a', 'issue-b'],
    ['issue-b', 'issue-a'],
  ] as const)('allocates same-millisecond epochs at the shared CAS owner (%s then %s)', async (firstIssue, secondIssue) => {
    const values = new Map<string, UsageLimitRecoveryIntent>();
    const store = {
      read: (sessionId: string) => values.get(sessionId) ?? null,
      readAll: () => [...values.entries()] as ReadonlyArray<readonly [string, unknown]>,
      write: (sessionId: string, intent: UsageLimitRecoveryIntent) => { values.set(sessionId, intent); },
      merge: (
        sessionId: string,
        next: UsageLimitRecoveryIntent,
        merge: (previous: UsageLimitRecoveryIntent | null, candidate: UsageLimitRecoveryIntent) => UsageLimitRecoveryIntent,
      ) => {
        const merged = merge(values.get(sessionId) ?? null, next);
        values.set(sessionId, merged);
        return merged;
      },
    };
    const first = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    const second = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });

    const older = await first.enable({
      sessionId: 'session-shared',
      issueFingerprint: firstIssue,
      resetAtMs: 5_000,
      selectedAuth: { kind: 'native' },
    });
    const newer = await second.enable({
      sessionId: 'session-shared',
      issueFingerprint: secondIssue,
      resetAtMs: 6_000,
      selectedAuth: { kind: 'native' },
    });

    expect(older.armedAtMs).toBe(1_000);
    expect(newer).toMatchObject({ issueFingerprint: secondIssue, armedAtMs: 1_001 });
    const replacement = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    expect(replacement.hydratePassive()).toEqual([
      expect.objectContaining({ issueFingerprint: secondIssue, armedAtMs: 1_001 }),
    ]);
  });

  it('serializes concurrent same-millisecond rearm merges through the production file-store transaction and survives restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-usage-recovery-cas-'));
    try {
      const filePath = join(dir, 'intents.json');
      const seedStore = createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath);
      await seedStore.write('session-shared', {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'base',
        armedAtMs: 999,
        resetAtMs: 5_000,
        nextCheckAtMs: 5_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      });
      const newer = new UsageLimitRecoveryScheduler({
        nowMs: () => 1_000,
        store: createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath),
      });
      let newerPromise: Promise<UsageLimitRecoveryIntent> | null = null;
      const olderDurableStore = createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath);
      const olderStore: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent> = {
        ...olderDurableStore,
        transact: async (sessionId, transaction) => await olderDurableStore.transact!(sessionId, (current) => {
          const result = transaction(current);
          newerPromise ??= newer.enable({
            sessionId: 'session-shared',
            issueFingerprint: 'a-newer',
            resetAtMs: 7_000,
            selectedAuth: { kind: 'native' },
          });
          return result;
        }),
      };
      const older = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: olderStore });

      const olderResult = await older.enable({
        sessionId: 'session-shared',
        issueFingerprint: 'z-older',
        resetAtMs: 6_000,
        selectedAuth: { kind: 'native' },
      });
      const startedNewerPromise = newerPromise;
      if (!startedNewerPromise) throw new Error('newer production transaction was not started while the older lock was held');
      const newerResult = await startedNewerPromise;

      expect(olderResult).toMatchObject({ issueFingerprint: 'z-older', armedAtMs: 1_000 });
      expect(newerResult).toMatchObject({ issueFingerprint: 'a-newer', armedAtMs: 1_001 });
      const replacement = new UsageLimitRecoveryScheduler({
        nowMs: () => 1_000,
        store: createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath),
      });
      expect(replacement.hydratePassive()).toEqual([
        expect.objectContaining({ issueFingerprint: 'a-newer', armedAtMs: 1_001 }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns superseded when B commits after A observation but before the exact-cancel transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-usage-recovery-cancel-cas-'));
    try {
      const filePath = join(dir, 'intents.json');
      const durableStore = createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath);
      const attemptA: UsageLimitRecoveryIntent = {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'attempt-a',
        armedAtMs: 1_000,
        resetAtMs: 5_000,
        nextCheckAtMs: 5_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      };
      await durableStore.write('session-race', attemptA);
      let markCancelPersistenceStarted!: () => void;
      const cancelPersistenceStarted = new Promise<void>((resolve) => { markCancelPersistenceStarted = resolve; });
      let releaseCancelPersistence!: () => void;
      const cancelPersistenceRelease = new Promise<void>((resolve) => { releaseCancelPersistence = resolve; });
      const cancelStore: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent> = {
        ...durableStore,
        write: async (sessionId: string, intent: UsageLimitRecoveryIntent) => {
          markCancelPersistenceStarted();
          await cancelPersistenceRelease;
          await durableStore.write(sessionId, intent);
        },
        transact: async (sessionId, transaction) => {
          markCancelPersistenceStarted();
          await cancelPersistenceRelease;
          return await durableStore.transact!(sessionId, transaction);
        },
      };
      const cancelling = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store: cancelStore });
      const rearming = new UsageLimitRecoveryScheduler({
        nowMs: () => 1_001,
        store: createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath),
      });

      const cancelA = cancelling.cancelExact({
        sessionId: 'session-race',
        issueFingerprint: attemptA.issueFingerprint,
        armedAtMs: attemptA.armedAtMs,
      });
      await cancelPersistenceStarted;
      const attemptB = await rearming.enable({
        sessionId: 'session-race',
        issueFingerprint: 'attempt-b',
        resetAtMs: 6_000,
        selectedAuth: { kind: 'native' },
      });
      releaseCancelPersistence();

      await expect(cancelA).resolves.toMatchObject({
        status: 'superseded',
        intent: { issueFingerprint: attemptB.issueFingerprint, armedAtMs: attemptB.armedAtMs },
      });
      expect(createRecoveryIntentFileStore<UsageLimitRecoveryIntent>(filePath).read('session-race')).toMatchObject({
        status: 'waiting',
        issueFingerprint: 'attempt-b',
        armedAtMs: attemptB.armedAtMs,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('coalesces independent same-fingerprint controllers into one same-millisecond epoch', async () => {
    const values = new Map<string, UsageLimitRecoveryIntent>();
    const store = {
      read: (sessionId: string) => values.get(sessionId) ?? null,
      write: (sessionId: string, intent: UsageLimitRecoveryIntent) => { values.set(sessionId, intent); },
      merge: (
        sessionId: string,
        next: UsageLimitRecoveryIntent,
        merge: (previous: UsageLimitRecoveryIntent | null, candidate: UsageLimitRecoveryIntent) => UsageLimitRecoveryIntent,
      ) => {
        const merged = merge(values.get(sessionId) ?? null, next);
        values.set(sessionId, merged);
        return merged;
      },
    };
    const first = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    const second = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    const [left, right] = await Promise.all([
      first.enable({ sessionId: 'session-shared', issueFingerprint: 'same', resetAtMs: 5_000, selectedAuth: { kind: 'native' } }),
      second.enable({ sessionId: 'session-shared', issueFingerprint: 'same', resetAtMs: 5_000, selectedAuth: { kind: 'native' } }),
    ]);
    expect(left.armedAtMs).toBe(1_000);
    expect(right.armedAtMs).toBe(1_000);
  });

  it('preserves attemptCount on same-fingerprint re-arm instead of resetting to 0', async () => {
    const stored = new Map<string, unknown>([
      ['session-1', {
        v: 1,
        issueFingerprint: 'limit',
        status: 'waiting',
        resumePromptMode: 'standard',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 2,
        maxAttempts: 3,
        lastProbeError: 'still_exhausted',
        selectedAuth: { kind: 'native' },
      }],
    ]);
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      readAll: () => [...stored.entries()],
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
    };
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_500, store });

    const reArmed = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 5_000,
      selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'backup' },
    });

    // Same fingerprint resurfacing must not restart the lifecycle at attempt 0.
    expect(reArmed.attemptCount).toBe(2);
    expect(reArmed.status).toBe('waiting');
    // Latest selection is adopted; next-check takes the earlier of the two.
    expect(reArmed.selectedAuth).toMatchObject({ kind: 'profile', profileId: 'backup' });
    expect(reArmed.nextCheckAtMs).toBe(2_000);
    expect(scheduler.read('session-1')?.attemptCount).toBe(2);
  });

  it('does not resurrect a cancelled or exhausted recovery on same-fingerprint re-arm', async () => {
    const stored = new Map<string, unknown>([
      ['session-1', {
        v: 1,
        issueFingerprint: 'limit',
        status: 'exhausted',
        resumePromptMode: 'standard',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        selectedAuth: { kind: 'native' },
      }],
    ]);
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      readAll: () => [...stored.entries()],
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
    };
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_500, store });

    const reArmed = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 5_000,
      selectedAuth: { kind: 'native' },
    });

    expect(reArmed.status).toBe('exhausted');
    expect(reArmed.attemptCount).toBe(3);
  });

  it('allocates a newer epoch when explicitly re-arming a paused same-fingerprint attempt', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-paused',
      intent: {
        v: 1,
        issueFingerprint: 'limit',
        status: 'paused',
        resumePromptMode: 'standard',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: null,
        attemptCount: 2,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });
    const rearmed = await scheduler.enable({
      sessionId: 'session-paused',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    expect(rearmed).toMatchObject({ status: 'waiting', armedAtMs: 1_001, attemptCount: 0 });
  });

  it.each([
    { requested: 1, expected: 1 },
    { requested: 0, expected: 3 },
  ])('keeps zero-aware stricter same-attempt cap for requested $requested', async ({ requested, expected }) => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.enable({
      sessionId: 'session-cap',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      maxAttempts: 3,
      selectedAuth: { kind: 'native' },
    });
    const rearmed = await scheduler.enable({
      sessionId: 'session-cap',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      maxAttempts: requested,
      selectedAuth: { kind: 'native' },
    });
    expect(rearmed.maxAttempts).toBe(expected);
  });

  it('cancels active intents', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'issue',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await scheduler.cancel({ sessionId: 'session-1' });

    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('re-runs group recovery on wake instead of retrying the old profile directly', async () => {
    const selectedProfiles: string[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async (intent) => {
        if (intent.selectedAuth.kind !== 'group') throw new Error('expected group intent');
        if (intent.selectedAuth.profileId === null) throw new Error('expected selected group profile');
        selectedProfiles.push(intent.selectedAuth.profileId);
        return {
          status: 'ready',
          selectedAuth: {
            ...intent.selectedAuth,
            profileId: 'fresh-member',
          },
        };
      },
      resume: async () => {},
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'old-member',
      },
    });

    const result = await scheduler.wake({ sessionId: 'session-1', reason: 'timer' });

    expect(result.status).toBe('resumed');
    expect(selectedProfiles).toEqual(['old-member']);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
    expect(scheduler.read('session-1')?.selectedAuth).toMatchObject({
      kind: 'group',
      profileId: 'fresh-member',
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(scheduler.read('session-1')).success).toBe(true);
  });

  it('persists an updated selected auth when recovery must wait for the new candidate', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async (intent) => {
        if (intent.selectedAuth.kind !== 'group') throw new Error('expected group intent');
        return {
          status: 'wait',
          nextCheckAtMs: 2_500,
          selectedAuth: {
            ...intent.selectedAuth,
            profileId: 'fresh-member',
          },
        };
      },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'old-member',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      nextCheckAtMs: 2_500,
      selectedAuth: {
        kind: 'group',
        profileId: 'fresh-member',
      },
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(scheduler.read('session-1')).success).toBe(true);
  });

  it('records a daemon restart diagnostic before resuming usage-limit recovery', async () => {
    const records: unknown[] = [];
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'ready' as const }),
      resume,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'resumed',
    });

    expect(resume).toHaveBeenCalledOnce();
    expect(records).toEqual([{
      type: 'connected_service_daemon_restart',
      trigger: 'usage_limit_recovery',
      status: 'requested',
      sessionId: 'session-1',
      agentId: null,
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      generation: null,
      reason: 'limit',
      pid: null,
      processGroupPid: null,
      delayMs: null,
      atMs: 2_000,
    }]);
  });

  it('O4: populates agentId in the restart diagnostic when resolveAgentId is provided', async () => {
    const records: unknown[] = [];
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'ready' as const }),
      resume,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      resolveAgentId: () => 'codex',
    });
    await scheduler.enable({
      sessionId: 'session-codex',
      issueFingerprint: 'quota',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-codex', reason: 'timer' })).resolves.toEqual({
      status: 'resumed',
    });

    expect(resume).toHaveBeenCalledOnce();
    expect(records).toEqual([{
      type: 'connected_service_daemon_restart',
      trigger: 'usage_limit_recovery',
      status: 'requested',
      sessionId: 'session-codex',
      agentId: 'codex',
      serviceId: 'openai-codex',
      profileId: 'primary',
      groupId: 'main',
      generation: null,
      reason: 'quota',
      pid: null,
      processGroupPid: null,
      delayMs: null,
      atMs: 2_000,
    }]);
  });

  it('can restore an active intent from a durable store', async () => {
    const stored = new Map<string, unknown>();
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
    };
    const first = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    await first.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    const second = new UsageLimitRecoveryScheduler({ nowMs: () => 1_500, store });

    expect(second.read('session-1')?.issueFingerprint).toBe('limit');
  });

  it('delays missing check runners without burning attempts', async () => {
    let nowMs = 2_000;
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      gate: createUsageLimitRecoveryWakeGate({
        nowMs: () => nowMs,
        hasRunner: () => false,
        runnerUnavailableRetryDelayMs: 60_000,
      }),
      recover: async () => {
        throw new Error('runner should not be called while unavailable');
      },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 62_000,
      lastProbeError: 'usage_limit_recovery_check_runner_unavailable',
    });
  });

  it('coalesces same-auth wake storms after restart', async () => {
    let nowMs = 2_000;
    const gate = createUsageLimitRecoveryWakeGate({
      nowMs: () => nowMs,
      hasRunner: () => true,
      coalesceWindowMs: 1_000,
    });
    const recoveries: string[] = [];
    const createScheduler = () => new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      gate,
      recover: async (_intent, context) => {
        recoveries.push(context.sessionId);
        return { status: 'wait', nextCheckAtMs: nowMs + 10_000 };
      },
    });
    const first = createScheduler();
    const second = createScheduler();
    const selectedAuth = {
      kind: 'group' as const,
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    } satisfies SessionUsageLimitRecoveryAuthSelectionV1;
    await first.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-a',
      resetAtMs: 2_000,
      selectedAuth,
    });
    await second.enable({
      sessionId: 'session-2',
      issueFingerprint: 'limit-b',
      resetAtMs: 2_000,
      selectedAuth,
    });

    await expect(first.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(second.wake({ sessionId: 'session-2', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(recoveries).toEqual(['session-1']);
    expect(second.read('session-2')).toMatchObject({
      attemptCount: 0,
      nextCheckAtMs: 3_000,
      lastProbeError: 'usage_limit_recovery_wake_coalesced',
    });
  });

  it('prunes stale terminal durable intents when scheduling new usage-limit recovery', async () => {
    const nowMs = 8 * 24 * 60 * 60_000;
    const stored = new Map<string, unknown>([
      ['old-cancelled', {
        v: 1,
        issueFingerprint: 'old-limit',
        status: 'cancelled',
        resumePromptMode: 'standard',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      }],
      ['fresh-exhausted', {
        v: 1,
        issueFingerprint: 'fresh-limit',
        status: 'exhausted',
        resumePromptMode: 'standard',
        armedAtMs: nowMs - 1_000,
        resetAtMs: nowMs - 500,
        nextCheckAtMs: nowMs - 500,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        selectedAuth: { kind: 'native' },
      }],
    ]);
    const pruned: string[] = [];
    const store = {
      read: (sessionId: string) => stored.get(sessionId) ?? null,
      readAll: () => [...stored.entries()],
      write: (sessionId: string, intent: unknown) => {
        stored.set(sessionId, intent);
      },
      prune: (predicate: (entry: Readonly<{ sessionId: string; value: unknown }>) => boolean) => {
        const removed: string[] = [];
        for (const [sessionId, value] of stored.entries()) {
          if (!predicate({ sessionId, value })) continue;
          stored.delete(sessionId);
          removed.push(sessionId);
        }
        pruned.push(...removed);
        return removed;
      },
    };
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      store,
    });

    await scheduler.enable({
      sessionId: 'session-new',
      issueFingerprint: 'new-limit',
      resetAtMs: nowMs + 1_000,
      selectedAuth: { kind: 'native' },
    });

    expect(pruned).toEqual(['old-cancelled']);
    expect(stored.has('old-cancelled')).toBe(false);
    expect(stored.has('fresh-exhausted')).toBe(true);
    expect(stored.has('session-new')).toBe(true);
  });

  it('schedules a previously persisted intent without rewriting its timing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
    });

    scheduler.load({
      sessionId: 'session-1',
      intent: {
        v: 1,
        issueFingerprint: 'persisted-limit',
        status: 'waiting',
        resumePromptMode: 'standard',
        armedAtMs: 500,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
      },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'persisted-limit',
      armedAtMs: 500,
      nextCheckAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('schedules a timer wake when an intent is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('reports ready without auto-resuming when resume prompts are disabled', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover,
      resume,
    });

    scheduler.load({
      sessionId: 'session-1',
      intent: {
        v: 1,
        issueFingerprint: 'limit',
        status: 'waiting',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        selectedAuth: { kind: 'native' },
        resumePromptMode: 'off',
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'ready',
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'cancelled',
      resumePromptMode: 'off',
    });
  });

  it('schedules a timer wake from nextCheckAtMs when resetAtMs is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: null,
      nextCheckAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      resetAtMs: null,
      nextCheckAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('re-arms the next timer when a probe still needs to wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recover = vi
      .fn()
      .mockResolvedValueOnce({ status: 'wait' as const, nextCheckAtMs: 3_000 })
      .mockResolvedValueOnce({ status: 'ready' as const });
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover,
      resume,
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({ status: 'waiting', nextCheckAtMs: 3_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('does not probe before reset time on timer wakes', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 1_500,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(recover).not.toHaveBeenCalled();
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 2_000,
    });
  });

  it('exhausts an intent after its max attempts instead of retrying forever', async () => {
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 2_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      maxAttempts: 1,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' })).resolves.toEqual({
      status: 'exhausted',
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'exhausted',
      attemptCount: 2,
    });
  });

  it('cancels a superseded intent without resuming when the probe reports turn completion', async () => {
    const recover = vi.fn(async () => ({ status: 'superseded' as const, lastProbeError: 'session_usage_limit_recovery_control_superseded_by_turn_completion' }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_500,
      recover,
      resume,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    await scheduler.wake({ sessionId: 'session-1', reason: 'check_now' });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(scheduler.read('session-1')?.status).toBe('cancelled');

    // The intent is terminally cancelled: later wakes must not probe again.
    await scheduler.wake({ sessionId: 'session-1', reason: 'timer' });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('rate-limits rapid user check-now probes for the same session', async () => {
    let nowMs = 2_000;
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 3_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      checkNowThrottleMs: 5_000,
      recover,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'waiting',
    });
    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: 5_000,
    });

    nowMs += 5_000;
    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'waiting',
    });
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent wakes so persisted recovery writes stay ordered', async () => {
    const writes: string[] = [];
    const recoverRelease: {
      current?: (value: { status: 'wait'; nextCheckAtMs: number }) => void;
    } = {};
    const recover = vi.fn(async () => await new Promise<{ status: 'wait'; nextCheckAtMs: number }>((resolve) => {
      recoverRelease.current = resolve;
    }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover,
      store: {
        read: () => null,
        write: (_sessionId, intent) => {
          writes.push(`${intent.status}:${intent.attemptCount}`);
        },
      },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    const first = scheduler.wake({ sessionId: 'session-1', reason: 'check_now' });
    const second = scheduler.wake({ sessionId: 'session-1', reason: 'check_now' });
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    recoverRelease.current?.({ status: 'wait', nextCheckAtMs: 3_000 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ status: 'waiting' }, { status: 'waiting' }]);
    expect(writes).toEqual(['waiting:0', 'checking:1', 'waiting:1']);
  });
});
