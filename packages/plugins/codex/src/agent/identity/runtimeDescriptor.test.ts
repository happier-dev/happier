import { describe, expect, it } from 'vitest';

import {
  buildCodexSpawnRuntimeAffinityCompatFields,
  readCodexSessionMetadataRuntimeDescriptor,
  resolvePersistedCodexRuntimeIdentity,
} from './runtimeDescriptor.js';

describe('Codex runtime descriptor identity helpers', () => {
  it('keeps legacy mcp runtime identity readable without serializing it into canonical spawn affinity fields', () => {
    const identity = resolvePersistedCodexRuntimeIdentity({
      codexBackendMode: 'mcp',
      codexSessionId: 'thread-mcp',
    });

    expect(identity).toEqual({ backendMode: 'mcp' });
    expect(buildCodexSpawnRuntimeAffinityCompatFields(identity)).toEqual({});
  });

  it('normalizes legacy mcp metadata in the generic runtime descriptor reader', () => {
    expect(readCodexSessionMetadataRuntimeDescriptor({
      codexBackendMode: 'mcp',
      codexSessionId: 'thread-mcp',
    })).toMatchObject({
      backendMode: 'appServer',
      runtimeKind: 'appServer',
      providerSessionId: 'thread-mcp',
    });
  });

  it('keeps raw mcp descriptor identity readable while the descriptor reader returns canonical app-server mode', () => {
    const metadata = {
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          providerSessionId: 'thread-mcp',
        },
      },
    };
    const identity = resolvePersistedCodexRuntimeIdentity(metadata);

    expect(identity).toEqual({ backendMode: 'mcp' });
    expect(buildCodexSpawnRuntimeAffinityCompatFields(identity)).toEqual({});
    expect(readCodexSessionMetadataRuntimeDescriptor(metadata)).toMatchObject({
      backendMode: 'appServer',
      runtimeKind: 'appServer',
      providerSessionId: 'thread-mcp',
    });
  });
});
