import { describe, expect, it } from 'vitest';
import { ConnectedServiceAuthGroupPolicyV1Schema, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildConnectedServiceAuthGroupSwitchState,
  mergePersistedMemberRuntimeState,
} from './buildConnectedServiceAuthGroupSwitchState';

function groupWithPersistedState(state: ConnectedServiceAuthGroupV1['members'][number]['state']): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: 'Main',
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true }),
    activeProfileId: 'primary',
    generation: 7,
    runtimeStateRevision: 0,
    state: { v: 1 },
    members: [
      {
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'main',
        profileId: 'primary',
        priority: 1,
        enabled: true,
        state,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('buildConnectedServiceAuthGroupSwitchState', () => {
  it('preserves the failure-associated reset boundary when a healthy snapshot reports the next window', () => {
    expect(mergePersistedMemberRuntimeState({
      providerResetsAtMs: 20_000,
      quotaSnapshot: {
        capturedAtMs: 11_000,
        effectiveRemainingPercent: 60,
      },
    }, {
      providerResetsAtMs: 10_000,
      lastFailureKind: 'usage_limit',
      lastFailureProviderLimitId: 'five_hour',
      lastObservedAtMs: 9_000,
    })).toMatchObject({
      providerResetsAtMs: 10_000,
      lastFailureKind: 'usage_limit',
      lastFailureProviderLimitId: 'five_hour',
      lastObservedAtMs: 9_000,
    });
  });

  it('preserves recognized persisted member runtime state used by candidate selection', () => {
    const switchState = buildConnectedServiceAuthGroupSwitchState({
      group: groupWithPersistedState({
        credentialHealthStatus: 'connected',
        cooldownUntilMs: 2_000,
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 1_500,
        providerResetsAtMs: 3_000,
      }),
      runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      nowMs: 1_750,
    });

    expect(switchState.memberStatesByProfileId.get('primary')).toMatchObject({
      credentialHealthStatus: 'connected',
      cooldownUntilMs: 2_000,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 1_500,
      providerResetsAtMs: 3_000,
    });
  });

  it('keeps fresher runtime provider reset evidence when persisted state omits it', () => {
    const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
    runtimeQuotaSnapshots.recordProfileSnapshot({
      serviceId: 'openai-codex',
      profileId: 'primary',
      snapshot: {
        v: 1,
        serviceId: 'openai-codex',
        profileId: 'primary',
        fetchedAt: 1_000,
        staleAfterMs: 300_000,
        planLabel: null,
        accountLabel: null,
        meters: [
          {
            meterId: 'primary',
            label: 'Primary',
            used: 100,
            limit: 100,
            unit: 'requests',
            utilizationPct: 100,
            remainingPct: 0,
            resetsAt: 10_000,
            status: 'ok',
            details: {},
          },
        ],
      },
    });

    const switchState = buildConnectedServiceAuthGroupSwitchState({
      group: groupWithPersistedState({
        lastFailureKind: 'usage_limit',
        lastObservedAtMs: 900,
        providerResetsAtMs: null,
      }),
      runtimeQuotaSnapshots,
      nowMs: 1_100,
    });

    expect(switchState.memberStatesByProfileId.get('primary')).toMatchObject({
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: 900,
      providerResetsAtMs: 10_000,
    });
  });
});
