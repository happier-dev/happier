import { randomBytes } from 'node:crypto';

import {
  buildProviderAccountUsageRecordId,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

type QuotaApi = ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'];

function buildQuotaSnapshot(input: Readonly<{
  serviceId: ConnectedServiceQuotaSnapshotV1['serviceId'];
  profileId: string;
  now: number;
  remainingPct: number;
}>): ConnectedServiceQuotaSnapshotV1 {
  return {
    v: 1,
    serviceId: input.serviceId,
    profileId: input.profileId,
    fetchedAt: input.now,
    staleAfterMs: 300_000,
    planLabel: 'Pro',
    accountLabel: `${input.profileId}@example.test`,
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100 - input.remainingPct,
      remainingPct: input.remainingPct,
      resetsAt: input.now + 600_000,
      status: 'ok',
      details: {},
    }],
  };
}

function buildProviderAccountUsageSnapshot(input: Readonly<{
  profileId: string;
  now: number;
  remainingPct: number;
}>): ProviderAccountUsageSnapshotV1 {
  const recordKey: ProviderAccountUsageRecordKeyV1 = {
    providerId: 'codex',
    accountSubjectId: `acct_${input.profileId}`,
    subjectKind: 'account',
    quotaScope: 'account',
  };
  return {
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: 'codex',
    accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
    observedAtMs: input.now,
    fetchedAtMs: input.now,
    staleAfterMs: 300_000,
    source: 'runtimeSignal',
    confidence: 'confirmed',
    state: 'loaded_data',
    meters: [{
      meterId: 'weekly',
      label: 'Weekly',
      used: null,
      limit: null,
      unit: 'unknown',
      utilizationPct: 100 - input.remainingPct,
      remainingPct: input.remainingPct,
      resetsAt: input.now + 600_000,
      resetAtMs: input.now + 600_000,
      status: 'ok',
      limitScope: 'account',
      confidence: 'exact',
      details: { limitCategory: 'usage_limit' },
    }],
  };
}

function buildGroup(): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'team',
    displayName: 'Team',
    activeProfileId: 'active',
    generation: 1,
    runtimeStateRevision: 0,
    policy: {
      ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      autoSwitch: true,
      strategy: 'least_limited',
      softSwitchRemainingPercent: 15,
    },
    state: { v: 1 },
    members: ['active', 'backup'].map((profileId, index) => ({
      v: 1 as const,
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId,
      priority: index,
      enabled: true,
      state: {},
      createdAt: index + 1,
      updatedAt: index + 1,
    })),
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('ConnectedServiceQuotasCoordinator PAU-only invariant guard', () => {
  it('treats cold canonical provider-account-usage as unavailable even when runtime snapshots look eligible', async () => {
    const now = 1_000_000;
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordSnapshot({
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'backup',
      snapshot: buildQuotaSnapshot({
        serviceId: 'openai-codex',
        profileId: 'backup',
        now,
        remainingPct: 90,
      }),
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [],
      runtimeQuotaSnapshots,
      accountUsageStore: createProviderAccountUsageStore(),
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const resolveGroupSwitchTargetEligibility = (coordinator as unknown as {
      resolveGroupSwitchTargetEligibility(input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
      }>): Promise<Readonly<{ status: string; reason?: string }>>;
    }).resolveGroupSwitchTargetEligibility.bind(coordinator);

    await expect(resolveGroupSwitchTargetEligibility({
      serviceId: 'openai-codex',
      groupId: 'team',
    })).resolves.toEqual({
      status: 'unknown',
      reason: 'source_account_usage_unavailable',
    });
  });

  it('requires usable target evidence as well as source-backed provider-account-usage', async () => {
    const now = 1_000_000;
    const accountUsageStore = createProviderAccountUsageStore();
    accountUsageStore.recordSnapshot(buildProviderAccountUsageSnapshot({
      profileId: 'active',
      now,
      remainingPct: 0,
    }), {
      sources: [{
        serviceId: 'openai-codex',
        profileId: 'active',
        bindingKind: 'group_member',
        groupId: 'team',
        groupGeneration: 1,
      }],
    });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => buildGroup()),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [],
      accountUsageStore,
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const resolveGroupSwitchTargetEligibility = (coordinator as unknown as {
      resolveGroupSwitchTargetEligibility(input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
      }>): Promise<Readonly<{
        status: string;
        sourceProfileId?: string;
        sourceRemainingPercent?: number;
        decisionTrace?: unknown;
      }>>;
    }).resolveGroupSwitchTargetEligibility.bind(coordinator);

    await expect(resolveGroupSwitchTargetEligibility({
      serviceId: 'openai-codex',
      groupId: 'team',
    })).resolves.toMatchObject({ status: 'no_eligible_target' });
  });

  it('lets the canonical selector evaluate primary restoration while the active backup is above threshold', async () => {
    const now = 1_000_000;
    const accountUsageStore = createProviderAccountUsageStore();
    for (const [profileId, remainingPct] of [['primary', 60], ['backup', 80]] as const) {
      accountUsageStore.recordSnapshot(buildProviderAccountUsageSnapshot({
        profileId,
        now,
        remainingPct,
      }), {
        sources: [{
          serviceId: 'openai-codex',
          profileId,
          bindingKind: 'group_member',
          groupId: 'team',
          groupGeneration: 1,
        }],
      });
    }
    const group = buildGroup();
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getConnectedServiceAuthGroup: vi.fn(async () => ({
          ...group,
          activeProfileId: 'backup',
          policy: {
            ...group.policy,
            strategy: 'priority',
            autoRestorePrimaryWhenReset: true,
            softSwitchRemainingPercent: 2,
          },
          members: group.members.map((member) => member.profileId === 'active'
            ? {
                ...member,
                profileId: 'primary',
                state: {
                  providerResetsAtMs: now - 1,
                  lastFailureKind: 'usage_limit',
                  lastObservedAtMs: now - 2,
                },
              }
            : member),
        })),
      } as unknown as QuotaApi,
      credentials: {
        token: 'happy-token',
        encryption: { type: 'legacy', secret: randomBytes(32) },
      },
      quotaFetchers: [],
      accountUsageStore,
      now: () => now,
      randomBytes,
      discoveryEnabled: false,
    });
    const resolveGroupSwitchTargetEligibility = (coordinator as unknown as {
      resolveGroupSwitchTargetEligibility(input: Readonly<{
        serviceId: 'openai-codex';
        groupId: string;
      }>): Promise<Readonly<{
        status: string;
        sourceProfileId?: string;
        sourceRemainingPercent?: number;
        sourceThresholdPercent?: number;
        decisionTrace?: unknown;
      }>>;
    }).resolveGroupSwitchTargetEligibility.bind(coordinator);

    await expect(resolveGroupSwitchTargetEligibility({
      serviceId: 'openai-codex',
      groupId: 'team',
    })).resolves.toMatchObject({
      status: 'eligible',
      sourceProfileId: 'backup',
      sourceRemainingPercent: 80,
      sourceThresholdPercent: 2,
      sourceProjected: false,
      decisionTrace: {
        activeProfileId: 'backup',
        reason: 'selected',
        candidates: expect.arrayContaining([expect.objectContaining({ profileId: 'primary', decision: 'selected' })]),
      },
    });
  });
});
