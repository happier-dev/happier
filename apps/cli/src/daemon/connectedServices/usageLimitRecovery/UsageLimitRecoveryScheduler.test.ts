import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SESSION_USAGE_LIMIT_RECOVERY_STATE_FIELD_ID,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';

import {
  METADATA_SESSION_USAGE_LIMIT_RECOVERY_V1_KEY,
  RUNTIME_USAGE_LIMIT_RECOVERY_FIELD,
  UsageLimitRecoveryScheduler,
  type UsageLimitRecoveryIntent,
} from './UsageLimitRecoveryScheduler';

describe('UsageLimitRecoveryScheduler', () => {
  it('backs off a pending probe whose supplied check time has already passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: Date.now() - 1 }));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => Date.now(), recover });
    try {
      await scheduler.enable({ sessionId: 'session-stale-probe', issueFingerprint: 'limit', resetAtMs: 500,
        selectedAuth: { kind: 'native' } });
      await scheduler.wake({ sessionId: 'session-stale-probe', reason: 'check_now' });
      expect(scheduler.read('session-stale-probe')).toMatchObject({ status: 'waiting', attemptCount: 0,
        nextCheckAtMs: 601_000 });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(recover).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledTimes(2);
    } finally { scheduler.dispose(); vi.useRealTimers(); }
  });

  it('schedules missing reset timing from the shared fallback without reviving terminal intents', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const recoveredSessions: string[] = [];
      const scheduler = new UsageLimitRecoveryScheduler({
        nowMs: () => Date.now(),
        recover: async (_intent, { sessionId }) => {
          recoveredSessions.push(sessionId);
          return { status: 'pause' };
        },
      });
      const enabled = await scheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'limit',
        resetAtMs: null,
        selectedAuth: { kind: 'native' },
      });
      expect(enabled.nextCheckAtMs).toBe(601_000);
      const scheduled = await scheduler.upsertScheduled({
        sessionId: 'session-2',
        intent: { ...enabled, status: 'checking', nextCheckAtMs: null },
      });
      expect(scheduled).toMatchObject({ status: 'waiting', nextCheckAtMs: 601_000 });
      const cancelled = await scheduler.upsertScheduled({
        sessionId: 'session-3',
        intent: { ...enabled, status: 'cancelled', nextCheckAtMs: null },
      });
      expect(cancelled).toMatchObject({ status: 'cancelled', nextCheckAtMs: null });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(recoveredSessions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(recoveredSessions.sort()).toEqual(['session-1', 'session-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops scheduled recovery when its live owner disposes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    try {
      const recover = vi.fn(async () => ({ status: 'pause' as const }));
      const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => Date.now(), recover });
      await scheduler.enable({
        sessionId: 'session-1',
        issueFingerprint: 'limit',
        resetAtMs: 2_000,
        selectedAuth: { kind: 'native' },
      });
      scheduler.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recover).not.toHaveBeenCalled();
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' }))
        .resolves.toEqual({ status: 'disposed' });
    } finally {
      vi.useRealTimers();
    }
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

  it('preserves attempt and terminal state when the same usage-limit fingerprint re-arms', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    // Simulate the scheduler having burned attempts and reached a terminal state.
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'exhausted',
        issueFingerprint: 'limit-A',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });

    // Same fingerprint resurfaces: do NOT reset attempts/terminal state.
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    const intent = scheduler.read('session-1');
    expect(intent?.issueFingerprint).toBe('limit-A');
    expect(intent?.attemptCount).toBe(3);
    expect(intent?.status).toBe('exhausted');
  });

  it('starts fresh when a genuinely new usage-limit fingerprint arms', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'exhausted',
        issueFingerprint: 'limit-A',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: 'max_attempts_exhausted',
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });

    // Different fingerprint (new reset bucket) => fresh recovery lifecycle.
    const fresh = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-B',
      resetAtMs: 5_000,
      selectedAuth: { kind: 'native' },
    });

    expect(fresh.issueFingerprint).toBe('limit-B');
    expect(fresh.attemptCount).toBe(0);
    expect(fresh.status).toBe('waiting');
    expect(scheduler.read('session-1')?.resetAtMs).toBe(5_000);
    expect(scheduler.read('session-1')?.attemptCount).toBe(0);
  });

  it('allocates a strictly newer epoch for a fresh issue when the clock has not advanced', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'cancelled',
        issueFingerprint: 'issue-z',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: null,
        attemptCount: 3,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });

    const fresh = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'issue-a',
      resetAtMs: 3_000,
      selectedAuth: { kind: 'native' },
    });

    expect(fresh).toMatchObject({ issueFingerprint: 'issue-a', armedAtMs: 1_001, status: 'waiting' });
    expect(scheduler.read('session-1')).toMatchObject({ issueFingerprint: 'issue-a', armedAtMs: 1_001 });
  });

  it.each([
    ['issue-a', 'issue-b'],
    ['issue-b', 'issue-a'],
  ] as const)('orders same-millisecond rearm creation at the shared CAS owner (%s then %s)', async (firstIssue, secondIssue) => {
    const values = new Map<string, UsageLimitRecoveryIntent>();
    const store = {
      read: (sessionId: string) => values.get(sessionId) ?? null,
      readAll: () => [...values.entries()] as ReadonlyArray<readonly [string, unknown]>,
      write: (sessionId: string, intent: UsageLimitRecoveryIntent) => { values.set(sessionId, intent); },
      merge: (
        sessionId: string,
        next: UsageLimitRecoveryIntent,
        merge: (previous: UsageLimitRecoveryIntent | null, candidate: UsageLimitRecoveryIntent) => UsageLimitRecoveryIntent | null,
      ) => {
        const merged = merge(values.get(sessionId) ?? null, next);
        if (merged) values.set(sessionId, merged);
        else values.delete(sessionId);
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

  it('coalesces independent same-fingerprint controllers into one same-millisecond epoch', async () => {
    const values = new Map<string, UsageLimitRecoveryIntent>();
    const store = {
      read: (sessionId: string) => values.get(sessionId) ?? null,
      write: (sessionId: string, intent: UsageLimitRecoveryIntent) => { values.set(sessionId, intent); },
      merge: (
        sessionId: string,
        next: UsageLimitRecoveryIntent,
        merge: (previous: UsageLimitRecoveryIntent | null, candidate: UsageLimitRecoveryIntent) => UsageLimitRecoveryIntent | null,
      ) => {
        const merged = merge(values.get(sessionId) ?? null, next);
        if (merged) values.set(sessionId, merged);
        else values.delete(sessionId);
        return merged;
      },
    };
    const first = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    const second = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000, store });
    const [left, right] = await Promise.all([
      first.enable({
        sessionId: 'session-shared',
        issueFingerprint: 'same-issue',
        resetAtMs: 5_000,
        selectedAuth: { kind: 'native' },
      }),
      second.enable({
        sessionId: 'session-shared',
        issueFingerprint: 'same-issue',
        resetAtMs: 5_000,
        selectedAuth: { kind: 'native' },
      }),
    ]);
    expect(left.armedAtMs).toBe(1_000);
    expect(right.armedAtMs).toBe(1_000);
  });

  it('does not preserve a cancelled state when the same fingerprint re-arms after user cancel', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });
    await scheduler.cancel({ sessionId: 'session-1' });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    // A cancelled lifecycle must remain cancelled (user intent) on same-fingerprint re-arm.
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('re-arms a paused same-fingerprint lifecycle after a fresh explicit enable', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'paused',
        issueFingerprint: 'limit-A',
        armedAtMs: 1_000,
        resetAtMs: 2_000,
        nextCheckAtMs: null,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });

    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      selectedAuth: { kind: 'native' },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      armedAtMs: 1_001,
      attemptCount: 0,
      nextCheckAtMs: 2_000,
    });
  });

  it.each([
    { previous: 3, requested: 1, expected: 1 },
    { previous: 3, requested: 0, expected: 3 },
  ])('keeps the stricter rearm cap ($previous, $requested)', async ({ previous, requested, expected }) => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'limit-A',
        armedAtMs: 500,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 1,
        maxAttempts: previous,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit-A',
      resetAtMs: 2_000,
      maxAttempts: requested,
      selectedAuth: { kind: 'native' },
    });
    expect(scheduler.read('session-1')?.maxAttempts).toBe(expected);
  });

  it('re-arms a paused lifecycle only for an explicit check-now action', async () => {
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 3_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 2_000, recover });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'paused',
        issueFingerprint: 'limit-A',
        armedAtMs: 500,
        resetAtMs: 2_000,
        nextCheckAtMs: null,
        attemptCount: 1,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'group', serviceId: 'openai-codex', groupId: 'main', profileId: 'limited' },
      },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' }))
      .resolves.toEqual({ status: 'inactive' });
    expect(recover).not.toHaveBeenCalled();

    await expect(scheduler.checkNow({ sessionId: 'session-1' }))
      .resolves.toEqual({ status: 'waiting' });
    expect(recover).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      issueFingerprint: 'limit-A',
      selectedAuth: expect.objectContaining({ profileId: 'limited' }),
    }), { sessionId: 'session-1', reason: 'check_now' });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 3_000,
    });
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

  it('cancels a matching waiting intent when provider-activity proof is observed', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    const enabled = await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 2_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'fresh-member',
      },
    });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        ...enabled,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:current',
      },
    });

    await expect(scheduler.markProviderOutcomeProofForSession({
      sessionId: 'session-1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
      expectedRuntimeAuthRecoveryAttemptId: 'runtime-auth-attempt:current',
    })).resolves.toMatchObject({
      status: 'cancelled',
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'fresh-member',
      },
    });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('cancels group-scoped usage-limit recovery from provider activity for another member of the same group', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
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

    await expect(scheduler.markProviderOutcomeProofForSession({
      sessionId: 'session-1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
    })).resolves.toMatchObject({
      status: 'cancelled',
      selectedAuth: {
        kind: 'group',
        profileId: 'old-member',
      },
    });
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('preserves a newer usage-limit intent when delayed provider activity belongs to an older runtime-auth attempt', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 1_000 });
    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        issueFingerprint: 'limit-b',
        status: 'waiting',
        armedAtMs: 1_001,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'fresh-member',
        },
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
      },
    });

    await expect(scheduler.markProviderOutcomeProofForSession({
      sessionId: 'session-1',
      proofKind: 'provider_activity',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
      expectedRuntimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a',
    })).resolves.toMatchObject({
      status: 'waiting',
      issueFingerprint: 'limit-b',
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
    });
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      issueFingerprint: 'limit-b',
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
    });
  });

  it('preserves a newer usage-limit intent when quota proof predates its recovery boundary', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({ nowMs: () => 2_000 });
    await scheduler.enable({
      sessionId: 'session-post-boundary',
      issueFingerprint: 'limit-current',
      resetAtMs: 3_000,
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'fresh-member',
      },
    });

    await expect(scheduler.markProviderOutcomeProofForSession({
      sessionId: 'session-post-boundary',
      proofKind: 'quota_probe_fresh',
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'fresh-member',
      observedAtMs: 1_999,
    })).resolves.toMatchObject({
      status: 'waiting',
      issueFingerprint: 'limit-current',
    });
    expect(scheduler.read('session-post-boundary')).toMatchObject({
      status: 'waiting',
      issueFingerprint: 'limit-current',
    });
  });

  it('re-runs group recovery on wake instead of retrying the old profile directly', async () => {
    const selectedProfiles: Array<string | null> = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async (intent) => {
        if (intent.selectedAuth.kind !== 'group') throw new Error('expected group intent');
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

  it('persists provider-ready startup reconstruction as paused without granting resume authority', async () => {
    const resume = vi.fn(async () => {});
    const recordRestartDiagnostic = vi.fn();
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'pause' }),
      resume,
      recordRestartDiagnostic,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({
      sessionId: 'session-1',
      reason: 'timer',
    })).resolves.toEqual({ status: 'ready' });

    expect(scheduler.read('session-1')).toMatchObject({
      status: 'paused',
      nextCheckAtMs: null,
      attemptCount: 0,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(recordRestartDiagnostic).not.toHaveBeenCalled();
  });

  it('retains a waiting retry intent when resume fails after provider readiness', async () => {
    let nowMs = 2_000;
    const stored = new Map<string, unknown>();
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error('transient resume failure'))
      .mockResolvedValueOnce(undefined);
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => nowMs,
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        write: (sessionId, intent) => {
          stored.set(sessionId, structuredClone(intent));
        },
      },
      recover: async () => ({ status: 'ready' }),
      resume,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({
      sessionId: 'session-1',
      reason: 'check_now',
    })).resolves.toEqual({ status: 'waiting' });

    expect(resume).toHaveBeenCalledOnce();
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 1,
      nextCheckAtMs: 4_000,
      lastProbeError: 'transient resume failure',
    });
    expect(stored.get('session-1')).toMatchObject({
      status: 'waiting',
      nextCheckAtMs: 4_000,
    });

    nowMs = 4_000;
    await expect(scheduler.wake({
      sessionId: 'session-1',
      reason: 'timer',
    })).resolves.toEqual({ status: 'resumed' });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('persists an updated selected auth when recovery must wait for the new candidate', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async (intent) => {
        if (intent.selectedAuth.kind !== 'group') throw new Error('expected group intent');
        return {
          status: 'wait',
          nextCheckAtMs: 2_000,
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
      selectedAuth: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'fresh-member',
      },
    });
    expect(SessionUsageLimitRecoveryV1Schema.safeParse(scheduler.read('session-1')).success).toBe(true);
  });

  it('records a daemon restart diagnostic before resuming usage-limit recovery', async () => {
    const records: unknown[] = [];
    const resume = vi.fn(async () => {});
    const deps = {
      nowMs: () => 2_000,
      recover: async () => ({ status: 'ready' as const }),
      resume,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
    } satisfies ConstructorParameters<typeof UsageLimitRecoveryScheduler>[0];
    const scheduler = new UsageLimitRecoveryScheduler(deps);
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

  it('prunes stale terminal durable intents when scheduling new usage-limit recovery', async () => {
    const nowMs = 8 * 24 * 60 * 60_000;
    const stored = new Map<string, unknown>([
      ['old-cancelled', {
        v: 1,
        status: 'cancelled',
        issueFingerprint: 'old-limit',
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
        status: 'exhausted',
        issueFingerprint: 'fresh-limit',
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
      prune: (predicate: (entry: Readonly<{ recoveryKey: string; value: unknown }>) => boolean) => {
        const removed: string[] = [];
        for (const [recoveryKey, value] of stored.entries()) {
          if (!predicate({ recoveryKey, value })) continue;
          stored.delete(recoveryKey);
          removed.push(recoveryKey);
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

  it('hydrates persisted inactive intents passively after daemon restart until an explicit check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const persisted = {
      v: 1 as const,
      status: 'waiting' as const,
      issueFingerprint: 'persisted-limit',
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' as const },
    };
    const store = {
      read: (sessionId: string) => sessionId === 'session-1' ? persisted : null,
      readAll: () => [['session-1', persisted] as const],
      write: vi.fn(),
    };
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      store,
      recover,
      resume,
    });

    expect(scheduler.hydratePassive()).toEqual([persisted]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recover).not.toHaveBeenCalled();

    await scheduler.wake({ sessionId: 'session-1', reason: 'check_now' });

    expect(recover).toHaveBeenCalledWith(expect.objectContaining({
      issueFingerprint: 'persisted-limit',
    }), { sessionId: 'session-1', reason: 'check_now' });
    expect(resume).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('schedules a previously persisted intent without rewriting its timing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const recovered: Array<Readonly<{ issueFingerprint: string; sessionId?: string }>> = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      recover: async (intent, context) => {
        recovered.push({ issueFingerprint: intent.issueFingerprint, sessionId: context.sessionId });
        return { status: 'ready' as const };
      },
    });

    await scheduler.upsert({
      sessionId: 'session-1',
      intent: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'persisted-limit',
        armedAtMs: 123,
        resetAtMs: 2_000,
        nextCheckAtMs: 2_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    });

    expect(scheduler.read('session-1')).toMatchObject({
      issueFingerprint: 'persisted-limit',
      armedAtMs: 123,
      nextCheckAtMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recovered).toEqual([{ issueFingerprint: 'persisted-limit', sessionId: 'session-1' }]);
    vi.useRealTimers();
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
    vi.useRealTimers();
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

  it('delays runner-unavailable wakes before burning a recovery attempt', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const deps = {
      nowMs: () => 2_000,
      recover,
      gate: () => ({
        status: 'delayed' as const,
        retryAtMs: 62_000,
        reason: 'usage_limit_recovery_check_runner_unavailable',
      }),
    };
    const scheduler = new UsageLimitRecoveryScheduler(deps);
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'timer' })).resolves.toEqual({
      status: 'waiting',
    });

    expect(recover).not.toHaveBeenCalled();
    expect(scheduler.read('session-1')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 62_000,
      lastProbeError: 'usage_limit_recovery_check_runner_unavailable',
    });
  });

  it.each(['pending', 'probe_error'] as const)('preserves continuation attempts while readiness is %s', async (probeResult) => {
    let probes = 0;
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      resume: async () => {},
      recover: async () => {
        probes += 1;
        if (probes > 4) return { status: 'ready' };
        if (probeResult === 'probe_error') throw new Error('provider unavailable');
        return { status: 'wait', nextCheckAtMs: 3_000 };
      },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    for (let probe = 0; probe < 4; probe += 1) {
      await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' }))
        .resolves.toEqual({ status: 'waiting' });
      expect(scheduler.read('session-1')).toMatchObject({ status: 'waiting', attemptCount: 0 });
    }
    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' }))
      .resolves.toEqual({ status: 'resumed' });
    expect(scheduler.read('session-1')).toMatchObject({ status: 'cancelled', attemptCount: 1 });
  });

  it('reports readiness without claiming continuation when no resume owner is supplied', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'ready' }),
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' }))
      .resolves.toEqual({ status: 'ready' });
    expect(scheduler.read('session-1')).toMatchObject({ status: 'paused', attemptCount: 0 });
  });

  it('settles an accepted external continuation without requesting another resume', async () => {
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover: async () => ({ status: 'resumed' }),
      resume: async () => { throw new Error('continuation already accepted'); },
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.wake({ sessionId: 'session-1', reason: 'check_now' }))
      .resolves.toEqual({ status: 'resumed' });
    expect(scheduler.read('session-1')).toMatchObject({ status: 'cancelled', attemptCount: 1 });
  });

  it('exhausts an intent after its max continuation attempts', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      recover,
      resume: async () => { throw new Error('resume failed'); },
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
      attemptCount: 1,
    });
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

  it('rate-limits a repeated explicit probe after the existing recovery lifecycle succeeds', async () => {
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const resume = vi.fn(async () => {});
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      checkNowThrottleMs: 5_000,
      recover,
      resume,
    });
    await scheduler.enable({
      sessionId: 'session-1',
      issueFingerprint: 'limit',
      resetAtMs: 1_000,
      selectedAuth: { kind: 'native' },
    });

    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'resumed',
    });
    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'rate_limited',
      errorCode: 'probe_rate_limited',
      retryAfterMs: 5_000,
    });

    expect(recover).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
  });

  it('does not spend explicit probe budget when no recovery lifecycle exists', async () => {
    const recover = vi.fn(async () => ({ status: 'wait' as const, nextCheckAtMs: 3_000 }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => 2_000,
      checkNowThrottleMs: 5_000,
      recover,
    });

    await expect(scheduler.checkNow({ sessionId: 'session-1' })).resolves.toEqual({
      status: 'inactive',
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

    expect(recover).toHaveBeenCalledTimes(1);
  });
});
