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
        agentId: 'codex',
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

  it('uses reconciled linked-session metadata and fails closed on conflicting or malformed links', () => {
    expect(resolvePersistedCodexRuntimeIdentity({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-agreed',
        remoteSessionId: 'thread-agreed',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-agreed',
        remoteSessionId: 'thread-agreed',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
    })).toEqual({ backendMode: 'appServer' });

    expect(resolvePersistedCodexRuntimeIdentity({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-conflict',
        remoteSessionId: 'thread-conflict',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine-conflict',
        remoteSessionId: 'thread-conflict',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'mcp',
      },
    })).toBeNull();

    expect(resolvePersistedCodexRuntimeIdentity({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
        codexBackendMode: 'appServer',
      },
    })).toBeNull();
  });
});
