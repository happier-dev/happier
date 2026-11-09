import { describe, expect, it } from 'vitest';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import type { ConnectedServiceAuthGroupQuotaSnapshot } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { reconcileMemberRuntimeStateWithFreshQuotaEvidence } from './memberRuntimeState';

describe('reconcileMemberRuntimeStateWithFreshQuotaEvidence', () => {
  it.each([false, true])('clears same-window exhaustion at the policy cooldown boundary (authenticated=%s)', authenticatedProbe => {
    const state = { lastFailureKind: 'usage_limit', lastFailureProviderLimitId: 'weekly',
      lastObservedAtMs: 1_000, quotaExhaustedUntilMs: 100_000, providerResetsAtMs: 100_000 };
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({ state,
      quotaSnapshot: { capturedAtMs: 31_000, staleAfterMs: 60_000, meters: [{ meterId: 'weekly',
        providerLimitId: 'weekly', limitCategory: 'usage_limit', remainingPct: 80, resetAtMs: null }] },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, nowMs: 31_000, authenticatedProbe,
    })).toEqual({});
  });

  it.each([false, true])('retains failure exhaustion for mismatched, unreliable, early or stale quota (authenticated=%s)', authenticatedProbe => {
    const state = { lastFailureKind: 'usage_limit', lastFailureProviderLimitId: 'weekly',
      lastObservedAtMs: 1_000, quotaExhaustedUntilMs: 100_000 };
    const snapshot: ConnectedServiceAuthGroupQuotaSnapshot = { capturedAtMs: 31_000, staleAfterMs: 60_000,
      effectiveRemainingPercent: 80, meters: [{ meterId: 'weekly', providerLimitId: 'weekly',
        limitCategory: 'usage_limit', remainingPct: 80, resetAtMs: null }] };
    for (const quotaSnapshot of [
      { ...snapshot, meters: [{ ...snapshot.meters![0], providerLimitId: 'session' }] },
      { ...snapshot, meters: [{ ...snapshot.meters![0], reliable: false }] },
      { ...snapshot, capturedAtMs: 30_999 },
      { ...snapshot, capturedAtMs: 31_001 },
      { ...snapshot, staleAfterMs: 0 },
      { ...snapshot, meters: [] },
    ]) {
      expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({ state, quotaSnapshot,
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, nowMs: 31_000, authenticatedProbe,
      })).toBe(state);
    }
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({ state, quotaSnapshot: snapshot,
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, nowMs: 91_000, authenticatedProbe,
    })).toBe(state);
  });

  it('PORT-PS-AB keeps learned model exclusions after a generic authenticated quota success', () => {
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      state: { lastFailureKind: 'plan', lastObservedAtMs: 100, cooldownUntilMs: 5_000,
        autoDisabledReason: 'model_not_entitled', modelUnavailableUntilMsByModelId: { 'restricted-model': 100_000 } },
      quotaSnapshot: { capturedAtMs: 1_000, staleAfterMs: 60_000, effectiveRemainingPercent: 80, exhausted: false },
      nowMs: 1_000, authenticatedProbe: true,
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    })).toMatchObject({ autoDisabledReason: 'model_not_entitled',
      modelUnavailableUntilMsByModelId: { 'restricted-model': 100_000 } });
  });

  it('lets current quota evidence supersede a failure timestamp poisoned by a future clock', () => {
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      state: {
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 100_000,
        quotaExhaustedUntilMs: 200_000,
      },
      quotaSnapshot: {
        staleAfterMs: 60_000,
        capturedAtMs: 10_000,
        effectiveMeterId: 'weekly',
        effectiveRemainingPercent: 80,
        meters: [{
          meterId: 'weekly',
          limitCategory: 'usage_limit',
          remainingPct: 80,
          resetAtMs: null,
          providerLimitId: 'weekly',
        }],
      },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      nowMs: 10_000,
    })).toEqual({});
  });
});
