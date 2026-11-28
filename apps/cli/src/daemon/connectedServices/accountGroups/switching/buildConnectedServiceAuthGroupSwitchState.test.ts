import { describe, expect, it } from 'vitest';
import { ConnectedServiceAuthGroupPolicyV1Schema, type ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import {
  buildConnectedServiceAuthGroupSwitchState,
  buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState,
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

  describe('explicit user selection of the active member', () => {
    // Logged incident (agy pool, 2026-11-28): lbservers remembered `quota_exhausted` until 13:19:27
    // from agy's "Resets in" message; the user upgraded its plan and switched the pool to it at
    // 13:14:31, and every later pre-turn decision still treated it as exhausted.
    const failureObservedAtMs = 1_000;
    const manualSwitchAtMs = 5_000;
    const rememberedRetryAtMs = 50_000;
    const limiterState = {
      quotaExhaustedUntilMs: rememberedRetryAtMs,
      cooldownUntilMs: rememberedRetryAtMs,
      providerResetsAtMs: rememberedRetryAtMs,
      lastFailureKind: 'usage_limit',
      lastObservedAtMs: failureObservedAtMs,
    };
    function pool(input: Readonly<{
      lastSwitchReason: string;
      lastSwitchAt: number;
      activeState: ConnectedServiceAuthGroupV1['members'][number]['state'];
      otherState?: ConnectedServiceAuthGroupV1['members'][number]['state'];
    }>): ConnectedServiceAuthGroupV1 {
      const base = groupWithPersistedState(input.activeState);
      return {
        ...base,
        state: { v: 1, lastSwitchReason: input.lastSwitchReason, lastSwitchAt: input.lastSwitchAt },
        members: [
          ...base.members,
          { ...base.members[0]!, profileId: 'backup', priority: 2, state: input.otherState ?? limiterState },
        ],
      };
    }

    it('overrides limiter cooldowns remembered before the selection and reports the override', () => {
      const state = buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
        group: pool({ lastSwitchReason: 'manual', lastSwitchAt: manualSwitchAtMs, activeState: limiterState }),
      });

      const active = state.memberStatesByProfileId.get('primary');
      expect(active?.quotaExhaustedUntilMs ?? null).toBeNull();
      expect(active?.cooldownUntilMs ?? null).toBeNull();
      expect(active?.lastFailureKind ?? null).toBeNull();
      expect(state.userSelectedActiveProfile).toEqual({
        profileId: 'primary',
        overriddenRetryAtMs: rememberedRetryAtMs,
      });
      // Automatic rotation keeps every other member's cooldown.
      expect(state.memberStatesByProfileId.get('backup')).toMatchObject({
        quotaExhaustedUntilMs: rememberedRetryAtMs,
        lastFailureKind: 'usage_limit',
      });
    });

    it('applies a limiter failure observed after the selection', () => {
      const state = buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
        group: pool({
          lastSwitchReason: 'manual',
          lastSwitchAt: manualSwitchAtMs,
          activeState: { ...limiterState, lastObservedAtMs: manualSwitchAtMs + 1 },
        }),
      });

      expect(state.memberStatesByProfileId.get('primary')).toMatchObject({
        quotaExhaustedUntilMs: rememberedRetryAtMs,
        lastFailureKind: 'usage_limit',
      });
      expect(state.userSelectedActiveProfile).toBeUndefined();
    });

    it('keeps remembered cooldowns after an automatic switch', () => {
      const state = buildConnectedServiceAuthGroupSwitchStateFromPersistedMemberState({
        group: pool({ lastSwitchReason: 'usage_limit', lastSwitchAt: manualSwitchAtMs, activeState: limiterState }),
      });

      expect(state.memberStatesByProfileId.get('primary')).toMatchObject({
        quotaExhaustedUntilMs: rememberedRetryAtMs,
      });
      expect(state.userSelectedActiveProfile).toBeUndefined();
    });
  });
});
