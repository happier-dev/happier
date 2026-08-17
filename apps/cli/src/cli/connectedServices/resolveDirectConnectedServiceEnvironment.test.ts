import { describe, expect, it } from 'vitest';

import {
  resolveDirectConnectedServiceMaterializationIdentity,
} from './resolveDirectConnectedServiceEnvironment';

describe('resolveDirectConnectedServiceMaterializationIdentity', () => {
  it('creates a stable materialization identity for a fresh direct connected-service launch', () => {
    const identity = resolveDirectConnectedServiceMaterializationIdentity(null);

    expect(identity).toEqual({
      v: 1,
      id: expect.stringMatching(/^csm_[0-9a-f]{32}$/),
      createdAtMs: expect.any(Number),
    });
  });

  it('preserves the persisted identity for a direct resume', () => {
    const persisted = {
      v: 1 as const,
      id: 'csm_0123456789abcdef0123456789abcdef',
      createdAtMs: 1_786_000_000_000,
    };

    expect(resolveDirectConnectedServiceMaterializationIdentity({
      connectedServiceMaterializationIdentityV1: persisted,
    })).toEqual(persisted);
  });
});
