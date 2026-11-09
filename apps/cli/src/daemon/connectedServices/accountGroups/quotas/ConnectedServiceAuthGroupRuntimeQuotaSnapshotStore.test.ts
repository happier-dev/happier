import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
  selectConnectedServiceAuthGroupCandidate,
} from '../selection/selectConnectedServiceAuthGroupCandidate';

function quotaSnapshot(input: Readonly<{
  profileId: string;
  fetchedAt: number;
  utilizationPct: number;
  resetAtMs?: number | null;
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
        resetsAt: input.resetAtMs ?? null,
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
    store.retainProfileSnapshots({ ...binding, context: null });
    expect(store.getSnapshot(binding)).toEqual(latest);
    store.retainProfileSnapshots({ ...binding, context, verifiedCredentialFingerprint: 'credential-one' });
    expect(store.getSnapshotEntry(binding)).toEqual({ snapshot: latest, verifiedCredentialFingerprint: 'credential-one' });

    store.retainProfileSnapshots({ ...binding, context: { ...context, providerAccountId: 'other-user' } });
    expect(store.getSnapshot(binding)).toBeNull();

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



  it('drops mismatching profile projections while retaining matching and other-profile snapshots', () => {
    const store = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    const binding = { serviceId: 'openai-codex', profileId: 'primary', groupGeneration: 1 } as const;
    const snapshot = (profileId: string, fetchedAt: number, utilizationPct: number, providerOrganizationId: string) => ({
      ...quotaSnapshot({ profileId, fetchedAt, utilizationPct }),
      activeAccountId: 'account-user', providerOrganizationId,
    });
    store.recordSnapshot({ ...binding, groupId: 'old-group', snapshot: snapshot('primary', 1_000, 10, 'org-a') });
    store.recordSnapshot({ ...binding, groupId: 'old-group', snapshot: snapshot('primary', 3_000, 30, 'org-a') });
    store.recordSnapshot({ ...binding, groupId: 'current-group', snapshot: snapshot('primary', 2_000, 20, 'org-b') });
    store.recordSnapshot({ ...binding, groupId: 'old-group', profileId: 'other', snapshot: snapshot('other', 3_000, 40, 'org-a') });

    store.retainProfileSnapshots({ ...binding, context: {
      providerAccountId: 'account-user', providerOrganizationId: 'org-b',
    } });

    expect(store.getSnapshot({ ...binding, groupId: 'old-group' })).toBeNull();
    expect(store.getSnapshot({ ...binding, groupId: 'current-group' })).toMatchObject({ providerOrganizationId: 'org-b' });
    expect(store.getSnapshot({ ...binding, groupId: 'old-group', profileId: 'other' })).toMatchObject({ providerOrganizationId: 'org-a' });
    store.retainProfileSnapshots({ ...binding, context: null });
    expect(store.getSnapshot({ ...binding, groupId: 'current-group' })).toBeNull();
    expect(store.getSnapshot({ ...binding, groupId: 'old-group', profileId: 'other' })).not.toBeNull();
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
      subscription: undefined,
      quotaSnapshot: {
        staleAfterMs: 60_000,
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
            reliable: true,
            windowDurationMs: null,
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
      subscription: undefined,
      quotaSnapshot: {
        staleAfterMs: 60_000,
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
            reliable: true,
            windowDurationMs: null,
          },
          {
            meterId: 'weekly',
            limitCategory: 'usage_limit',
            remainingPct: 5,
            resetAtMs: 9_000,
            providerLimitId: null,
            reliable: true,
            windowDurationMs: null,
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
      activeProfileId: null,
      policy: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V2,
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
      subscription: undefined,
      quotaSnapshot: {
        staleAfterMs: 60_000,
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
            reliable: true,
            windowDurationMs: null,
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
});
