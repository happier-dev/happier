import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceAuthGroupV1 } from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

import { updateConnectedServiceAuthGroupRuntimeStateWithRetry } from './updateConnectedServiceAuthGroupRuntimeStateWithRetry';

function group(runtimeStateRevision: number, state: Readonly<Record<string, unknown>>): ConnectedServiceAuthGroupV1 {
  return {
    v: 1,
    serviceId: 'openai-codex',
    groupId: 'main',
    displayName: null,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
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
  it('stops recomputing when the authoritative generation changes', async () => {
    let current = group(4, {});
    const result = await updateConnectedServiceAuthGroupRuntimeStateWithRetry({
      serviceId: 'openai-codex',
      groupId: 'main',
      expectedGeneration: 3,
      loadGroup: async () => current,
      buildPatch: () => ({ memberStates: [] }),
      update: async () => {
        current = { ...current, generation: 4 };
        throw new Error('connected_service_auth_group_runtime_state_revision_conflict');
      },
    });
    expect(result).toBeNull();
  });

  it('re-reads and recomputes through repeated same-generation runtime-state revision conflicts', async () => {
    const loadGroup = vi.fn()
      .mockResolvedValueOnce(group(4, { quotaExhaustedUntilMs: 10 }))
      .mockResolvedValueOnce(group(5, { quotaExhaustedUntilMs: 10, capacityLimitedUntilMs: 20 }))
      .mockResolvedValueOnce(group(6, { quotaExhaustedUntilMs: 10, capacityLimitedUntilMs: 30 }));
    const update = vi.fn()
      .mockRejectedValueOnce(new Error('connected_service_auth_group_runtime_state_revision_conflict'))
      .mockRejectedValueOnce(new Error('connected_service_auth_group_runtime_state_revision_conflict'))
      .mockImplementationOnce(async (input) => group(7, input.memberStates[0]?.state ?? {}));

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
    })).resolves.toEqual(expect.objectContaining({ runtimeStateRevision: 7 }));

    expect(update).toHaveBeenNthCalledWith(3, expect.objectContaining({
      expectedRuntimeStateRevision: 6,
      memberStates: [{
        profileId: 'work',
        state: expect.objectContaining({
          quotaExhaustedUntilMs: null,
          capacityLimitedUntilMs: 30,
        }),
      }],
    }));
  });
});
