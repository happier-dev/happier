import { describe, expect, it } from 'vitest';

import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, selectConnectedServiceAuthGroupCandidate } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { createProviderAccountUsageStore } from '../../accountUsage/store';
import { buildConnectedServiceAuthGroupSwitchStateFromAccountUsage } from './buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';

function createGroup(): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    activeProfileId: 'exhausted',
    generation: 4,
    runtimeStateRevision: 0,
    state: {},
    createdAt: 1,
    updatedAt: 2,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      switchOn: {
        ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1.switchOn,
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: true,
      },
    },
    members: [
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'exhausted',
        enabled: true,
        priority: 1,
        createdAt: 1,
        updatedAt: 1,
        state: { credentialHealthStatus: 'connected' },
      },
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'fresh',
        enabled: true,
        priority: 2,
        createdAt: 2,
        updatedAt: 2,
        state: { credentialHealthStatus: 'connected' },
      },
    ],
  };
}

function createSnapshot(profileId: string, remainingPct: number): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: `acct_${profileId}`,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: 1_000,
    fetchedAtMs: 1_000,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: 100 - remainingPct,
      limit: 100,
      remaining: remainingPct,
      remainingPct,
      usedPct: 100 - remainingPct,
      utilizationPct: 100 - remainingPct,
      resetsAt: 10_000,
      resetAtMs: 10_000,
      unit: 'credits',
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

function createMultiLimitSnapshot(profileId: string): ProviderAccountUsageSnapshotV1 {
  const snapshot = createSnapshot(profileId, 90);
  return {
    ...snapshot,
    meters: [
      { ...snapshot.meters[0]!, meterId: 'standard:weekly', providerLimitId: 'standard', remainingPct: 90, utilizationPct: 10 },
      { ...snapshot.meters[0]!, meterId: 'spark:weekly', providerLimitId: 'spark', remainingPct: 0, utilizationPct: 100 },
    ],
  };
}

describe('buildConnectedServiceAuthGroupSwitchStateFromAccountUsage', () => {
  it.each(['usage_limit', 'manual'])('selects recovered priority quota while the first member is exhausted from persisted %s provenance', (lastSwitchReason) => {
    const group = createGroup();
    group.members.push({ ...group.members[1]!, profileId: 'fallback', priority: 3 });
    group.activeProfileId = 'fallback';
    group.state = { lastSwitchReason, lastSwitchAt: 400 };
    group.policy = { ...group.policy, strategy: 'priority', autoRestorePrimaryWhenReset: true, softSwitchRemainingPercent: 0 };
    const store = createProviderAccountUsageStore();
    for (const [profileId, remainingPct] of [['exhausted', 0], ['fresh', 37], ['fallback', 9]] as const) {
      store.recordSnapshot(createSnapshot(profileId, remainingPct), { sources: [{
        serviceId: group.serviceId, profileId, bindingKind: 'group_member', groupId: group.groupId, groupGeneration: group.generation,
      }] });
    }
    const { state } = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group, accountUsageStore: store,
    });
    expect(selectConnectedServiceAuthGroupCandidate({ ...state, nowMs: 1_000, quotaFreshnessMs: 300_000,
      allowCurrentProfileRetry: true }).selected?.profileId).toBe(lastSwitchReason === 'usage_limit' ? 'fresh' : 'fallback');
  });

  it.each([
    { name: 'earlier weekly reset despite less headroom', left: 40, reset: 10_000, expected: 'early' },
    { name: 'headroom before urgency below the soft threshold', left: 14, reset: 10_000, expected: 'fresh' },
    { name: 'fresh nonrenewing subscription', left: 40, reset: 30_000, renewal: 'off', end: 5_000, expected: 'early' },
    { name: 'renewing billing period is not expiry', left: 40, reset: 30_000, renewal: 'on', end: 5_000, expected: 'fresh' },
    { name: 'stale subscription is only missing preference', left: 40, reset: 30_000, renewal: 'off', end: 5_000, subscriptionAge: 600_000, expected: 'fresh' },
    { name: 'passed subscription date is not urgency', left: 40, reset: 30_000, renewal: 'off', end: 900, expected: 'fresh' },
  ] as const)('default selection uses $name', (scenario) => {
    const group = createGroup();
    group.members.push({ ...group.members[1]!, profileId: 'early', priority: 3 });
    const early = createSnapshot('early', scenario.left);
    early.meters[0] = { ...early.meters[0]!, resetsAt: scenario.reset, resetAtMs: scenario.reset, windowDurationMs: 604_800_000 };
    if ('renewal' in scenario && scenario.renewal !== undefined) early.subscription = {
      status: 'subscribed', renewal: scenario.renewal, observedAtMs: 'subscriptionAge' in scenario ? 0 : 1_000,
      staleAfterMs: 'subscriptionAge' in scenario ? 500 : 300_000, currentPeriodEndAtMs: scenario.end,
    };
    const store = createProviderAccountUsageStore();
    for (const snapshot of [createSnapshot('exhausted', 0), createSnapshot('fresh', 95), early]) {
      if (snapshot.recordKey.accountSubjectId === 'acct_fresh') snapshot.meters[0] = {
        ...snapshot.meters[0]!, resetAtMs: 20_000, resetsAt: 20_000, windowDurationMs: 604_800_000,
      };
      store.recordSnapshot(snapshot, { sources: [{ serviceId: group.serviceId, profileId: snapshot.recordKey.accountSubjectId.replace('acct_', ''),
        bindingKind: 'group_member', groupId: group.groupId, groupGeneration: group.generation }] });
    }
    const { state } = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({ group, accountUsageStore: store });
    expect(selectConnectedServiceAuthGroupCandidate({ ...state, nowMs: 1_000, quotaFreshnessMs: 300_000 }).selected?.profileId).toBe(scenario.expected);
  });

  it('prefers the long allowance reset rather than an unrelated earlier short window', () => {
    const group = createGroup();
    group.members[0] = { ...group.members[0]!, profileId: 'early' };
    const early = createSnapshot('early', 40);
    early.meters[0] = { ...early.meters[0]!, resetAtMs: 10_000, windowDurationMs: 604_800_000 };
    const fresh = createSnapshot('fresh', 95);
    fresh.meters = [
      { ...fresh.meters[0]!, resetAtMs: 20_000, windowDurationMs: 604_800_000 },
      { ...fresh.meters[0]!, meterId: 'session', resetAtMs: 2_000, windowDurationMs: 18_000_000 },
    ];
    const { state } = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group, accountUsageStore: { resolveBySource: (source) => source.profileId === 'early' ? early : fresh },
    });
    expect(selectConnectedServiceAuthGroupCandidate({ ...state, activeProfileId: null, nowMs: 1_000, quotaFreshnessMs: 300_000 }).selected?.profileId).toBe('early');
  });

  it('derives every switching field from the pool-selected provider limits', () => {
    const group = createGroup();
    group.policy.quotaLimitSelection = { mode: 'selected', providerLimitIds: ['standard'] };
    const snapshot = createMultiLimitSnapshot('exhausted');
    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore: { resolveBySource: () => snapshot },
    });

    expect(result.state.memberStatesByProfileId.get('exhausted')?.quotaSnapshot).toMatchObject({
      exhausted: false,
      effectiveRemainingPercent: 90,
      effectiveMeterId: 'standard:weekly',
      meters: [expect.objectContaining({ providerLimitId: 'standard' })],
    });
  });

  it('keeps a selected but currently unreported limit unknown instead of falling back to all meters', () => {
    const group = createGroup();
    group.policy.quotaLimitSelection = { mode: 'selected', providerLimitIds: ['future-limit'] };
    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore: { resolveBySource: () => createMultiLimitSnapshot('exhausted') },
    });
    expect(result.state.memberStatesByProfileId.get('exhausted')?.quotaSnapshot).toMatchObject({
      effectiveMeterId: null,
      effectiveRemainingPercent: null,
      meters: [],
    });
    expect(result.state.memberStatesByProfileId.get('exhausted')?.quotaSnapshot).not.toHaveProperty('exhausted');
  });
  it('builds group member runtime state from source-backed provider usage using the active group generation', () => {
    const group = createGroup();
    const exhausted = createSnapshot('exhausted', 0);
    const fresh = createSnapshot('fresh', 90);
    const accountUsageStore = {
      resolveBySource: (source: { profileId: string; groupGeneration?: number }) => {
        if (source.groupGeneration !== 4) return null;
        if (source.profileId === 'exhausted') return exhausted;
        if (source.profileId === 'fresh') return fresh;
        return null;
      },
    };

    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore,
    });

    expect(result?.state.memberStatesByProfileId.get('exhausted')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
      quotaSnapshot: expect.objectContaining({
        exhausted: true,
        effectiveRemainingPercent: 0,
      }),
    }));
    expect(result?.state.memberStatesByProfileId.get('fresh')?.quotaSnapshot?.effectiveRemainingPercent).toBe(90);
    expect(result?.sourceRefsByProfileId.get('fresh')).toEqual(expect.objectContaining({
      recordId: fresh.recordId,
      source: {
        serviceId: 'openai-codex',
        profileId: 'fresh',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 4,
      },
    }));
  });

  it('returns a provisional persisted-member state when the account-usage store has no source-backed records', () => {
    const group = createGroup();
    const accountUsageStore = {
      resolveBySource: () => null,
    };

    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({
      group,
      accountUsageStore,
    });

    expect(result).toMatchObject({
      kind: 'provisional',
      state: expect.objectContaining({
        serviceId: 'openai-codex',
        groupId: 'team',
        activeProfileId: 'exhausted',
        generation: 4,
      }),
    });
    expect(result?.state.memberStatesByProfileId.get('exhausted')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
    }));
    expect(result?.state.memberStatesByProfileId.get('fresh')).toEqual(expect.objectContaining({
      credentialHealthStatus: 'connected',
    }));
    expect(result?.sourceRefsByProfileId.size).toBe(0);
  });
});
