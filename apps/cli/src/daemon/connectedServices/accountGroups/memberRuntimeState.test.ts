import type {
  ConnectedServiceAuthGroupMemberStateV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeStateRevisionConflictError } from '@/api/connectedServices/connectedServiceCredentialApi';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from './selection/selectConnectedServiceAuthGroupCandidate';
import {
  buildObservedFailureMemberRuntimeState,
  persistMemberRuntimeStateWithPositiveEvidence,
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  reconcileMemberRuntimeStateWithPositiveEvidence,
} from './memberRuntimeState';

describe('buildObservedFailureMemberRuntimeState', () => {
  it('keeps the failing usage window with its blocker', () => {
    expect(buildObservedFailureMemberRuntimeState({
      existing: null,
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      reason: 'usage_limit',
      providerLimitId: 'five_hour',
      retryAtMs: 100_000,
      planType: null,
      observedAtMs: 1_000,
    })).toMatchObject({ lastFailureProviderLimitId: 'five_hour' });
  });
  it('does not shrink a known hard-limit block when a same-failure report lacks reset timing', () => {
    const state = buildObservedFailureMemberRuntimeState({
      existing: {
        quotaExhaustedUntilMs: 7_000_000,
        providerResetsAtMs: 7_000_000,
        lastFailureKind: 'usage_limit',
        lastFailureProviderLimitId: 'seven_day',
      },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      reason: 'usage_limit',
      providerLimitId: null,
      retryAtMs: 30_000,
      planType: null,
      observedAtMs: 2_000,
    });

    expect(state).toMatchObject({
      quotaExhaustedUntilMs: 7_000_000,
      providerResetsAtMs: 7_000_000,
      lastFailureKind: 'usage_limit',
    });
  });
  it('cools down an unsupported ChatGPT model for 24 hours without blocking other models', () => {
    expect(buildObservedFailureMemberRuntimeState({
      existing: null,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, cooldownMs: 45_000 },
      reason: 'plan',
      limitCategory: 'plan_invalid',
      quotaScope: 'model',
      providerLimitId: 'gpt-5.6-sol',
      retryAtMs: null,
      planType: null,
      observedAtMs: 1_000,
    })).toEqual({
      lastFailureKind: 'plan',
      lastFailureCode: 'model_not_entitled',
      lastObservedAtMs: 1_000,
      modelUnavailableUntilMsByModelId: {
        'gpt-5.6-sol': 86_401_000,
      },
    });
  });

  it('marks the exact model-entitlement failure for persistent disable when the pool opts in', () => {
    expect(buildObservedFailureMemberRuntimeState({
      existing: null,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoDisablePlanInvalidAccounts: true },
      reason: 'plan',
      limitCategory: 'plan_invalid',
      quotaScope: 'model',
      providerLimitId: 'gpt-5.6-sol',
      retryAtMs: null,
      planType: null,
      observedAtMs: 1_000,
    })).toMatchObject({
      autoDisabledReason: 'model_not_entitled',
      lastFailureCode: 'model_not_entitled',
    });
  });

  it('gives generic plan-invalid failures a 24-hour account cooldown without auto-disabling', () => {
    const state = buildObservedFailureMemberRuntimeState({
      existing: null,
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoDisablePlanInvalidAccounts: true },
      reason: 'permission_denied',
      limitCategory: 'plan_invalid',
      quotaScope: 'provider',
      providerLimitId: null,
      retryAtMs: null,
      planType: null,
      observedAtMs: 1_000,
    });

    expect(state).toMatchObject({ planUnavailableUntilMs: 86_401_000 });
    expect(state).not.toHaveProperty('autoDisabledReason');
  });
});

function group(state: ConnectedServiceAuthGroupMemberStateV1, runtimeStateRevision = 0): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex' as ConnectedServiceId,
    groupId: 'group-1',
    displayName: 'Group 1',
    activeProfileId: 'primary',
    generation: 7,
    runtimeStateRevision,
    state: { v: 1 },
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    members: [
      {
        v: 1,
        serviceId: 'openai-codex' as ConnectedServiceId,
        groupId: 'group-1',
        profileId: 'primary',
        priority: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        state,
      },
      {
        v: 1,
        serviceId: 'openai-codex' as ConnectedServiceId,
        groupId: 'group-1',
        profileId: 'backup',
        priority: 2,
        enabled: true,
        createdAt: 2,
        updatedAt: 2,
        state: { v: 1 },
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('persistMemberRuntimeStateWithPositiveEvidence', () => {
  it('clears matching member runtime-state with newer positive evidence and expected generation', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 10_000,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      expectedGeneration: 7,
      expectedRuntimeStateRevision: 0,
      memberStates: [{ profileId: 'primary', state: { v: 1 } }],
    });
  });

  it('re-reads and recomputes after a runtime-state revision conflict', async () => {
    const blocker = {
      v: 1,
      authInvalidUntilMs: 10_000,
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    } satisfies ConnectedServiceAuthGroupMemberStateV1;
    const first = group(blocker, 0);
    const concurrent = group({ ...blocker, providerResetsAtMs: 20_000 }, 1);
    const api = {
      getConnectedServiceAuthGroup: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(concurrent),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn()
        .mockRejectedValueOnce(new ConnectedServiceAuthGroupRuntimeStateRevisionConflictError(1))
        .mockResolvedValueOnce(group({ v: 1 }, 2)),
    };

    await expect(persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex',
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    })).resolves.toBe(true);

    expect(api.getConnectedServiceAuthGroup).toHaveBeenCalledTimes(2);
    expect(api.updateConnectedServiceAuthGroupRuntimeState).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRuntimeStateRevision: 1,
      memberStates: [{
        profileId: 'primary',
        state: { v: 1, providerResetsAtMs: 20_000 },
      }],
    }));
  });

  it('logs the cleared-blocker kinds at the clear point without emitting any state VALUES (QA2-F01/RR-8)', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 987_654,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };
    const debug = vi.fn();

    const cleared = await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      logger: { debug },
    });

    expect(cleared).toBe(true);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[1]).toMatchObject({
      serviceId: 'openai-codex',
      groupId: 'group-1',
      profileId: 'primary',
      evidenceKind: 'successful_turn',
    });
    const clearedKinds = (debug.mock.calls[0]?.[1] as { clearedBlockerKinds: string[] }).clearedBlockerKinds;
    expect(clearedKinds).toEqual(
      expect.arrayContaining(['authInvalidUntilMs', 'credentialHealthStatus', 'lastFailureKind', 'lastObservedAtMs']),
    );
    // Values-never-logged: the blocker VALUE (the reauth deadline) must never appear in diagnostics.
    expect(JSON.stringify(debug.mock.calls)).not.toContain('987654');
  });

  it('does not log when nothing is cleared (no positive-evidence change)', async () => {
    const persisted = group({ v: 1, lastObservedAtMs: 5_000 });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };
    const debug = vi.fn();

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 7,
      // Evidence not newer than the last observation → no clear, no persist, no log.
      evidence: { kind: 'successful_turn', observedAtMs: 4_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      logger: { debug },
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('does not clear stale generations', async () => {
    const persisted = group({
      v: 1,
      authInvalidUntilMs: 10_000,
      credentialHealthStatus: 'needs_reauth',
      lastFailureKind: 'auth_failed',
      lastObservedAtMs: 1_000,
    });
    const api = {
      getConnectedServiceAuthGroup: vi.fn(async () => persisted),
      updateConnectedServiceAuthGroupRuntimeState: vi.fn(async () => persisted),
    };

    await persistMemberRuntimeStateWithPositiveEvidence({
      api,
      serviceId: 'openai-codex' as ConnectedServiceId,
      groupId: 'group-1',
      profileId: 'primary',
      generation: 6,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      normalizePolicy: () => DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    });

    expect(api.updateConnectedServiceAuthGroupRuntimeState).not.toHaveBeenCalled();
  });
});

describe('reconcileMemberRuntimeStateWithPositiveEvidence', () => {
  it.each([
    { name: 'same window after cooldown', meterId: 'five_hour', capturedAtMs: 31_000, nowMs: 31_000, clears: true },
    { name: 'different positive window', meterId: 'seven_day', capturedAtMs: 31_000, nowMs: 31_000, clears: false },
    { name: 'same window during cooldown', meterId: 'five_hour', capturedAtMs: 30_999, nowMs: 31_000, clears: false },
    { name: 'stale same window', meterId: 'five_hour', capturedAtMs: 31_000, nowMs: 91_000, clears: false },
    { name: 'future same window', meterId: 'five_hour', capturedAtMs: 31_001, nowMs: 31_000, clears: false },
  ])('admits quota positive evidence only for $name', ({ meterId, capturedAtMs, nowMs, clears }) => {
    const state = {
      lastFailureKind: 'usage_limit',
      lastFailureProviderLimitId: 'five_hour',
      lastObservedAtMs: 1_000,
      quotaExhaustedUntilMs: 500_000,
      providerResetsAtMs: 500_000,
      authInvalidUntilMs: 500_000,
    };
    const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      state,
      quotaSnapshot: {
        capturedAtMs,
        effectiveRemainingPercent: 98,
        meters: [{ meterId, providerLimitId: meterId, limitCategory: 'usage_limit', remainingPct: 98, resetAtMs: 500_000 }],
      },
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, cooldownMs: 30_000 },
      nowMs,
    });
    if (clears) expect(reconciled).toEqual({ authInvalidUntilMs: 500_000 });
    else expect(reconciled).toBe(state);
  });

  it('retains model exclusions when a successful turn carries no model entitlement proof', () => {
    expect(reconcileMemberRuntimeStateWithPositiveEvidence({
      state: { lastObservedAtMs: 1_000, lastFailureCode: 'model_not_entitled',
        modelUnavailableUntilMsByModelId: { unsupported: 86_401_000 }, autoDisabledReason: 'model_not_entitled' },
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, nowMs: 2_000,
    })).toMatchObject({
      modelUnavailableUntilMsByModelId: { unsupported: 86_401_000 }, autoDisabledReason: 'model_not_entitled',
    });
  });
  const allBlockers = {
    authInvalidUntilMs: 10_000,
    capacityLimitedUntilMs: 10_000,
    cooldownStartedAtMs: 1_000,
    cooldownUntilMs: 10_000,
    credentialHealthStatus: 'needs_reauth' as const,
    exhaustedUntilMs: 10_000,
    lastFailureKind: 'usage_limit',
    lastObservedAtMs: 1_000,
    planUnavailableUntilMs: 10_000,
    quotaExhaustedUntilMs: 10_000,
    rateLimitedUntilMs: 10_000,
    validationBlockedUntilMs: 10_000,
  };

  it('uses an exact successful provider turn to clear every older provider blocker', () => {
    expect(reconcileMemberRuntimeStateWithPositiveEvidence({
      state: allBlockers,
      evidence: { kind: 'successful_turn', observedAtMs: 2_000 },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      nowMs: 2_000,
    })).toEqual({});
  });

  it.each(['successful_spawn', 'account_adoption'] as const)(
    'does not let local %s progress erase provider failure state',
    (kind) => {
      expect(reconcileMemberRuntimeStateWithPositiveEvidence({
        state: allBlockers,
        evidence: { kind, observedAtMs: 2_000 },
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        nowMs: 2_000,
      })).toBe(allBlockers);
    },
  );

  it.each(['credential_refresh', 'oauth_token_callback'] as const)(
    'lets %s clear an older authentication failure without erasing unrelated quota or capacity blockers',
    (kind) => {
      const state = {
        ...allBlockers,
        lastFailureKind: 'auth_failed',
      };
      expect(reconcileMemberRuntimeStateWithPositiveEvidence({
        state,
        evidence: { kind, observedAtMs: 2_000 },
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        nowMs: 2_000,
      })).toEqual({
        capacityLimitedUntilMs: 10_000,
        planUnavailableUntilMs: 10_000,
        quotaExhaustedUntilMs: 10_000,
        rateLimitedUntilMs: 10_000,
        validationBlockedUntilMs: 10_000,
      });
    },
  );

  it('does not use generic headroom to clear an exact usage-limit failure without a matching usage meter', () => {
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      state: allBlockers,
      quotaSnapshot: {
        capturedAtMs: 2_000,
        effectiveMeterId: 'generic',
        effectiveRemainingPercent: 99,
      },
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      nowMs: 2_000,
    })).toBe(allBlockers);
  });

  it('uses a matching fresh usage meter only for the quota failure class', () => {
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      state: allBlockers,
      quotaSnapshot: {
        capturedAtMs: 31_000,
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
      nowMs: 31_000,
    })).toEqual({
      authInvalidUntilMs: 10_000,
      capacityLimitedUntilMs: 10_000,
      credentialHealthStatus: 'needs_reauth',
      planUnavailableUntilMs: 10_000,
      rateLimitedUntilMs: 10_000,
      validationBlockedUntilMs: 10_000,
    });
  });

  it('lets current quota evidence supersede a failure timestamp poisoned by a future clock', () => {
    expect(reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      state: {
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 100_000,
        quotaExhaustedUntilMs: 200_000,
      },
      quotaSnapshot: {
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
