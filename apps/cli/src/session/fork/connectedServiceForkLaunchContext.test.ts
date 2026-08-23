import { describe, expect, it, vi } from 'vitest';

import { createConnectedServiceForkLaunchContext } from './connectedServiceForkLaunchContext';

const CONNECTED_SERVICES = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'group',
      groupId: 'happier',
      profileId: 'codex1',
    },
  },
} as const;

const NATIVE_SERVICES = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': { source: 'native' },
  },
} as const;

describe('createConnectedServiceForkLaunchContext', () => {
  it('mints the same deterministic fresh child materialization identity for spawn and metadata', () => {
    const parentIdentity = {
      v: 1,
      id: 'csm_parent_identity',
      createdAtMs: 100,
    } as const;
    const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(0xab));

    const result = createConnectedServiceForkLaunchContext({
      inherited: {
        spawn: {
          connectedServices: CONNECTED_SERVICES,
          connectedServicesUpdatedAt: 123,
          connectedServiceMaterializationIdentityV1: parentIdentity,
        },
        metadata: {
          connectedServices: CONNECTED_SERVICES,
          connectedServicesUpdatedAt: 123,
          connectedServiceMaterializationIdentityV1: parentIdentity,
        },
      },
      nowMs: () => 777,
      randomBytes,
    });

    const expectedIdentity = {
      v: 1,
      id: 'csm_abababababababababababababababab',
      createdAtMs: 777,
    };
    expect(randomBytes).toHaveBeenCalledWith(16);
    expect(result.hasConnectedServices).toBe(true);
    expect(result.materializationIdentity).toEqual(expectedIdentity);
    expect(result.spawn.connectedServiceMaterializationIdentityV1).toEqual(expectedIdentity);
    expect(result.metadata.connectedServiceMaterializationIdentityV1).toEqual(expectedIdentity);
    expect(result.materializationIdentity).not.toEqual(parentIdentity);
  });

  it('does not mint a materialization identity when the fork does not inherit connected services', () => {
    const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(0xab));

    const result = createConnectedServiceForkLaunchContext({
      inherited: {
        spawn: {},
        metadata: {},
      },
      nowMs: () => 777,
      randomBytes,
    });

    expect(randomBytes).not.toHaveBeenCalled();
    expect(result).toEqual({
      hasConnectedServices: false,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    });
  });

  it('does not mint an identity for native bindings the daemon will not materialize', () => {
    const randomBytes = vi.fn((length: number) => new Uint8Array(length).fill(0xab));

    const result = createConnectedServiceForkLaunchContext({
      inherited: {
        spawn: { connectedServices: NATIVE_SERVICES },
        metadata: { connectedServices: NATIVE_SERVICES },
      },
      nowMs: () => 777,
      randomBytes,
    });

    expect(result).toEqual({
      hasConnectedServices: true,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    });
    expect(randomBytes).not.toHaveBeenCalled();
  });
});
