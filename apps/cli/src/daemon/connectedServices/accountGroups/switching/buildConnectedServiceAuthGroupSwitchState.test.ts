import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { buildProviderAccountUsageRecordId, buildQualifiedPluginContributionKey, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, selectConnectedServiceAuthGroupCandidate } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { createProviderAccountUsageStore } from '../../accountUsage/store';
import { buildConnectedServiceAuthGroupSwitchStateFromAccountUsage } from './buildConnectedServiceAuthGroupSwitchStateFromAccountUsage';
import {
  buildConnectedServiceAuthGroupSwitchState,
  mergePersistedMemberRuntimeState,
} from './buildConnectedServiceAuthGroupSwitchState';

describe('buildConnectedServiceAuthGroupSwitchState', () => {
  it('chooses expiring usable quota through qualified account-usage sources and persisted member state', () => {
    const serviceId = buildQualifiedPluginContributionKey({ pluginId: 'example.connected-accounts', localId: 'subscription' });
    const store = createProviderAccountUsageStore();
    for (const [profileId, remainingPct] of [['early', 40], ['fresh', 95]] as const) {
      const recordKey = { providerId: 'claude', accountSubjectId: profileId, subjectKind: 'subscription', quotaScope: 'account' } as const;
      const snapshot: ProviderAccountUsageSnapshotV1 = {
        v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'claude',
        accountSubject: { kind: 'providerSubject', id: profileId },
        fetchedAtMs: 1_000, observedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'weekly', label: 'Weekly', used: null, limit: null, unit: 'unknown',
          remainingPct, utilizationPct: 100 - remainingPct, status: 'ok', details: {},
          windowDurationMs: 604_800_000, resetsAt: 30_000 }],
        ...(profileId === 'early' ? { subscription: { status: 'subscribed', renewal: 'off',
          observedAtMs: 900, staleAfterMs: 300_000, currentPeriodEndAtMs: 5_000 } } : {}),
      };
      store.recordSnapshot(snapshot, { sources: [{ serviceId, profileId, bindingKind: 'group_member', groupId: 'team', groupGeneration: 4 }] });
    }
    const result = buildConnectedServiceAuthGroupSwitchStateFromAccountUsage({ accountUsageStore: store,
      group: { serviceId, groupId: 'team', activeProfileId: null, generation: 4,
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
        members: ['early', 'fresh'].map((profileId, priority) => ({ profileId, priority, enabled: true,
          createdAt: priority, state: { credentialHealthStatus: 'connected' } })),
      },
    });
    expect(result).not.toBeNull();
    expect(selectConnectedServiceAuthGroupCandidate({ ...result!.state, nowMs: 1_000, quotaFreshnessMs: 300_000 }).selected?.profileId).toBe('early');
  });

  it('preserves the failure reset when a healthy snapshot reports the next quota window', () => {
    expect(mergePersistedMemberRuntimeState({
      providerResetsAtMs: 20_000,
      quotaSnapshot: {
        capturedAtMs: 11_000,
        effectiveRemainingPercent: 60,
      },
    }, {
      providerResetsAtMs: 10_000,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 9_000,
    })).toMatchObject({
      providerResetsAtMs: 10_000,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 9_000,
    });
  });

  it('preserves persisted limiter evidence used by candidate selection after restart', () => {
    const group: ConnectedServiceAuthGroupV1 = {
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      displayName: null,
      policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
      activeProfileId: 'primary',
      generation: 2,
      runtimeStateRevision: 0,
      state: {},
      createdAt: 1,
      updatedAt: 2,
      members: [
        {
          v: 1,
          serviceId: 'openai-codex',
          groupId: 'main',
          profileId: 'primary',
          priority: 1,
          enabled: true,
          createdAt: 1,
          updatedAt: 2,
          state: {
            quotaExhaustedUntilMs: 10_000,
            rateLimitedUntilMs: null,
            lastFailureKind: 'usage_limit',
            lastObservedAtMs: 8_000,
            providerResetsAtMs: 12_000,
          },
        },
      ],
    };

    const state = buildConnectedServiceAuthGroupSwitchState({
      group,
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      nowMs: 9_000,
    });

    expect(state.memberStatesByProfileId.get('primary')).toMatchObject({
      quotaExhaustedUntilMs: 10_000,
      rateLimitedUntilMs: null,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 8_000,
      providerResetsAtMs: 12_000,
    });
  });
});
