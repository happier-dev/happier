import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  selectConnectedServiceAuthGroupCandidate,
  type ConnectedServiceAuthGroupMemberRuntimeState,
} from './selectConnectedServiceAuthGroupCandidate';

const basePolicy = DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1;

function member(profileId: string, priority: number, createdAtMs: number) {
  return {
    profileId,
    priority,
    createdAtMs,
    enabled: true,
  };
}

describe('selectConnectedServiceAuthGroupCandidate', () => {
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
          quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'daily', effectiveRemainingPercent: 90 },
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

  it('uses fresh usable quota evidence instead of stale persisted quota exhaustion in the same selection pass', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('was-blocked', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['was-blocked', {
          quotaExhaustedUntilMs: 10_000,
          providerResetsAtMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 800,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 75,
          },
        }],
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 50,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('was-blocked');
    expect(result.excluded).not.toContainEqual(expect.objectContaining({
      profileId: 'was-blocked',
    }));
  });

  it('preserves a true exhausted quota meter even when another fresh meter has headroom', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority' },
      members: [
        member('weekly-exhausted', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['weekly-exhausted', {
          quotaExhaustedUntilMs: 10_000,
          providerResetsAtMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 800,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'primary',
            effectiveRemainingPercent: 91,
            meters: [
              {
                meterId: 'primary',
                limitCategory: 'usage_limit',
                remainingPct: 91,
                resetAtMs: null,
                providerLimitId: 'primary',
              },
              {
                meterId: 'weekly',
                limitCategory: 'usage_limit',
                remainingPct: 0,
                resetAtMs: 5_000,
                providerLimitId: 'weekly',
              },
            ],
          },
        }],
        ['fallback', {
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 50,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('fallback');
    expect(result.excluded).toContainEqual({
      profileId: 'weekly-exhausted',
      reason: 'quota_exhausted',
      retryAtMs: 5_000,
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
      expect.objectContaining({ profileId: 'plan-blocked', reason: 'plan_unavailable' }),
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
