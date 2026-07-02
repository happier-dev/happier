import { describe, expect, it } from 'vitest';

import {
  buildCodexSpawnRuntimeAffinityCompatFields,
  resolvePersistedCodexRuntimeIdentity,
} from './runtimeIdentity.js';

describe('resolvePersistedCodexRuntimeIdentity', () => {
  it('reads external-session codex backend mode metadata for wake resume affinity', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      externalSessionV1: {
        v: 1,
        providerId: 'codex',
        codexBackendMode: 'appServer',
      },
    })).toEqual({ backendMode: 'appServer' });
  });

  it('keeps legacy mcp runtime identity readable without serializing it into canonical spawn affinity fields', () => {
    const identity = resolvePersistedCodexRuntimeIdentity({
      codexBackendMode: 'mcp',
      codexSessionId: 'thread-mcp',
    });

    expect(identity).toEqual({ backendMode: 'mcp' });
    expect(buildCodexSpawnRuntimeAffinityCompatFields(identity)).toEqual({});
  });
});
