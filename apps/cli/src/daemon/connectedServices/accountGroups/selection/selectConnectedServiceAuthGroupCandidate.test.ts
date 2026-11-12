import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema, type ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { buildConnectedServiceAuthGroupRuntimeStateFromMeters } from '../quotas/projection';

import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter,
  reconcileMemberRuntimeStateWithFreshQuotaEvidence,
  reconcileMemberRuntimeStateWithPositiveEvidence,
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
  selectConnectedServiceAuthGroupCandidate,
  resolveConnectedServiceAuthGroupQuotaResetCandidates,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from './selectConnectedServiceAuthGroupCandidate';

const basePolicy = DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1;

describe('quota reset admission', () => {
  const exhausted: ConnectedServiceAuthGroupMemberRuntimeState = {
    quotaSnapshot: {
      capturedAtMs: 900,
      effectiveRemainingPercent: 0,
      meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 100_000, providerLimitId: null }],
    },
  };
  const resolve = (backup: ConnectedServiceAuthGroupMemberRuntimeState) => resolveConnectedServiceAuthGroupQuotaResetCandidates({
    nowMs: 1_000,
    quotaFreshnessMs: 60_000,
    activeProfileId: 'primary',
    policy: basePolicy,
    members: [member('primary', 1, 1), member('backup', 2, 2)],
    memberStatesByProfileId: new Map([['primary', exhausted], ['backup', backup]]),
  });

  it('admits exhausted usable accounts including the current member, but not reconnect-required members', () => {
    expect(resolve(exhausted).map((candidate) => candidate.profileId)).toEqual(['primary', 'backup']);
    expect(resolve({ ...exhausted, credentialHealthStatus: 'needs_reauth' }).map((candidate) => candidate.profileId)).toEqual(['primary']);
  });

  it('carries only proven exhausted usage limits to automatic reset admission', () => {
    const backup: ConnectedServiceAuthGroupMemberRuntimeState = { quotaSnapshot: {
      capturedAtMs: 900, effectiveRemainingPercent: 0, meters: [
        { meterId: 'display-weekly', providerLimitId: 'seven_day', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 100_000 },
        { meterId: 'display-duplicate', providerLimitId: 'seven_day', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 100_000 },
        { meterId: 'five_hour', providerLimitId: 'five_hour', limitCategory: 'usage_limit', remainingPct: 50, resetAtMs: 100_000 },
        { meterId: 'unknown-provider-id', providerLimitId: null, limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 100_000 },
      ],
    } };
    expect(resolve(backup)).toContainEqual(expect.objectContaining({ profileId: 'backup', providerLimitIds: ['seven_day'] }));
    expect(resolve(backup)).toContainEqual(expect.objectContaining({ profileId: 'primary', providerLimitIds: [] }));
  });

  it('does not turn unknown evidence, transient cooldown, or capacity backoff into quota exhaustion', () => {
    expect(resolve({})).toEqual([]);
    expect(resolve({ cooldownUntilMs: 2_000 })).toEqual([]);
    expect(resolve({ capacityLimitedUntilMs: 2_000 })).toEqual([]);
    expect(resolve({ ...exhausted, quotaSnapshot: { ...exhausted.quotaSnapshot!, capturedAtMs: 0 } })).toHaveLength(2);
    expect(resolve({ ...exhausted, quotaSnapshot: { ...exhausted.quotaSnapshot!, capturedAtMs: -100_000 } })).toEqual([]);
  });

  it('offers banked free resets before falling back to a credits-only account', () => {
    const creditsOnly: ConnectedServiceAuthGroupMemberRuntimeState = {
      quotaSnapshot: { ...exhausted.quotaSnapshot!, creditsAvailable: true },
    };
    expect(resolve(creditsOnly).map((candidate) => candidate.profileId)).toEqual(['primary', 'backup']);
    const included: ConnectedServiceAuthGroupMemberRuntimeState = { quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 40,
      meters: [{ meterId: 'weekly', limitCategory: 'usage_limit', remainingPct: 40, resetAtMs: 100_000, providerLimitId: null }] } };
    expect(resolve(included)).toEqual([]);
  });

  it('does not spend a usage reset for a rate-limit-only exhausted member', () => {
    expect(resolve({ quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 0, meters: [
      { meterId: 'requests', limitCategory: 'rate_limit', remainingPct: 0, resetAtMs: 2_000, providerLimitId: null },
    ] } })).toEqual([]);
  });
});

function member(profileId: string, priority: number, createdAtMs: number) {
  return {
    profileId,
    priority,
    createdAtMs,
    enabled: true,
  };
}

describe('DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1', () => {
  it('is derived from the protocol schema default and stays in lockstep with it', () => {
    // Split-brain hygiene: the daemon default must not diverge from the protocol schema default.
    // The strategy comes from the canonical protocol default.
    expect(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.strategy).toBe('expiry_first');
    expect(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1).toEqual(
      ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
    );
  });
});

describe('selectConnectedServiceAuthGroupCandidate', () => {
  it.each(['usage_limit', 'manual_adoption'] as const)('ages only elapsed exhausted allowances to unknown for %s', (reason) => {
    const expired = { meterId: 'short', providerLimitId: 'five_hour', limitCategory: 'usage_limit' as const,
      remainingPct: 0, resetAtMs: 500_000 };
    const snapshot = { capturedAtMs: 1, exhausted: true, effectiveRemainingPercent: 0, meters: [expired] };
    const select = (state: ConnectedServiceAuthGroupMemberRuntimeState) => selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000_000, quotaFreshnessMs: 60_000, activeProfileId: 'failed',
      requiredModelIds: ['model'],
      switchReason: reason === 'usage_limit' ? reason : undefined,
      acceptLastKnownQuota: reason === 'manual_adoption',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [member('failed', 0, 0), member('backup', 1, 1)],
      memberStatesByProfileId: new Map([['backup', state]]),
    });
    expect(select({ quotaSnapshot: snapshot }).selected).toMatchObject({ profileId: 'backup', leastLimitedScore: null });
    for (const state of [
      { quotaSnapshot: { ...snapshot, meters: [expired, { ...expired, meterId: 'weekly', resetAtMs: 2_000_000 }] } },
      { quotaSnapshot: { ...snapshot, meters: [{ ...expired, resetAtMs: null }] } },
      { quotaSnapshot: snapshot, credentialHealthStatus: 'needs_reauth' as const },
      { quotaSnapshot: snapshot, modelUnavailableUntilMsByModelId: { model: 2_000_000 } },
      { quotaSnapshot: snapshot, quotaExhaustedUntilMs: 2_000_000, lastObservedAtMs: 900_000, lastFailureKind: 'usage_limit' },
      { quotaSnapshot: { ...snapshot, meters: [expired, { ...expired, limitCategory: 'plan_invalid' as const, remainingPct: null, resetAtMs: null }] } },
    ]) {
      expect(select(state).selected, JSON.stringify(state)).toBeNull();
    }
  });

  it('recovers a hard limit from healthiest last-known quota without selecting stale weekly exhaustion or blocked members', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000_000, quotaFreshnessMs: 60_000, activeProfileId: 'failed', switchReason: 'usage_limit',
      policy: { ...basePolicy, strategy: 'priority' },
      members: ['failed', 'weekly-empty', 'blocked', 'plan-blocked', 'low', 'healthy'].map((id, i) => member(id, i, i)),
      memberStatesByProfileId: new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
        ['weekly-empty', { quotaSnapshot: { capturedAtMs: 1, effectiveRemainingPercent: 100, meters: [
          { meterId: 'weekly', providerLimitId: 'seven_day', limitCategory: 'usage_limit', remainingPct: 0, resetAtMs: 2_000_000 },
        ] } }],
        ['blocked', { authInvalidUntilMs: 2_000_000 }],
        ['plan-blocked', { quotaSnapshot: { capturedAtMs: 1, meters: [
          { meterId: 'plan', providerLimitId: null, limitCategory: 'plan_invalid', remainingPct: null, resetAtMs: null },
        ] } }],
        ['low', { quotaSnapshot: { capturedAtMs: 1, effectiveRemainingPercent: 10 } }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 1, effectiveRemainingPercent: 100 } }],
      ]),
      quotaProbeDeferredUntilMsByProfileId: new Map([['healthy', 2_000_000]]),
    });
    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: 'weekly-empty', reason: 'quota_exhausted' }),
      expect.objectContaining({ profileId: 'blocked', reason: 'auth_invalid' }),
      expect.objectContaining({ profileId: 'plan-blocked', reason: 'plan_unavailable' }),
    ]));
    expect(result.decisionTrace.candidates).toContainEqual(expect.objectContaining({
      profileId: 'healthy', decision: 'selected', quotaEvidence: expect.objectContaining({ status: 'last_known' }),
    }));
  });

  it('treats unavailable quota as unknown for hard recovery while preserving the fresh soft-switch gate', () => {
    const params = { profileId: 'backup', nowMs: 1_000, quotaFreshnessMs: 60_000,
      memberStatesByProfileId: new Map([['backup', { quotaSnapshot: { capturedAtMs: 999, planUnavailable: true } }]]),
    };
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({ ...params, reason: 'usage_limit' })).toBe(true);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({ ...params, reason: 'soft_threshold' })).toBe(false);
  });

  it('prefers fresh usable evidence over a healthier last-known fallback for a hard limit', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000_000, quotaFreshnessMs: 60_000, activeProfileId: 'failed', switchReason: 'usage_limit',
      policy: { ...basePolicy, strategy: 'priority' },
      members: ['failed', 'stale', 'fresh'].map((id, i) => member(id, i, i)),
      memberStatesByProfileId: new Map([
        ['stale', { quotaSnapshot: { capturedAtMs: 1, effectiveRemainingPercent: 100 } }],
        ['fresh', { quotaSnapshot: { capturedAtMs: 999_999, effectiveRemainingPercent: 50 } }],
      ]),
    });
    expect(result.selected?.profileId).toBe('fresh');
  });

  it('excludes a member only for the model whose entitlement cooldown is active', () => {
    const params = {
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: null,
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
      members: [member('primary', 1, 1), member('backup', 2, 2)],
      memberStatesByProfileId: new Map([
        ['primary', { modelUnavailableUntilMsByModelId: { 'gpt-5.6-sol': 86_401_000 } }],
      ]),
    } as const;

    expect(selectConnectedServiceAuthGroupCandidate({ ...params, providerLimitId: 'gpt-5.6-sol' }).selected?.profileId).toBe('backup');
    expect(selectConnectedServiceAuthGroupCandidate({ ...params, providerLimitId: 'gpt-5.6-terra' }).selected?.profileId).toBe('primary');
  });
  it('does not treat the active profile as a meaningfully better soft-switch target', () => {
    expect(isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter({
      activeProfileId: 'active',
      candidate: {
        ...member('active', 1, 1),
        leastLimitedScore: 95,
      },
      policy: {
        ...basePolicy,
        softSwitchRemainingPercent: 20,
      },
    })).toBe(false);
  });

  it('selects the next eligible member by priority', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('backup-b', 20, 2),
        member('backup-a', 10, 3),
      ],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected?.profileId).toBe('backup-a');
  });

  it('tie-breaks priority candidates by creation time and profile id', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('delta', 10, 10),
        member('bravo', 10, 5),
        member('alpha', 10, 5),
      ],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected?.profileId).toBe('alpha');
  });

  it('ranks least-limited candidates by normalized quota headroom', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['low', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 25 } }],
      ['high', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ['medium', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'model:gpt-5', effectiveRemainingPercent: 60 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('low', 1, 1),
        member('medium', 1, 2),
        member('high', 1, 3),
      ],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('high');
  });

  it('restores the priority-primary member once its limit reset has landed when autoRestorePrimaryWhenReset is enabled', () => {
    // We soft-switched away from the priority-primary earlier because it hit a usage limit. Its
    // provider reset has now landed (providerResetsAtMs <= now) and a fresh healthy snapshot proves
    // headroom. The current `backup` is above the soft-switch threshold, so without restore the
    // group would stay on `backup`; restore must override that and re-pin the recovered primary.
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 500,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
        quotaSnapshot: {
          capturedAtMs: 900,
          effectiveMeterId: 'weekly',
          effectiveRemainingPercent: 60,
          meters: [{
            meterId: 'weekly',
            limitCategory: 'usage_limit',
            remainingPct: 60,
            resetAtMs: null,
            providerLimitId: 'weekly',
          }],
        },
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
      ['other', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15, cooldownMs: 500 },
      members: [member('primary', 10, 1), member('backup', 20, 2), member('other', 30, 3)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('primary');
  });

  it.each([
    {},
    { lastFailureKind: 'usage_limit', providerResetsAtMs: null },
    { lastFailureKind: 'usage_limit', providerResetsAtMs: 500 },
    { providerResetsAtMs: 5_000 },
  ])('restores fresh healthy primary quota after an automatic fallback without reset history (%j)', (failureState) => {
    const input = {
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      lastSwitchReason: 'usage_limit',
      lastSwitchAt: 400,
      policy: { ...basePolicy, strategy: 'priority' as const, autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 0 },
      members: [member('primary', 100, 1), member('backup', 200, 2)],
      memberStatesByProfileId: new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
        ['primary', { ...failureState, quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 37 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveRemainingPercent: 9 } }],
      ]),
    };
    expect(selectConnectedServiceAuthGroupCandidate(input).selected?.profileId).toBe('primary');
    expect(selectConnectedServiceAuthGroupCandidate({ ...input, lastSwitchReason: 'manual' }).selected?.profileId).toBe('backup');
    expect(selectConnectedServiceAuthGroupCandidate({ ...input, lastSwitchAt: 950 }).selected?.profileId).toBe('backup');
  });

  it('does not restore the primary when autoRestorePrimaryWhenReset is disabled (default)', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 500,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
        quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 60 },
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
      ['other', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', softSwitchRemainingPercent: 15 },
      members: [member('primary', 10, 1), member('backup', 20, 2), member('other', 30, 3)],
      memberStatesByProfileId: states,
    });

    // Restore disabled → the above-threshold current `backup` is retained (no re-pin to primary).
    expect(result.selected?.profileId).toBe('backup');
  });

  it('F3: does not restore-pin the primary under least_limited strategy (headroom ranking wins)', () => {
    // Under least_limited there is no fixed "primary"; enabling autoRestore must NOT convert the
    // pool into oldest/lowest-priority pinning over a higher-headroom candidate.
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 500,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
        quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 60 },
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 40 } }],
      ['other', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      policy: { ...basePolicy, strategy: 'least_limited', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15, cooldownMs: 100 },
      members: [member('primary', 10, 1), member('backup', 20, 2), member('other', 30, 3)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('other');
  });

  it('F2: does not restore-revert a manual choice when the primary was never limited', () => {
    // Priority strategy, autoRestore on, but the primary carries no landed provider reset / limiter
    // history — the user simply made `backup` active. Restore must NOT bounce that choice back.
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 60 } }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
      ['other', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15 },
      members: [member('primary', 10, 1), member('backup', 20, 2), member('other', 30, 3)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('F2: does not restore-revert to the primary while its limit reset has not yet landed', () => {
    // Primary was limited but its provider reset is still in the future (has not landed): it is not
    // yet a safe restore target, so the above-threshold current member is retained.
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 5_000,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
        quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 60 },
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15 },
      members: [member('primary', 10, 1), member('backup', 20, 2)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('F1: fails closed and does not restore a primary whose headroom is unknown (stale/missing snapshot)', () => {
    // Primary was limited and its reset landed, but there is no fresh snapshot, so its headroom is
    // unknown. Restoring on unknown evidence risks an immediate soft-switch-away (flap); treat
    // unknown as not-safe-to-restore and retain the above-threshold current member.
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 500,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15, cooldownMs: 100 },
      members: [member('primary', 10, 1), member('backup', 20, 2)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('does not restore a primary that is at/below the soft-switch threshold (avoids restore-then-flap)', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['primary', {
        providerResetsAtMs: 500,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 400,
        quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 5 },
      }],
      ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 80 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'backup',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15 },
      members: [member('primary', 10, 1), member('backup', 20, 2)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('does not let quota headroom erase unrelated auth, capacity, plan, or validation failures', () => {
    const state = {
      credentialHealthStatus: 'needs_reauth' as const,
      authInvalidUntilMs: 10_000,
      capacityLimitedUntilMs: 10_000,
      planUnavailableUntilMs: 10_000,
      validationBlockedUntilMs: 10_000,
      cooldownStartedAtMs: 900,
      cooldownUntilMs: 10_000,
      exhaustedUntilMs: 10_000,
      quotaExhaustedUntilMs: 10_000,
      rateLimitedUntilMs: 10_000,
      providerResetsAtMs: 10_000,
      lastFailureKind: 'auth_expired',
      lastObservedAtMs: 900,
    };
    const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      state,
      quotaSnapshot: {
        capturedAtMs: 1_000,
        effectiveMeterId: 'daily',
        effectiveRemainingPercent: 80,
        meters: [
          { meterId: 'daily', limitCategory: 'usage_limit', remainingPct: 80, resetAtMs: null, providerLimitId: 'daily' },
          { meterId: 'minute', limitCategory: 'rate_limit', remainingPct: 80, resetAtMs: null, providerLimitId: 'minute' },
        ],
      },
      policy: basePolicy,
      nowMs: 1_000,
    });

    expect(reconciled).toBe(state);
  });

  it('does not make reconnect-required credentials selectable from quota headroom alone', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('low-no-window', 1, 1),
        member('high-stale-window', 1, 2),
      ],
      memberStatesByProfileId: new Map([
        ['low-no-window', {
          quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 25 },
        }],
        ['high-stale-window', {
          credentialHealthStatus: 'needs_reauth',
          authInvalidUntilMs: 10_000,
          cooldownUntilMs: 10_000,
          lastFailureKind: 'auth_expired',
          lastObservedAtMs: 900,
          quotaSnapshot: { capturedAtMs: 1_000, effectiveMeterId: 'daily', effectiveRemainingPercent: 90 },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('low-no-window');
    expect(result.excluded).toContainEqual(expect.objectContaining({
      profileId: 'high-stale-window',
      reason: 'auth_invalid',
    }));
  });

  it('clears reconnect-required state only from matching credential-refresh evidence', () => {
    const reconciled = reconcileMemberRuntimeStateWithPositiveEvidence({
      state: {
        credentialHealthStatus: 'needs_reauth',
        authInvalidUntilMs: 10_000,
        capacityLimitedUntilMs: 10_000,
        planUnavailableUntilMs: 10_000,
        validationBlockedUntilMs: 10_000,
        cooldownStartedAtMs: 900,
        cooldownUntilMs: 10_000,
        exhaustedUntilMs: 10_000,
        quotaExhaustedUntilMs: 10_000,
        rateLimitedUntilMs: 10_000,
        providerResetsAtMs: 10_000,
        lastFailureKind: 'auth_expired',
        lastObservedAtMs: 900,
      },
      evidence: {
        kind: 'credential_refresh',
        observedAtMs: 1_000,
      },
      policy: basePolicy,
      nowMs: 1_000,
    });

    expect(reconciled).toEqual({
      capacityLimitedUntilMs: 10_000,
      planUnavailableUntilMs: 10_000,
      quotaExhaustedUntilMs: 10_000,
      rateLimitedUntilMs: 10_000,
      validationBlockedUntilMs: 10_000,
      providerResetsAtMs: 10_000,
    });
  });

  it('ranks least-limited candidates by generic effective meter headroom', () => {
    const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['gemini-daily', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ['future-model', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'model:gpt-6', effectiveRemainingPercent: 65 } }],
      ['weekly', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 5 } }],
    ]);

    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('weekly', 1, 1),
        member('gemini-daily', 1, 2),
        member('future-model', 1, 3),
      ],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('future-model');
  });

  it('honors provider reset timestamps as cooldown floors', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: {
        ...basePolicy,
        strategy: 'priority',
        cooldownMs: 100,
        honorProviderResetsAt: true,
      },
      members: [
        member('reset-later', 1, 1),
        member('ready', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reset-later', { cooldownStartedAtMs: 500, providerResetsAtMs: 2_000 }],
      ]),
    });

    expect(result.selected?.profileId).toBe('ready');
    expect(result.excluded).toContainEqual({
      profileId: 'reset-later',
      reason: 'cooldown',
      retryAtMs: 2_000,
    });
  });

  it('does not treat provider reset timestamps as cooldowns without a blocking state', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: {
        ...basePolicy,
        strategy: 'priority',
        honorProviderResetsAt: true,
      },
      members: [
        member('active', 1, 1),
        member('healthy-backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['healthy-backup', {
          providerResetsAtMs: 2_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 88,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy-backup');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'healthy-backup',
      reason: 'cooldown',
    }));
  });

  it('clears stale cooldown blockers when fresh usable quota evidence proves the member is healthy', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: {
        ...basePolicy,
        strategy: 'least_limited',
        cooldownMs: 30_000,
        honorProviderResetsAt: true,
        softSwitchRemainingPercent: 15,
      },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', {
          cooldownStartedAtMs: 900,
          cooldownUntilMs: 60_000,
          providerResetsAtMs: 60_000,
          quotaSnapshot: {
            capturedAtMs: 950,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 52,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 950,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'active',
      reason: 'cooldown',
    }));
  });

  it('removes generic cooldown fields from reconciled runtime state when fresh quota is usable', () => {
    const reconciled = reconcileMemberRuntimeStateWithFreshQuotaEvidence({
      quotaFreshnessMs: 60_000,
      nowMs: 1_000,
      policy: {
        ...basePolicy,
        cooldownMs: 30_000,
        honorProviderResetsAt: true,
      },
      state: {
        cooldownStartedAtMs: 900,
        cooldownUntilMs: 60_000,
        exhaustedUntilMs: 60_000,
        providerResetsAtMs: 60_000,
      },
      quotaSnapshot: {
        capturedAtMs: 950,
        effectiveMeterId: 'weekly',
        effectiveRemainingPercent: 52,
      },
    });

    expect(reconciled).toEqual({
      providerResetsAtMs: 60_000,
    });
  });

  it('starts on the current low-quota member when no safe better candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, exhausted: true }, providerResetsAtMs: 5_000 }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).toContainEqual({
      profileId: 'backup',
      reason: 'quota_exhausted',
      retryAtMs: 5_000,
    });
  });

  it('switches from a low-quota current member only when a safe better candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('soft-switches from a low-quota current member under priority strategy when a safer candidate exists', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'priority', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 75 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('backup');
  });

  it('keeps the current member when it is above the soft-switch threshold', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 50 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 90 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
  });

  it('keeps the current member below threshold when candidates are not better', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 10 } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 5 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
  });

  it('separates capacity backoff from account quota exhaustion', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('capacity-limited', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['capacity-limited', { capacityLimitedUntilMs: 5_000 }],
      ]),
    });

    expect(result.selected).toBeNull();
    expect(result.excluded).toContainEqual({
      profileId: 'capacity-limited',
      reason: 'capacity_limited',
      retryAtMs: 5_000,
    });
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'capacity-limited',
      reason: 'quota_exhausted',
    }));
  });

  it('excludes persisted quota and rate exhaustion from selector ranking after restart', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('quota-exhausted', 1, 1),
        member('rate-limited', 2, 2),
        member('healthy', 3, 3),
      ],
      memberStatesByProfileId: new Map([
        ['quota-exhausted', { quotaExhaustedUntilMs: 5_000 }],
        ['rate-limited', { rateLimitedUntilMs: 4_000 }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'quota-exhausted', reason: 'quota_exhausted', retryAtMs: 5_000 },
      { profileId: 'rate-limited', reason: 'quota_exhausted', retryAtMs: 4_000 },
    ]));
  });

  it('uses fresh usable quota evidence to ignore stale future quota blockers in the same selection pass', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('blocked-but-usable', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['blocked-but-usable', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 500,
          providerResetsAtMs: 10_000,
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 75,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 75,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('blocked-but-usable');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'blocked-but-usable',
    }));
  });

  it('does not treat a future-dated quota observation as fresh soft-switch evidence', () => {
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...basePolicy,
        softSwitchRemainingPercent: 15,
      },
      memberStatesByProfileId: new Map([[
        'active',
        {
          quotaSnapshot: {
            capturedAtMs: 10_000,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 0,
          },
        },
      ]]),
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
    })).toEqual({ status: 'unknown', reason: 'missing_fresh_quota_snapshot' });
  });

  it('keeps a true fresh secondary quota blocker and uses its fresh reset instead of stale persisted reset', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('weekly-exhausted', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['weekly-exhausted', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 500,
          providerResetsAtMs: 4_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'primary',
            effectiveRemainingPercent: 80,
            exhausted: true,
            meters: [
              {
                meterId: 'primary',
                limitCategory: 'usage_limit',
                remainingPct: 80,
                resetAtMs: 2_000,
                providerLimitId: 'primary',
              },
              {
                meterId: 'weekly',
                limitCategory: 'usage_limit',
                remainingPct: 0,
                resetAtMs: 4_000,
                providerLimitId: 'weekly',
              },
            ],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual({
      profileId: 'weekly-exhausted',
      reason: 'quota_exhausted',
      retryAtMs: 4_000,
    });
  });

  it('retains a same-category blocker when quota evidence was captured during the recent failure cooldown', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('just-proven-usable', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['just-proven-usable', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_050,
          quotaSnapshot: {
            capturedAtMs: 1_060,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 90,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 1_060, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual(expect.objectContaining({
      profileId: 'just-proven-usable',
      reason: 'quota_exhausted',
    }));
  });

  it('does not clear a same-category quota blocker from stale evidence after a newer provider failure', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('just-failed', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['just-failed', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 1_050,
          quotaSnapshot: {
            capturedAtMs: 1_040,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 90,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 90,
              resetAtMs: 4_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['fallback', { quotaSnapshot: { capturedAtMs: 1_060, effectiveMeterId: 'weekly', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual({
      profileId: 'just-failed',
      reason: 'quota_exhausted',
      retryAtMs: 1_550,
    });
  });

  it('emits candidate-level decision traces when stale source quota blocks automatic selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 61_100,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited', softSwitchRemainingPercent: 15 },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', {
          quotaSnapshot: {
            capturedAtMs: 1,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 2,
          },
        }],
        ['backup', {
          quotaSnapshot: {
            capturedAtMs: 61_090,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 80,
          },
        }],
      ]),
      allowCurrentProfileRetry: true,
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result).toMatchObject({
      decisionTrace: expect.objectContaining({
        activeProfileId: 'active',
        reason: 'selected',
        candidates: expect.arrayContaining([
          expect.objectContaining({
            profileId: 'active',
            decision: 'selected',
            quotaEvidence: expect.objectContaining({
              status: 'stale_or_missing',
            }),
          }),
          expect.objectContaining({
            profileId: 'backup',
            decision: 'eligible',
            quotaEvidence: expect.objectContaining({
              status: 'fresh',
              remainingPercent: 80,
            }),
          }),
        ]),
      }),
    });
  });

  it('allows quota-unknown targets only for hard usage-limit recovery', () => {
    const emptyStates = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>();

    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'usage_limit',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(true);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'same_provider_account_exhausted',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(true);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'soft_threshold',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(false);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'auth_expired',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: emptyStates,
    })).toBe(false);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'same_provider_account_exhausted',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: new Map([
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 0,
          },
        }],
      ]),
    })).toBe(false);
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'usage_limit',
      profileId: 'fallback',
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      memberStatesByProfileId: new Map([
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 0,
          },
        }],
      ]),
    })).toBe(false);
  });

  it('applies policy fallback cooldowns to recent rate-limit and capacity failures without provider timing', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('rate-limited', 1, 1),
        member('capacity-limited', 2, 2),
        member('fallback', 3, 3),
      ],
      memberStatesByProfileId: new Map([
        ['rate-limited', {
          lastFailureKind: 'rate_limit',
          lastObservedAtMs: 750,
        }],
        ['capacity-limited', {
          lastFailureKind: 'capacity',
          lastObservedAtMs: 750,
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'rate-limited', reason: 'quota_exhausted', retryAtMs: 1_250 },
      { profileId: 'capacity-limited', reason: 'capacity_limited', retryAtMs: 1_250 },
    ]));
  });

  it('temporarily excludes recently observed usage-limit failures when no reset timestamp was available', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited', cooldownMs: 500 },
      members: [
        member('recently-limited', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['recently-limited', {
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 750,
        }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 30 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toContainEqual({
      profileId: 'recently-limited',
      reason: 'quota_exhausted',
      retryAtMs: 1_250,
    });
  });

  it('does not let unknown quota outrank known healthy quota', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('unknown', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 60 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
  });

  it('excludes auth, plan, and validation blockers from quota ranking', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('auth-blocked', 1, 1),
        member('plan-blocked', 2, 2),
        member('validation-blocked', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['auth-blocked', { authInvalidUntilMs: 5_000 }],
        ['plan-blocked', { planUnavailableUntilMs: 5_000 }],
        ['validation-blocked', { validationBlockedUntilMs: 5_000 }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 40 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'auth-blocked', reason: 'auth_invalid', retryAtMs: 5_000 },
      { profileId: 'plan-blocked', reason: 'plan_unavailable', retryAtMs: 5_000 },
      { profileId: 'validation-blocked', reason: 'validation_blocked', retryAtMs: 5_000 },
    ]));
  });

  it('excludes reconnect-required credential health from automatic selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('reauth', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reauth', { credentialHealthStatus: 'needs_reauth' } as ConnectedServiceAuthGroupMemberRuntimeState],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toContainEqual({
      profileId: 'reauth',
      reason: 'auth_invalid',
    });
  });

  it('reports reconnect-required credential health before current-active masking', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'reauth',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('reauth', 1, 1),
        member('healthy', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reauth', {
          credentialHealthStatus: 'needs_reauth',
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toContainEqual({
      profileId: 'reauth',
      reason: 'auth_invalid',
    });
    expect(result.excluded).not.toContainEqual({
      profileId: 'reauth',
      reason: 'current_active',
    });
    expect(result.decisionTrace.candidates).toContainEqual(expect.objectContaining({
      profileId: 'reauth',
      decision: 'excluded',
      exclusionReason: 'auth_invalid',
      quotaEvidence: {
        status: 'stale_or_missing',
      },
    }));
  });

  it('keeps retryable credential-health states selectable while excluding reconnect-required health', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('refreshing', 1, 1),
        member('retryable-refresh-failed', 2, 2),
        member('reauth', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['refreshing', { credentialHealthStatus: 'refreshing' }],
        ['retryable-refresh-failed', { credentialHealthStatus: 'refresh_failed_retryable' }],
        ['reauth', { credentialHealthStatus: 'needs_reauth' }],
        ['healthy', { credentialHealthStatus: 'connected' }],
      ]),
    });

    expect(result.selected?.profileId).toBe('refreshing');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'reauth', reason: 'auth_invalid' },
    ]));
    expect(result.excluded).not.toEqual(expect.arrayContaining([
      { profileId: 'refreshing', reason: 'auth_invalid' },
      { profileId: 'retryable-refresh-failed', reason: 'auth_invalid' },
    ]));
  });

  it('excludes snapshot-level eligibility blockers from candidate selection', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('active', 1, 1),
        member('plan-blocked', 2, 2),
        member('capacity-limited', 3, 3),
        member('healthy', 4, 4),
      ],
      memberStatesByProfileId: new Map([
        ['plan-blocked', {
          quotaSnapshot: {
            capturedAtMs: 900,
            meters: [{
              meterId: 'plan',
              limitCategory: 'plan_invalid',
              remainingPct: null,
              resetAtMs: null,
              providerLimitId: 'plan',
            }],
          },
        }],
        ['capacity-limited', {
          quotaSnapshot: {
            capturedAtMs: 900,
            meters: [{
              meterId: 'capacity',
              limitCategory: 'capacity',
              remainingPct: null,
              resetAtMs: 5_000,
              providerLimitId: 'capacity',
            }],
          },
        }],
        ['healthy', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 40 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('healthy');
    expect(result.excluded).toEqual(expect.arrayContaining([
      { profileId: 'plan-blocked', reason: 'plan_unavailable' },
      { profileId: 'capacity-limited', reason: 'capacity_limited', retryAtMs: 5_000 },
    ]));
  });

  it('does not treat non-quota snapshot unavailability as quota exhaustion', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('active', 1, 1),
        member('backup', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['active', { quotaSnapshot: { capturedAtMs: 900, planUnavailable: true } }],
        ['backup', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 20 } }],
      ]),
    });

    expect(result.selected?.profileId).toBe('active');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'active',
      reason: 'quota_exhausted',
    }));
  });

  it('never auto-selects for manual strategy', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'manual' },
      members: [member('backup', 1, 1)],
      memberStatesByProfileId: new Map(),
    });

    expect(result.selected).toBeNull();
    expect(result.reason).toBe('manual_strategy');
  });
});

describe('provider credits keep spent accounts usable', () => {
  const nowMs = 1_000;
  const window = (remainingPct: number): ConnectedServiceQuotaMeterV1 => ({
    meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown',
    utilizationPct: 100 - remainingPct, remainingPct, resetsAt: 500_000, resetAtMs: 500_000,
    status: 'ok', confidence: 'exact', details: {},
  });
  const credits = (balance: number): ConnectedServiceQuotaMeterV1 => ({
    meterId: 'credits', label: 'Credits', used: null, limit: null, unit: 'credits', remaining: balance,
    utilizationPct: null, resetsAt: null, status: 'ok', isExhausted: balance <= 0, details: {},
  });
  const project = (meters: ConnectedServiceQuotaMeterV1[]): ConnectedServiceAuthGroupMemberRuntimeState =>
    buildConnectedServiceAuthGroupRuntimeStateFromMeters({ capturedAtMs: 900, meters });
  const states = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
    ['credits-only', project([window(0), credits(16_845)])],
    ['spent', project([window(0), credits(0)])],
    ['included', project([window(30)])],
  ]);
  const select = (params: Partial<Parameters<typeof selectConnectedServiceAuthGroupCandidate>[0]> = {}) =>
    selectConnectedServiceAuthGroupCandidate({
      nowMs,
      quotaFreshnessMs: 60_000,
      activeProfileId: null,
      policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'priority' }),
      members: [member('credits-only', 1, 1), member('spent', 2, 2), member('included', 3, 3)],
      memberStatesByProfileId: states,
      ...params,
    });

  it('ranks included quota before credits-only and excludes accounts with neither', () => {
    const selection = select();
    expect(selection.selected?.profileId).toBe('included');
    expect(selection.excluded).toEqual([expect.objectContaining({ profileId: 'spent', reason: 'quota_exhausted' })]);
    expect(selection.decisionTrace.candidates).toContainEqual(expect.objectContaining({
      profileId: 'credits-only', decision: 'eligible', quotaEvidence: expect.objectContaining({ exhausted: false, creditsOnly: true }),
    }));
    expect(select({ members: [member('credits-only', 1, 1), member('spent', 2, 2)] }).selected?.profileId).toBe('credits-only');
  });

  it('keeps a working credits-only account instead of moving it to a spent account', () => {
    expect(select({
      activeProfileId: 'credits-only',
      allowCurrentProfileRetry: true,
      members: [member('spent', 1, 1), member('credits-only', 2, 2)],
    }).selected?.profileId).toBe('credits-only');
    expect(hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason({
      reason: 'usage_limit', profileId: 'credits-only', nowMs, quotaFreshnessMs: 60_000, memberStatesByProfileId: states,
    })).toBe(true);
    expect(select({
      activeProfileId: 'included', switchReason: 'soft_threshold',
      members: [member('included', 1, 1), member('credits-only', 2, 2)],
    }).excluded).toContainEqual(expect.objectContaining({ profileId: 'credits-only', reason: 'soft_threshold_not_met' }));
  });

  it('keeps the provider usage-limit error authoritative over credit headroom', () => {
    const limited = new Map(states);
    limited.set('credits-only', {
      ...states.get('credits-only')!,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 950,
      quotaExhaustedUntilMs: 400_000,
    });
    const selection = select({
      activeProfileId: 'credits-only',
      allowCurrentProfileRetry: true,
      switchReason: 'usage_limit',
      memberStatesByProfileId: limited,
      members: [member('credits-only', 1, 1), member('included', 2, 2)],
    });
    expect(selection.selected?.profileId).toBe('included');
    expect(selection.excluded).toContainEqual(expect.objectContaining({ profileId: 'credits-only', reason: 'quota_exhausted' }));
  });
});
