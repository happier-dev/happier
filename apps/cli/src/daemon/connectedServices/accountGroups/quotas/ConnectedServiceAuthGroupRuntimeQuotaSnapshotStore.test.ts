import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
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
          },
          {
            meterId: 'weekly',
            limitCategory: 'usage_limit',
            remainingPct: 5,
            resetAtMs: 9_000,
            providerLimitId: null,
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
});
