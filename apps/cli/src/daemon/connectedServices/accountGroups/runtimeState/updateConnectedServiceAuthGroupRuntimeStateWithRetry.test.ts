import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';

import { updateConnectedServiceAuthGroupRuntimeStateWithRetry } from './updateConnectedServiceAuthGroupRuntimeStateWithRetry';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../selection/selectConnectedServiceAuthGroupCandidate';

function group(runtimeStateRevision: number, state: Readonly<Record<string, unknown>>): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: null,
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    activeProfileId: 'work',
    generation: 3,
    runtimeStateRevision,
    state: {},
    members: [{
      v: 1,
      serviceId: 'openai-codex',
      groupId: 'main',
      profileId: 'work',
      priority: 1,
      enabled: true,
      state,
      createdAt: 1,
      updatedAt: 1,
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('updateConnectedServiceAuthGroupRuntimeStateWithRetry', () => {
  it('re-reads and recomputes once after a same-generation runtime-state revision conflict', async () => {
    const loadGroup = vi.fn()
      .mockResolvedValueOnce(group(4, { quotaExhaustedUntilMs: 10 }))
      .mockResolvedValueOnce(group(5, { quotaExhaustedUntilMs: 10, capacityLimitedUntilMs: 20 }));
    const update = vi.fn()
      .mockRejectedValueOnce(new Error('connected_service_auth_group_runtime_state_revision_conflict'))
      .mockImplementationOnce(async (input) => group(6, input.memberStates[0]?.state ?? {}));

    await expect(updateConnectedServiceAuthGroupRuntimeStateWithRetry({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 3,
      loadGroup,
      buildPatch: (current) => ({
        memberStates: [{
          profileId: 'work',
          state: {
            ...current.members[0]!.state,
            quotaExhaustedUntilMs: null,
          },
        }],
      }),
      update,
    })).resolves.toEqual(expect.objectContaining({ runtimeStateRevision: 6 }));

    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRuntimeStateRevision: 5,
      memberStates: [{
        profileId: 'work',
        state: expect.objectContaining({
          quotaExhaustedUntilMs: null,
          capacityLimitedUntilMs: 20,
        }),
      }],
    }));
  });
});
