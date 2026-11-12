import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds } from './resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2 } from './selectConnectedServiceAuthGroupCandidate';

describe('resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds', () => {
  it.each([0, 1])('refreshes an exhausted sample at or after its reset without waiting for sample staleness (%s ms)', (elapsed) => {
    const resetAtMs = 1_001_000;
    const input = {
      activeProfileId: 'active',
      members: [{ profileId: 'active', priority: 1, createdAtMs: 1, enabled: true }],
      memberStatesByProfileId: new Map([['active', { quotaSnapshot: {
        capturedAtMs: resetAtMs - 1_000, staleAfterMs: 60_000,
        effectiveRemainingPercent: 0,
        meters: [{ meterId: 'weekly', limitCategory: 'usage_limit' as const,
          remainingPct: 0, resetAtMs, providerLimitId: null }],
      } }]]),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, preTurnProbeMode: 'when_stale' as const },
      allowCurrentProfileRetry: true,
    };
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({ ...input, nowMs: resetAtMs - 1 })).toEqual([]);
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({ ...input, nowMs: resetAtMs + elapsed })).toEqual(['active']);
    input.memberStatesByProfileId.set('active', { quotaSnapshot: {
      capturedAtMs: resetAtMs + elapsed, staleAfterMs: 60_000, effectiveRemainingPercent: 0,
      meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs, providerLimitId: null }],
    } });
    // A read made after the reset is authoritative even when the provider still reports zero.
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({ ...input, nowMs: resetAtMs + elapsed })).toEqual([]);
  });

  it('keeps source-valid quota without a probe and probes source-expired quota despite a later probe preference', () => {
    const nowMs = 1_000_000;
    const resolve = (staleAfterMs: number) => resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: 'active',
      members: [{ profileId: 'active', priority: 1, createdAtMs: 1, enabled: true }],
      memberStatesByProfileId: new Map([['active', { quotaSnapshot: {
        capturedAtMs: nowMs - 6 * 60_000,
        staleAfterMs,
        effectiveRemainingPercent: 80,
      } }]]),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
        preTurnProbeMode: 'when_stale',
        probeIfSnapshotOlderThanMs: 10 * 60_000,
      },
      nowMs,
      allowCurrentProfileRetry: true,
    });

    expect(resolve(10 * 60_000)).toEqual([]);
    expect(resolve(60_000)).toEqual(['active']);
  });

  it('skips an unusable spare while probing retryable and healthy credentials', () => {
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: 'active',
      members: ['active', 'dead', 'healthy', 'retryable', 'refreshing', 'unknown'].map((profileId, priority) => ({ profileId, priority, createdAtMs: priority, enabled: true })),
      memberStatesByProfileId: new Map([
        ['active', { credentialHealthStatus: 'connected' as const }],
        ['dead', { credentialHealthStatus: 'needs_reauth' as const }],
        ['healthy', { credentialHealthStatus: 'connected' as const }],
        ['retryable', { credentialHealthStatus: 'refresh_failed_retryable' as const }],
        ['refreshing', { credentialHealthStatus: 'refreshing' as const }],
      ]),
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2, preTurnProbeMode: 'always_for_group' },
      nowMs: 1_000,
      allowCurrentProfileRetry: true,
    })).toEqual(['active', 'healthy', 'retryable', 'refreshing', 'unknown']);
  });

  it('probes a profile whose retained quota observation is dated in the future', () => {
    expect(resolveConnectedServiceAuthGroupPreTurnQuotaProbeProfileIds({
      activeProfileId: 'active',
      members: [{ profileId: 'active', priority: 1, createdAtMs: 1, enabled: true }],
      memberStatesByProfileId: new Map([[
        'active',
        { quotaSnapshot: { staleAfterMs: 60_000, capturedAtMs: 10_000, effectiveMeterId: 'weekly', effectiveRemainingPercent: 0 } },
      ]]),
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
        preTurnProbeMode: 'when_stale',
      },
      nowMs: 1_000,
      allowCurrentProfileRetry: true,
    })).toEqual(['active']);
  });
});
