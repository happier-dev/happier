import { describe, expect, it } from 'vitest';

import {
  resolveAgentIdFromSessionMetadata,
  resolveSessionMetadataAgentIdentity,
} from './resolveAgentIdFromSessionMetadata.js';

function runtimeDescriptor(agentId: string) {
  return { v: 1, agentId, agent: {} };
}

describe('resolveSessionMetadataAgentIdentity', () => {
  it('prefers the declared runtime descriptor over flavor and flat resume keys', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      runtimeDescriptorV1: runtimeDescriptor('codex'),
      flavor: 'claude',
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('declared');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('prefers flavor over flat resume keys when no identity is declared', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      flavor: 'codex',
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('flavor');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('infers identity from exactly one flat resume key', () => {
    const identity = resolveSessionMetadataAgentIdentity({ claudeSessionId: 'claude-1' });

    expect(identity.agentId).toBe('claude');
    expect(identity.basis).toBe('vendorResumeKey');
    expect(identity.vendorResumeKeyAgentIds).toEqual(['claude']);
  });

  it('fails closed when two flat resume keys exist without higher authority', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBeNull();
    expect(identity.basis).toBe('none');
    expect(identity.ambiguousVendorResumeKeys).toBe(true);
    expect([...identity.vendorResumeKeyAgentIds].sort()).toEqual(['claude', 'codex']);
  });

  it('ignores blank flat resume keys when counting evidence', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      claudeSessionId: '   ',
      codexSessionId: 'codex-1',
    });

    expect(identity.agentId).toBe('codex');
    expect(identity.basis).toBe('vendorResumeKey');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
  });

  it('reports unknown identity for metadata with no Agent evidence', () => {
    const identity = resolveSessionMetadataAgentIdentity({ path: '/tmp/project' });

    expect(identity.agentId).toBeNull();
    expect(identity.basis).toBe('none');
    expect(identity.ambiguousVendorResumeKeys).toBe(false);
    expect(identity.vendorResumeKeyAgentIds).toEqual([]);
  });
});

describe('resolveAgentIdFromSessionMetadata', () => {
  it('does not silently pick the first catalog Agent when two flat resume keys are present', () => {
    expect(resolveAgentIdFromSessionMetadata({
      claudeSessionId: 'claude-1',
      codexSessionId: 'codex-1',
    })).toBeNull();
  });

  it('still resolves a single-key Session', () => {
    expect(resolveAgentIdFromSessionMetadata({ codexSessionId: 'codex-1' })).toBe('codex');
  });

  it('resolves a declared Session that also carries a stale foreign resume key', () => {
    expect(resolveAgentIdFromSessionMetadata({
      runtimeDescriptorV1: runtimeDescriptor('codex'),
      claudeSessionId: 'stale-claude',
    })).toBe('codex');
  });

  it('preserves an installed external Agent declared by the runtime descriptor', () => {
    const identity = resolveSessionMetadataAgentIdentity({
      runtimeDescriptorV1: runtimeDescriptor('acme.agent'),
      flavor: 'claude',
      claudeSessionId: 'stale-claude',
    });

    expect(identity).toMatchObject({
      agentId: 'acme.agent',
      basis: 'declared',
      ambiguousVendorResumeKeys: false,
    });
    expect(resolveAgentIdFromSessionMetadata({
      runtimeDescriptorV1: runtimeDescriptor('acme.agent'),
    })).toBe('acme.agent');
  });
});
