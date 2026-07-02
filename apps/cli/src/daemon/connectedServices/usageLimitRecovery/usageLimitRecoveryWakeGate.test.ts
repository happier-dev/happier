import { describe, expect, it, vi } from 'vitest';

import { UsageLimitRecoveryScheduler } from './UsageLimitRecoveryScheduler';
import { createUsageLimitRecoveryWakeGate } from './usageLimitRecoveryWakeGate';

describe('createUsageLimitRecoveryWakeGate', () => {
  it('coalesces rehydrated sibling wakes for the same selected connected-service group even when profile ids differ', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    const stored = new Map<string, unknown>([
      ['session-1', {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'limit',
        armedAtMs: 100,
        resetAtMs: 1_000,
        nextCheckAtMs: 1_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'primary',
        },
      }],
      ['session-2', {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'limit',
        armedAtMs: 100,
        resetAtMs: 1_000,
        nextCheckAtMs: 1_000,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'backup',
        },
      }],
    ]);
    const recover = vi.fn(async () => ({ status: 'ready' as const }));
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: () => Date.now(),
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        readAll: () => [...stored.entries()],
        write: (sessionId, intent) => {
          stored.set(sessionId, intent);
        },
      },
      recover,
      gate: createUsageLimitRecoveryWakeGate({
        nowMs: () => Date.now(),
        hasRunner: () => true,
        coalesceWindowMs: 1_000,
      }),
    });

    scheduler.hydrate();
    await vi.advanceTimersByTimeAsync(1);

    expect(recover).toHaveBeenCalledTimes(1);
    expect(scheduler.read('session-1')?.status).toBe('cancelled');
    expect(scheduler.read('session-2')).toMatchObject({
      status: 'waiting',
      attemptCount: 0,
      nextCheckAtMs: 2_000,
      lastProbeError: 'usage_limit_recovery_wake_coalesced',
    });
    vi.useRealTimers();
  });
});
