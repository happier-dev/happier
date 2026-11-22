import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsageLimitRecoveryScheduler, type UsageLimitRecoveryIntent } from './UsageLimitRecoveryScheduler';
import { createUsageLimitRecoveryWakeGate } from './usageLimitRecoveryWakeGate';

describe('inactive usage-limit recovery wakes', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['native service', { kind: 'native', serviceId: 'openai-codex' }],
    ['legacy native agent', { kind: 'native' }],
    ['connected profile', { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' }],
    ['connected group', { kind: 'group', serviceId: 'openai-codex', groupId: 'team', profileId: 'primary' }],
  ] satisfies [string, UsageLimitRecoveryIntent['selectedAuth']][])('paces three restored continuations sharing a %s', async (_label, selectedAuth) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const stored = new Map<string, unknown>(['one', 'two', 'three'].map((sessionId, index) => [sessionId, {
      v: 1,
      status: 'waiting',
      issueFingerprint: `usage-limit:${index === 1 && 'serviceId' in selectedAuth ? 'another-agent' : 'codex'}:${sessionId}:100:2000`,
      armedAtMs: 100,
      resetAtMs: 2_000,
      nextCheckAtMs: 2_000,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: selectedAuth.kind === 'group' && index === 1 ? { ...selectedAuth, profileId: 'backup' } : selectedAuth,
    }]));
    const starts: number[] = [];
    const scheduler = new UsageLimitRecoveryScheduler({
      nowMs: Date.now,
      store: {
        read: (sessionId) => stored.get(sessionId) ?? null,
        readAll: () => [...stored.entries()],
        write: (sessionId, intent) => { stored.set(sessionId, intent); },
      },
      recover: async () => {
        starts.push(Date.now());
        return { status: 'resumed' };
      },
      gate: createUsageLimitRecoveryWakeGate({ nowMs: Date.now, hasRunner: () => true }),
    });
    try {
      scheduler.hydrate();
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([2_000]);
      expect(scheduler.read('two')).toMatchObject({ status: 'waiting', nextCheckAtMs: 3_000, attemptCount: 0 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(starts).toEqual([2_000, 3_000, 4_000]);
      expect([...stored.values()]).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ status: 'cancelled' })));
    } finally {
      scheduler.dispose();
    }
  });
});
