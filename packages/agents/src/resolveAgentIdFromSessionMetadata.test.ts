import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_ID } from './manifest.js';
import {
  inferAgentIdFromSessionMetadata,
  resolveAgentIdFromSessionMetadata,
  resolveSessionMetadataAgentIdentity,
} from './resolveAgentIdFromSessionMetadata.js';

function codexRuntimeDescriptor() {
  return { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } } as const;
}

describe('resolveSessionMetadataAgentIdentity', () => {
  it('lets a declared runtime identity win over flavor', () => {
    expect(resolveSessionMetadataAgentIdentity({
      flavor: 'claude',
      agentRuntimeDescriptorV1: codexRuntimeDescriptor(),
    })).toEqual({
      agentId: 'codex',
      basis: 'declared',
      vendorResumeKeyAgentIds: [],
      ambiguousVendorResumeKeys: false,
    });
  });

  it('lets flavor win over a flat vendor resume key', () => {
    expect(resolveSessionMetadataAgentIdentity({
      flavor: 'codex',
      claudeSessionId: 'stale-claude-1',
    })).toEqual({
      agentId: 'codex',
      basis: 'flavor',
      vendorResumeKeyAgentIds: ['claude'],
      ambiguousVendorResumeKeys: false,
    });
  });

  it('infers identity from exactly one flat vendor resume key', () => {
    expect(resolveSessionMetadataAgentIdentity({ opencodeSessionId: 'oc-1' })).toEqual({
      agentId: 'opencode',
      basis: 'vendorResumeKey',
      vendorResumeKeyAgentIds: ['opencode'],
      ambiguousVendorResumeKeys: false,
    });
  });

  it('fails closed on several flat vendor resume keys with no higher authority', () => {
    expect(resolveSessionMetadataAgentIdentity({
      claudeSessionId: 'c-1',
      codexSessionId: 'x-1',
    })).toEqual({
      agentId: null,
      basis: 'none',
      vendorResumeKeyAgentIds: ['claude', 'codex'],
      ambiguousVendorResumeKeys: true,
    });
  });

  it('reports every flat vendor resume key without treating extras as a conflict', () => {
    expect(resolveSessionMetadataAgentIdentity({
      flavor: 'codex',
      codexSessionId: 'x-1',
      claudeSessionId: 'stale-claude-1',
    })).toEqual({
      agentId: 'codex',
      basis: 'flavor',
      vendorResumeKeyAgentIds: ['claude', 'codex'],
      ambiguousVendorResumeKeys: false,
    });
  });

  it('ignores blank and non-string flat vendor resume keys', () => {
    expect(resolveSessionMetadataAgentIdentity({
      claudeSessionId: '   ',
      geminiSessionId: 17,
      codexSessionId: 'x-1',
    })).toEqual({
      agentId: 'codex',
      basis: 'vendorResumeKey',
      vendorResumeKeyAgentIds: ['codex'],
      ambiguousVendorResumeKeys: false,
    });
  });

  it('reports no identity for metadata that is not a record', () => {
    expect(resolveSessionMetadataAgentIdentity(null)).toEqual({
      agentId: null,
      basis: 'none',
      vendorResumeKeyAgentIds: [],
      ambiguousVendorResumeKeys: false,
    });
  });
});

describe('resolveAgentIdFromSessionMetadata', () => {
  it('projects the authoritative identity', () => {
    expect(resolveAgentIdFromSessionMetadata({
      flavor: 'claude',
      agentRuntimeDescriptorV1: codexRuntimeDescriptor(),
    })).toBe('codex');
    expect(resolveAgentIdFromSessionMetadata({ codexSessionId: 'x-1' })).toBe('codex');
  });

  it('resolves to no Agent instead of the first catalog Agent when flat keys are ambiguous', () => {
    expect(resolveAgentIdFromSessionMetadata({
      claudeSessionId: 'c-1',
      codexSessionId: 'x-1',
    })).toBeNull();
    expect(resolveAgentIdFromSessionMetadata({
      codexSessionId: 'x-1',
      opencodeSessionId: 'oc-1',
    })).toBeNull();
  });
});

describe('inferAgentIdFromSessionMetadata', () => {
  it('falls back to the default Agent when identity is ambiguous', () => {
    expect(inferAgentIdFromSessionMetadata({
      codexSessionId: 'x-1',
      opencodeSessionId: 'oc-1',
    })).toBe(DEFAULT_AGENT_ID);
    expect(inferAgentIdFromSessionMetadata({
      codexSessionId: 'x-1',
      opencodeSessionId: 'oc-1',
    }, 'gemini')).toBe('gemini');
  });
});
