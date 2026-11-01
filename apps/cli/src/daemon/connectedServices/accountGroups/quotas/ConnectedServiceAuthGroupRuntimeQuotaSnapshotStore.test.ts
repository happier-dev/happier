import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
  resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence,
  selectConnectedServiceAuthGroupCandidate,
} from '../selection/selectConnectedServiceAuthGroupCandidate';

function quotaSnapshot(input: Readonly<{
  profileId: string;
  fetchedAt: number;
  utilizationPct: number;
}>) {
  return {
    v: 1 as const,
    serviceId: 'openai-codex' as const,
    profileId: input.profileId,
    fetchedAt: input.fetchedAt,
    staleAfterMs: 60_000,
    planLabel: null,
    accountLabel: null,
    meters: [
      {
        meterId: 'weekly',
        label: 'Weekly',
        used: null,
        limit: null,
        unit: 'unknown' as const,
        utilizationPct: input.utilizationPct,
        resetsAt: null,
        status: 'ok' as const,
        details: {},
      },
    ],
  };
}

describe('ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore', () => {
  it('preserves verified unscoped quota through unavailable proof reads until an authoritative mismatch', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'openai-codex', groupId: 'main', profileId: 'primary' } as const;
    const context = { providerAccountId: 'account-user', providerOrganizationId: 'org-current' };
    const snapshot = (fetchedAt: number, utilizationPct: number) => ({
      ...quotaSnapshot({ profileId: 'primary', fetchedAt, utilizationPct }), activeAccountId: 'account-user',
    });
    store.recordSnapshot({ ...binding, snapshot: snapshot(1_000, 10), verifiedCredentialFingerprint: 'credential-one' });
    const latest = snapshot(2_000, 20);
    store.recordSnapshot({ ...binding, snapshot: latest, verifiedCredentialFingerprint: 'credential-one' });

    store.retainProfileSnapshots({ ...binding, context });
    expect(store.getSnapshot(binding)).toEqual(latest);
    expect(store.getRecentBurn(binding)).not.toBeNull();
    store.retainProfileSnapshots({ ...binding, context: null });
    expect(store.getSnapshot(binding)).toEqual(latest);
    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-one' });
    expect(store.getSnapshotEntry(binding)).toEqual({ snapshot: latest, verifiedCredentialFingerprint: 'credential-one' });

    store.retainProfileSnapshots({ ...binding, context: { ...context, providerAccountId: 'other-user' } });
    expect(store.getSnapshot(binding)).toBeNull();
    expect(store.getRecentBurn(binding)).toBeNull();

    store.recordProfileSnapshot({ ...binding, snapshot: latest, verifiedCredentialFingerprint: 'credential-one' });
    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: null });
    expect(store.getSnapshot(binding)).toBeNull();
    store.recordProfileSnapshot({ ...binding, snapshot: latest });
    store.retainProfileSnapshots({ ...binding, context });
    expect(store.getSnapshot(binding)).toBeNull();
  });

  it('retains unscoped local quota only for its verified current credential and user', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'openai-codex', groupId: 'main', profileId: 'primary' } as const;
    const context = { providerAccountId: 'account-user', providerOrganizationId: 'org-current' };
    const snapshot = {
      ...quotaSnapshot({ profileId: 'primary', fetchedAt: 1_000, utilizationPct: 10 }),
      activeAccountId: 'account-user',
    };
    store.recordSnapshot({ ...binding, snapshot, verifiedCredentialFingerprint: 'credential-one' });

    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-one' });

    expect(store.getSnapshot(binding)).toEqual(snapshot);
    expect(store.getSnapshotEntry(binding)).toEqual({ snapshot, verifiedCredentialFingerprint: 'credential-one' });
    expect(store.getSnapshotEntry({ serviceId: binding.serviceId, profileId: binding.profileId }))
      .toEqual({ snapshot, verifiedCredentialFingerprint: 'credential-one' });

    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getSnapshot(binding)).toBeNull();
    expect(store.getSnapshotEntry({ serviceId: binding.serviceId, profileId: binding.profileId })).toBeNull();

    store.recordProfileSnapshot({ ...binding, snapshot, verifiedCredentialFingerprint: 'credential-two' });
    store.retainProfileSnapshots({ ...binding, context: { ...context, providerAccountId: 'other-user' },
      verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getSnapshot(binding)).toBeNull();

    store.recordProfileSnapshot({ ...binding, snapshot });
    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getSnapshot(binding)).toBeNull();
  });

  it('retains known organization quota across token rotation but drops an organization change', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'openai-codex', groupId: 'main', profileId: 'primary' } as const;
    const context = { providerAccountId: 'account-user', providerOrganizationId: 'org-one' };
    const snapshot = {
      ...quotaSnapshot({ profileId: 'primary', fetchedAt: 1_000, utilizationPct: 10 }),
      activeAccountId: 'account-user', providerOrganizationId: 'org-one',
    };
    store.recordSnapshot({ ...binding, snapshot, verifiedCredentialFingerprint: 'credential-one' });
    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getSnapshot(binding)).toEqual(snapshot);
    store.retainProfileSnapshots({ ...binding, context: { ...context, providerOrganizationId: 'org-two' },
      verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getSnapshot(binding)).toBeNull();
  });

  it('starts new unscoped burn history when its verified credential changes', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'openai-codex', groupId: 'main', profileId: 'primary', groupGeneration: 1 } as const;
    const snapshot = (fetchedAt: number, utilizationPct: number) => ({
      ...quotaSnapshot({ profileId: 'primary', fetchedAt, utilizationPct }), activeAccountId: 'account-user',
    });
    store.recordSnapshot({ ...binding, snapshot: snapshot(1_000, 10), verifiedCredentialFingerprint: 'credential-one' });
    store.recordSnapshot({ ...binding, snapshot: snapshot(2_000, 30), verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getRecentBurn(binding)).toBeNull();
    store.recordSnapshot({ ...binding, snapshot: snapshot(3_000, 31), verifiedCredentialFingerprint: 'credential-two' });
    expect(store.getRecentBurn(binding)?.remainingPercentPerMs).toBeCloseTo(1 / 1_000, 8);
    store.recordSnapshot({ ...binding, snapshot: snapshot(4_000, 32) });
    expect(store.getRecentBurn(binding)).toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores runtime quota snapshots per service/group/profile and exposes candidate runtime state', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: 1_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'primary',
            label: 'Primary',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 100,
            resetAtMs: 5_000,
            providerLimitId: 'primary_window',
            resetsAt: null,
            status: 'ok',
            details: {},
          },
        ],
      },
    });

    expect(store.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })?.fetchedAt).toBe(1_000);
    expect(store.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: 1_250,
    }).get('primary')).toEqual({
      providerResetsAtMs: 5_000,
      quotaSnapshot: {
        capturedAtMs: 1_000,
        effectiveMeterId: 'primary',
        effectiveRemainingPercent: 0,
        meters: [
          {
            meterId: 'primary',
            limitCategory: 'usage_limit',
            remainingPct: 0,
            resetAtMs: 5_000,
            providerLimitId: 'primary_window',
            windowDurationMs: null,
            reliable: true,
          },
        ],
        exhausted: true,
        planUnavailable: false,
      },
    });
  });

  it('derives candidate runtime state from generic effective quota meters', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordSnapshot({
      serviceId: 'gemini',
      groupId: 'main',
      profileId: 'work',
      snapshot: {
        v: 1,
        serviceId: 'gemini',
        profileId: 'work',
        fetchedAt: 3_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'daily',
            label: 'Daily model requests',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 70,
            resetsAt: 7_000,
            status: 'ok',
            scope: 'daily',
            limitScope: 'model',
            details: {},
          },
          {
            meterId: 'weekly',
            label: 'Weekly model requests',
            used: null,
            limit: null,
            unit: 'unknown',
            remainingPct: 5,
            utilizationPct: 95,
            resetsAt: 9_000,
            status: 'ok',
            scope: 'weekly',
            limitScope: 'model',
            details: {},
          },
        ],
      },
    });

    expect(store.buildMemberStates({
      serviceId: 'gemini',
      groupId: 'main',
      capturedAtMs: 3_500,
    }).get('work')).toEqual({
      providerResetsAtMs: 9_000,
      quotaSnapshot: {
        capturedAtMs: 3_000,
        effectiveMeterId: 'weekly',
        effectiveRemainingPercent: 5,
        meters: [
          {
            meterId: 'daily',
            limitCategory: 'usage_limit',
            remainingPct: 30,
            resetAtMs: 7_000,
            providerLimitId: null,
            windowDurationMs: null,
            reliable: true,
          },
          {
            meterId: 'weekly',
            limitCategory: 'usage_limit',
            remainingPct: 5,
            resetAtMs: 9_000,
            providerLimitId: null,
            windowDurationMs: null,
            reliable: true,
          },
        ],
        exhausted: false,
        planUnavailable: false,
      },
    });
  });

  it('does not own provider-specific raw quota snapshot conversion', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    expect('recordCodexRateLimitSnapshot' in store).toBe(false);

    store.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: 2_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'primary',
            label: 'Primary',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 100,
            resetsAt: 1_000,
            status: 'ok',
            details: {},
          },
        ],
      },
    });
    store.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'backup',
        fetchedAt: 2_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'primary',
            label: 'Primary',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 25,
            resetsAt: null,
            status: 'ok',
            details: {},
          },
        ],
      },
    });

    const selected = selectConnectedServiceAuthGroupCandidate({
      nowMs: 2_500,
      quotaFreshnessMs: 60_000,
      activeProfileId: null,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        strategy: 'least_limited',
        autoSwitch: true,
      },
      members: [
        { profileId: 'primary', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      ],
      memberStatesByProfileId: store.buildMemberStates({
        serviceId: 'openai-codex',
        groupId: 'main',
        capturedAtMs: 2_500,
      }),
    });

    expect(selected.selected?.profileId).toBe('backup');
    expect(selected.excluded).toContainEqual({
      profileId: 'primary',
      reason: 'quota_exhausted',
      retryAtMs: 1_000,
    });
  });

  it('does not collapse capacity meters into quota exhaustion', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: 4_000,
        staleAfterMs: 60_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'server_capacity',
            label: 'Server capacity',
            used: null,
            limit: null,
            unit: 'unknown',
            remainingPct: 0,
            utilizationPct: 100,
            resetsAt: 10_000,
            status: 'ok',
            details: {
              limitCategory: 'capacity',
              providerLimitId: 'server_overloaded',
            },
          },
        ],
      },
    });

    expect(store.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: 4_500,
    }).get('primary')).toEqual({
      providerResetsAtMs: 10_000,
      quotaSnapshot: {
        capturedAtMs: 4_000,
        effectiveMeterId: null,
        effectiveRemainingPercent: null,
        meters: [
          {
            meterId: 'server_capacity',
            limitCategory: 'capacity',
            remainingPct: 0,
            resetAtMs: 10_000,
            providerLimitId: 'server_overloaded',
            windowDurationMs: null,
            reliable: true,
          },
        ],
        exhausted: false,
        planUnavailable: false,
      },
    });
  });

  it('keeps the newer profile quota snapshot when an older persisted snapshot is loaded later', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 2_000, utilizationPct: 10 }),
    });
    store.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 1_000, utilizationPct: 90 }),
    });

    expect(store.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })?.fetchedAt).toBe(2_000);
    expect(store.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: 2_500,
    }).get('primary')?.quotaSnapshot?.effectiveRemainingPercent).toBe(90);
  });

  it('selects the freshest snapshot when group-specific and profile snapshots disagree', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 1_000, utilizationPct: 95 }),
    });
    store.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 2_000, utilizationPct: 15 }),
    });

    expect(store.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })?.fetchedAt).toBe(2_000);
    expect(store.buildMemberStates({
      serviceId: 'openai-codex',
      groupId: 'main',
      capturedAtMs: 2_500,
    }).get('primary')?.quotaSnapshot?.effectiveRemainingPercent).toBe(85);
  });

  it('replaces a retained future-dated snapshot with a current observation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 100_000, utilizationPct: 100 }),
    });
    store.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: quotaSnapshot({ profileId: 'primary', fetchedAt: 10_000, utilizationPct: 10 }),
    });

    expect(store.getSnapshot({
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'primary',
    })).toMatchObject({ fetchedAt: 10_000 });
  });

  it('makes high-utilization Claude passive quota evidence fresh for predictive soft switching', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();

    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: 'active',
        providerId: 'claude',
        fetchedAt: 10_000,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        source: 'in_band_provider_snapshot',
        confidence: 'exact',
        evidence: {
          kind: 'claude_runtime_quota_utilization',
          providerLimitId: 'seven_day',
          observedAtMs: 10_000,
        },
        meters: [
          {
            meterId: 'seven_day',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 92,
            remainingPct: 8,
            resetsAt: 1_779_097_200_000,
            resetAtMs: 1_779_097_200_000,
            status: 'ok',
            source: 'in_band_provider_snapshot',
            scope: 'weekly',
            limitScope: 'account',
            confidence: 'exact',
            details: {
              providerLimitId: 'seven_day',
              limitCategory: 'usage_limit',
            },
          },
        ],
      },
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'backup',
      snapshot: {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: 'backup',
        providerId: 'claude',
        fetchedAt: 10_000,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        source: 'provider_api',
        confidence: 'exact',
        meters: [
          {
            meterId: 'seven_day',
            label: 'Weekly',
            used: null,
            limit: null,
            unit: 'unknown',
            utilizationPct: 20,
            remainingPct: 80,
            resetsAt: null,
            status: 'ok',
            details: {},
          },
        ],
      },
    });

    const memberStatesByProfileId = store.buildMemberStates({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      capturedAtMs: 10_100,
    });

    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
      },
      memberStatesByProfileId,
      nowMs: 10_100,
      quotaFreshnessMs: 300_000,
    })).toEqual({
      status: 'at_or_below_threshold',
      remainingPercent: 8,
      thresholdPercent: 15,
    });

    const selected = selectConnectedServiceAuthGroupCandidate({
      nowMs: 10_100,
      quotaFreshnessMs: 300_000,
      activeProfileId: 'active',
      allowCurrentProfileRetry: true,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        strategy: 'priority',
        softSwitchRemainingPercent: 15,
      },
      members: [
        { profileId: 'active', priority: 1, createdAtMs: 1, enabled: true },
        { profileId: 'backup', priority: 2, createdAtMs: 2, enabled: true },
      ],
      memberStatesByProfileId,
    });

    expect(selected.selected?.profileId).toBe('backup');
    expect(selected.decisionTrace.candidates.find((candidate) => candidate.profileId === 'active')?.quotaEvidence)
      .toMatchObject({
        status: 'fresh',
        remainingPercent: 8,
        capturedAtMs: 10_000,
        exhausted: false,
      });
  });

  it('preemptively reports at_or_below_threshold when projected burn crosses the threshold before the next window', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    // A fast-burning active member: 60% -> 40% remaining across 30s (0.02%/ms burn).
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 60 }),
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 40 }),
    });

    const memberStatesByProfileId = store.buildMemberStates({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      capturedAtMs: 30_000,
    });
    const burn = store.getRecentBurn({ serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active' });
    expect(burn).not.toBeNull();
    expect(burn?.remainingPercentPerMs).toBeCloseTo(20 / 30_000, 10);

    // Current remaining (40%) is above the 15% threshold, but a 300s projection at this burn rate
    // crosses it -> preemptive soft-switch should fire before the hard limit.
    const projected = resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
        probeIfSnapshotOlderThanMs: 300_000,
      },
      memberStatesByProfileId,
      nowMs: 30_000,
      quotaFreshnessMs: 300_000,
      burnProjection: burn ? { remainingPercentPerMs: burn.remainingPercentPerMs, horizonMs: 300_000 } : null,
    });
    expect(projected).toMatchObject({
      status: 'at_or_below_threshold',
      remainingPercent: 40,
      thresholdPercent: 15,
      projected: true,
    });

    // Without the burn projection, the same healthy snapshot stays above threshold.
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
      },
      memberStatesByProfileId,
      nowMs: 30_000,
      quotaFreshnessMs: 300_000,
    })).toMatchObject({ status: 'above_threshold', remainingPercent: 40 });
  });

  it('keeps stale low source evidence actionable only until its known quota reset boundary', () => {
    const memberStatesByProfileId = new Map([[
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
            resetAtMs: 20_000,
            providerLimitId: 'weekly',
          }],
        },
      },
    ]]);
    const input = {
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
      },
      memberStatesByProfileId,
      quotaFreshnessMs: 1_000,
    } as const;

    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      ...input,
      nowMs: 10_000,
    })).toEqual({
      status: 'at_or_below_threshold',
      remainingPercent: 5,
      thresholdPercent: 15,
    });
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      ...input,
      nowMs: 20_000,
    })).toEqual({ status: 'unknown', reason: 'missing_fresh_quota_snapshot' });
  });

  it('does not extend stale low source evidence when the effective quota reset is unknown', () => {
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
      },
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

  it('does not preemptively switch a slow-burning active member whose projection stays above threshold', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    // Slow burn: 60% -> 58% across 30s.
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 60 }),
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 58 }),
    });
    const memberStatesByProfileId = store.buildMemberStates({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      capturedAtMs: 30_000,
    });
    const burn = store.getRecentBurn({ serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active' });
    expect(resolveConnectedServiceAuthGroupSoftSwitchSourceEvidence({
      activeProfileId: 'active',
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        softSwitchRemainingPercent: 15,
        probeIfSnapshotOlderThanMs: 300_000,
      },
      memberStatesByProfileId,
      nowMs: 30_000,
      quotaFreshnessMs: 300_000,
      burnProjection: burn ? { remainingPercentPerMs: burn.remainingPercentPerMs, horizonMs: 300_000 } : null,
    })).toMatchObject({ status: 'above_threshold', remainingPercent: 58 });
  });

  it('returns no burn when remaining is flat or increasing (a reset)', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 40 }),
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription',
      groupId: 'team-pool',
      profileId: 'active',
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 90 }),
    });
    expect(store.getRecentBurn({ serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active' }))
      .toBeNull();
  });

  it('invalidates burn history across group generations and quota windows', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 1,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 60, resetAtMs: 100_000 }),
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 1,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 40, resetAtMs: 100_000 }),
    });
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 1,
    })).not.toBeNull();

    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 60_000, remainingPct: 30, resetAtMs: 100_000 }),
    });
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
    })).toBeNull();

    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 90_000, remainingPct: 20, resetAtMs: 100_000 }),
    });
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
    })).not.toBeNull();

    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 120_000, remainingPct: 15, resetAtMs: 200_000 }),
    });
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 2,
    })).toBeNull();
  });

  it('starts a new burn history when the same profile changes organization without changing group generation', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 1 } as const;
    store.recordSnapshot({ ...binding, snapshot: {
      ...quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 90 }),
      activeAccountId: 'acct-user', providerOrganizationId: 'org-a',
    } });
    store.recordSnapshot({ ...binding, snapshot: {
      ...quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 70 }),
      activeAccountId: 'acct-user', providerOrganizationId: 'org-b',
    } });
    expect(store.getRecentBurn(binding)).toBeNull();
    store.recordSnapshot({ ...binding, snapshot: {
      ...quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 60_000, remainingPct: 69 }),
      activeAccountId: 'acct-user', providerOrganizationId: 'org-b',
    } });
    expect(store.getRecentBurn(binding)?.remainingPercentPerMs).toBeCloseTo(1 / 30_000, 10);
  });

  it('returns burn only when it is current, bounded, and matches the canonical effective snapshot', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 0, remainingPct: 60, resetAtMs: 100_000 }),
    });
    store.recordSnapshot({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      snapshot: quotaSnapshotWithRemaining({ profileId: 'active', fetchedAt: 30_000, remainingPct: 40, resetAtMs: 100_000 }),
    });
    const currentQuotaSnapshot = store.buildMemberStates({
      serviceId: 'claude-subscription', groupId: 'team-pool', capturedAtMs: 30_000,
    }).get('active')?.quotaSnapshot;
    expect(currentQuotaSnapshot).toBeDefined();
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      nowMs: 30_000,
      maxAgeMs: 60_000,
      currentQuotaSnapshot,
    })).not.toBeNull();
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      nowMs: 100_000,
      maxAgeMs: 100_000,
      currentQuotaSnapshot,
    })).toBeNull();
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      nowMs: 100_001,
      maxAgeMs: 60_000,
      currentQuotaSnapshot,
    })).toBeNull();
    expect(store.getRecentBurn({
      serviceId: 'claude-subscription', groupId: 'team-pool', profileId: 'active', groupGeneration: 3,
      nowMs: 30_001,
      maxAgeMs: 60_000,
      currentQuotaSnapshot: currentQuotaSnapshot
        ? { ...currentQuotaSnapshot, capturedAtMs: currentQuotaSnapshot.capturedAtMs + 1 }
        : currentQuotaSnapshot,
    })).toBeNull();
  });
});

function quotaSnapshotWithRemaining(input: Readonly<{
  profileId: string;
  fetchedAt: number;
  remainingPct: number;
  resetAtMs?: number | null;
}>) {
  return {
    v: 1 as const,
    serviceId: 'claude-subscription' as const,
    profileId: input.profileId,
    providerId: 'claude' as const,
    fetchedAt: input.fetchedAt,
    staleAfterMs: 300_000,
    planLabel: null,
    accountLabel: null,
    source: 'provider_api' as const,
    confidence: 'exact' as const,
    meters: [
      {
        meterId: 'seven_day',
        label: 'Weekly',
        used: null,
        limit: null,
        unit: 'unknown' as const,
        utilizationPct: 100 - input.remainingPct,
        remainingPct: input.remainingPct,
        resetsAt: input.resetAtMs ?? null,
        status: 'ok' as const,
        details: { providerLimitId: 'seven_day', limitCategory: 'usage_limit' as const },
      },
    ],
  };
}
