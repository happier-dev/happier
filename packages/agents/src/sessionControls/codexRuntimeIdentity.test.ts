import { describe, expect, it } from 'vitest';

import {
  buildCodexSpawnRuntimeAffinityCompatFields,
  resolvePersistedCodexRuntimeIdentity,
  resolvePersistedCodexVendorSessionId,
} from './codexRuntimeIdentity.js';

describe('resolvePersistedCodexRuntimeIdentity', () => {
  it('prefers the generic agentRuntimeDescriptorV1 slice over codex-specific legacy slices', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'mcp' },
      },
      codexRuntimeDescriptorV1: { v: 1, backendMode: 'appServer' },
      codexBackendMode: 'acp',
    })).toEqual({ backendMode: 'mcp' });
  });

  it('prefers codex providerExtra backend mode over legacy provider fields', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerExtra: {
            v: 1,
            runtimeAffinity: { backendMode: 'acp' },
          },
        },
      },
      codexBackendMode: 'mcp',
    })).toEqual({ backendMode: 'acp' });
  });

  it('prefers the canonical codexRuntimeDescriptorV1 slice', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      codexRuntimeDescriptorV1: { v: 1, backendMode: 'appServer' },
      codexBackendMode: 'acp',
    })).toEqual({ backendMode: 'appServer' });
  });

  it('accepts canonical affinity payloads', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      affinity: { backendMode: 'acp' },
      codexBackendMode: 'appServer',
    })).toEqual({ backendMode: 'acp' });
  });

  it('normalizes legacy mcp_resume codex metadata onto acp', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      affinity: { backendMode: '  mcp_resume  ' },
    })).toEqual({ backendMode: 'acp' });
  });

  it('falls back to legacy codexBackendMode metadata', () => {
    expect(resolvePersistedCodexRuntimeIdentity({ codexBackendMode: 'acp' })).toEqual({ backendMode: 'acp' });
  });

  it('falls back to directSessionV1 codex backend mode metadata', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      directSessionV1: { codexBackendMode: 'appServer' },
    })).toEqual({ backendMode: 'appServer' });
  });

  it('infers appServer from legacy generic Codex state metadata', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      codexSessionId: 'thread-1',
      sessionConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        options: [],
      },
    })).toEqual({ backendMode: 'appServer' });
  });

  it('infers appServer from legacy alias Codex state metadata', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      codexSessionId: 'thread-1',
      acpSessionModesV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModeId: 'plan',
        availableModes: [],
      },
    })).toEqual({ backendMode: 'appServer' });

    expect(resolvePersistedCodexRuntimeIdentity({
      codexSessionId: 'thread-1',
      acpSessionModelsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        currentModelId: 'gpt-5',
        availableModels: [],
      },
    })).toEqual({ backendMode: 'appServer' });

    expect(resolvePersistedCodexRuntimeIdentity({
      codexSessionId: 'thread-1',
      acpConfigOptionsV1: {
        v: 1,
        provider: 'codex',
        updatedAt: 1,
        configOptions: [],
      },
    })).toEqual({ backendMode: 'appServer' });
  });

  it('returns null when no persisted Codex runtime identity exists', () => {
    expect(resolvePersistedCodexRuntimeIdentity({ codexSessionId: 'thread-1' })).toBeNull();
    expect(resolvePersistedCodexRuntimeIdentity(null)).toBeNull();
  });
});

describe('resolvePersistedCodexVendorSessionId', () => {
  it('prefers codex providerExtra vendor session ids over provider and legacy fields', () => {
    expect(resolvePersistedCodexVendorSessionId({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'provider-thread',
          providerExtra: {
            v: 1,
            runtimeAffinity: { vendorSessionId: 'extra-thread' },
          },
        },
      },
      codexSessionId: 'legacy-thread',
    })).toBe('extra-thread');
  });
});

describe('buildCodexSpawnRuntimeAffinityCompatFields', () => {
  it('returns canonical backend mode for acp affinity', () => {
    expect(buildCodexSpawnRuntimeAffinityCompatFields({ backendMode: 'acp' })).toEqual({
      codexBackendMode: 'acp',
    });
  });

  it('returns only canonical backend mode for non-acp affinity', () => {
    expect(buildCodexSpawnRuntimeAffinityCompatFields({ backendMode: 'appServer' })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('omits spawn fields when no affinity is known', () => {
    expect(buildCodexSpawnRuntimeAffinityCompatFields(null)).toEqual({});
  });
});
