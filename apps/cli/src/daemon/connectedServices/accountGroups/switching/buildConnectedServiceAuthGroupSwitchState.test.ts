import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';
import { buildConnectedServiceAuthGroupSwitchState } from './buildConnectedServiceAuthGroupSwitchState';

describe('buildConnectedServiceAuthGroupSwitchState', () => {
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
