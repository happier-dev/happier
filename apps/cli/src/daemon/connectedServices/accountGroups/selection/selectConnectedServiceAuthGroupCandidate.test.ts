import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  hasConnectedServiceAuthGroupCandidateEvidenceForSwitchReason,
  isConnectedServiceAuthGroupSoftSwitchCandidateMeaningfullyBetter,
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
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

describe('DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1', () => {
  it('is derived from the protocol schema default and stays in lockstep with it', () => {
    // Split-brain hygiene: the daemon default must not diverge from the protocol schema default.
    // Deriving from the schema means a schema-default change (e.g. strategy flip) flows through
    // automatically, with no hand-copied literal to drift.
    expect(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.strategy).toBe(
      ConnectedServiceAuthGroupPolicyV1Schema.parse({}).strategy,
    );
    expect(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1).toEqual(
      ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
    );
  });
});

describe('resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence burn projection', () => {
  const softPolicy = { ...basePolicy, softSwitchRemainingPercent: 20 };
  function activeStates(remainingPercent: number): Map<string, ConnectedServiceAuthGroupMemberRuntimeState> {
    return new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([
      ['active', { quotaSnapshot: { capturedAtMs: 900, effectiveMeterId: 'weekly', effectiveRemainingPercent: remainingPercent } }],
    ]);
  }

  it('preempts a soft-switch when a fast burn projects below threshold within the horizon', () => {
    // remaining 30% (above 20% threshold), burning 0.02%/ms over a 1000ms horizon → projected 10% ≤ 20%.
    const evidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId: activeStates(30),
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      burnProjection: { remainingPercentPerMs: 0.02, horizonMs: 1_000 },
    });
    expect(evidence).toEqual({ status: 'at_or_below_threshold', remainingPercent: 30, thresholdPercent: 20, projected: true });
  });

  it('stays above threshold when the burn is too slow to cross within the horizon', () => {
    const evidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId: activeStates(30),
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      burnProjection: { remainingPercentPerMs: 0.001, horizonMs: 1_000 },
    });
    expect(evidence).toEqual({ status: 'above_threshold', remainingPercent: 30, thresholdPercent: 20 });
  });

  it('stays above threshold with no burn signal (fails closed on reset/flat)', () => {
    const evidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId: activeStates(30),
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      burnProjection: null,
    });
    expect(evidence).toEqual({ status: 'above_threshold', remainingPercent: 30, thresholdPercent: 20 });
  });

  it('reports at_or_below_threshold without a projected flag when already under threshold', () => {
    const evidence = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId: activeStates(15),
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      burnProjection: { remainingPercentPerMs: 0.02, horizonMs: 1_000 },
    });
    expect(evidence).toEqual({ status: 'at_or_below_threshold', remainingPercent: 15, thresholdPercent: 20 });
  });

  it('keeps stale low source evidence actionable only until its known quota reset boundary', () => {
    const memberStatesByProfileId = new Map<string, ConnectedServiceAuthGroupMemberRuntimeState>([[
      'active',
      {
        quotaSnapshot: {
          capturedAtMs: 1_000,
          effectiveMeterId: 'weekly',
          effectiveRemainingPercent: 5,
          meters: [{
            meterId: 'weekly',
            limitCategory: 'usage_limit',
            remainingPct: 5,
            resetAtMs: 20_000,
            providerLimitId: 'weekly',
          }],
        },
      },
    ]]);
    const input = {
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId,
      quotaFreshnessMs: 1_000,
    } as const;

    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      ...input,
      nowMs: 10_000,
    })).toEqual({
      status: 'at_or_below_threshold',
      remainingPercent: 5,
      thresholdPercent: 20,
    });
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      ...input,
      nowMs: 20_000,
    })).toEqual({ status: 'unknown', reason: 'missing_fresh_quota_snapshot' });
  });

  it('does not extend stale low source evidence when the effective quota reset is unknown', () => {
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: softPolicy,
      memberStatesByProfileId: new Map([[
        'active',
        {
          quotaSnapshot: {
            capturedAtMs: 1_000,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 5,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit' as const,
              remainingPct: 5,
              resetAtMs: null,
              providerLimitId: 'weekly',
            }],
          },
        },
      ]]),
      nowMs: 10_000,
      quotaFreshnessMs: 1_000,
    })).toEqual({ status: 'unknown', reason: 'missing_fresh_quota_snapshot' });
  });
});

describe('selectConnectedServiceAuthGroupCandidate', () => {
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
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 15 },
      members: [member('primary', 10, 1), member('backup', 20, 2), member('other', 30, 3)],
      memberStatesByProfileId: states,
    });

    expect(result.selected?.profileId).toBe('primary');
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
      policy: { ...basePolicy, strategy: 'priority', autoRestorePrimaryWhenReset: false, softSwitchRemainingPercent: 15 },
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
        // No fresh quota snapshot on the recently-limited member: a healthy snapshot captured AFTER
        // the failure would (correctly) clear the recent-limiter blocker via
        // reconcileMemberRuntimeStateWithFreshQuotaEvidence — this test pins the no-fresh-evidence
        // exclusion window.
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
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 75,
              resetAtMs: null,
              providerLimitId: 'weekly',
            }],
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

  it('does not use generic headroom to erase an exact usage-limit failure without a matching usage meter', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 1_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'priority', cooldownMs: 500 },
      members: [
        member('reported-exhausted', 1, 1),
        member('fallback', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['reported-exhausted', {
          quotaExhaustedUntilMs: 10_000,
          lastFailureKind: 'usage_limit',
          lastObservedAtMs: 500,
          providerResetsAtMs: 10_000,
          quotaSnapshot: {
            capturedAtMs: 900,
            effectiveMeterId: 'generic',
            effectiveRemainingPercent: 99,
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
    expect(result.excluded).toContainEqual(expect.objectContaining({
      profileId: 'reported-exhausted',
      reason: 'quota_exhausted',
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

  it('does not make auth- or capacity-blocked profiles selectable from quota headroom alone', () => {
    const result = selectConnectedServiceAuthGroupCandidate({
      nowMs: 10_000,
      quotaFreshnessMs: 60_000,
      activeProfileId: 'active',
      policy: { ...basePolicy, strategy: 'least_limited' },
      members: [
        member('stale-auth-blocked', 1, 1),
        member('lower-headroom', 2, 2),
      ],
      memberStatesByProfileId: new Map([
        ['stale-auth-blocked', {
          authInvalidUntilMs: 60_000,
          capacityLimitedUntilMs: 60_000,
          credentialHealthStatus: 'needs_reauth',
          lastFailureKind: 'auth_expired',
          lastObservedAtMs: 1_000,
          quotaSnapshot: {
            capturedAtMs: 9_500,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 92,
            meters: [{
              meterId: 'weekly',
              limitCategory: 'usage_limit',
              remainingPct: 92,
              resetAtMs: 60_000,
              providerLimitId: 'weekly',
            }],
          },
        }],
        ['lower-headroom', {
          quotaSnapshot: {
            capturedAtMs: 9_500,
            effectiveMeterId: 'weekly',
            effectiveRemainingPercent: 40,
          },
        }],
      ]),
    });

    expect(result.selected?.profileId).toBe('lower-headroom');
    expect(result.excluded).toContainEqual(expect.objectContaining({
      profileId: 'stale-auth-blocked',
      reason: 'auth_invalid',
    }));
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
