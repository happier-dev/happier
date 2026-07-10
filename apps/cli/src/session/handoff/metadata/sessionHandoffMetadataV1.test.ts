import { describe, expect, it } from 'vitest';

import {
  buildSessionHandoffMetadataV1,
  readSessionHandoffAgentId,
} from './sessionHandoffMetadataV1';

describe('sessionHandoffMetadataV1', () => {
  const canonicalInput = {
    sourceMachineId: 'machine_source',
    targetMachineId: 'machine_target',
    agentId: 'claude',
    sessionStorageBefore: 'direct' as const,
    sessionStorageAfter: 'persisted' as const,
    transportStrategy: 'server_routed_stream' as const,
    completedAtMs: 123,
    sourceWorkspaceRootPath: '/repo/source',
    targetWorkspaceRootPath: '/repo/target',
  };

  it('builds the canonical persisted shape with agentId', () => {
    expect(buildSessionHandoffMetadataV1(canonicalInput)).toEqual({
      v: 1,
      ...canonicalInput,
    });
    expect(buildSessionHandoffMetadataV1(canonicalInput)).not.toHaveProperty('providerId');
  });

  it('reads canonical agentId and the deployed providerId alias', () => {
    expect(readSessionHandoffAgentId({ v: 1, agentId: ' claude ' })).toBe('claude');
    expect(readSessionHandoffAgentId({ v: 1, providerId: ' claude ' })).toBe('claude');
    expect(readSessionHandoffAgentId({ v: 1, agentId: 'claude', providerId: 'claude' })).toBe('claude');
  });

  it('fails closed for malformed or conflicting identities', () => {
    expect(readSessionHandoffAgentId({ v: 1, agentId: 'claude', providerId: 'codex' })).toBeNull();
    expect(readSessionHandoffAgentId({ v: 1, agentId: '' })).toBeNull();
    expect(readSessionHandoffAgentId({ v: 1, providerId: '' })).toBeNull();
    expect(readSessionHandoffAgentId({ agentId: 'claude' })).toBeNull();
  });
});
