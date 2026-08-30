import { describe, expect, it } from 'vitest';

import { resolveSessionRuntimeSnapshot } from './resolveSessionRuntimeSnapshot';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

const persistedConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'persisted-profile',
    },
  },
} as const;

const incomingConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'incoming-profile',
    },
  },
} as const;

const materializationIdentity = {
  v: 1,
  id: 'csm_persisted_1',
  createdAtMs: 10,
} as const;

function baseIncomingOptions(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    directory: '/tmp/repo',
    existingSessionId: 'session-1',
    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    ...overrides,
  };
}

describe('resolveSessionRuntimeSnapshot', () => {
  it('restores the persisted per-session MCP overlay into resume and respawn options', () => {
    const mcpSelection = {
      v: 1 as const,
      managedServersEnabled: true,
      forceIncludeServerIds: ['managed-1'],
      forceExcludeServerIds: ['managed-2'],
    };
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: { mcpSelectionV1: mcpSelection },
      trackedSpawnOptions: baseIncomingOptions({
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: [],
          forceExcludeServerIds: [],
        },
      }),
    });

    expect(result.snapshot.mcpSelection).toEqual(mcpSelection);
    expect(result.spawnOptions.mcpSelection).toEqual(mcpSelection);
  });

  it('restores persisted session runtime controls when incoming resume options omit them', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 220 },
      },
      persistedVendorResumeId: 'vendor-persisted',
    });

    expect(result.snapshot).toEqual({
      sessionId: 'session-1',
      connectedServices: persistedConnectedServices,
      connectedServicesUpdatedAt: null,
      connectedServiceMaterializationIdentityV1: null,
      mcpSelection: null,
      permissionMode: { value: 'yolo', updatedAt: 200 },
      agentModeId: { value: 'plan', updatedAt: 210 },
      modelId: { value: 'claude-opus-4-7', updatedAt: 220 },
      vendorResumeId: { value: 'vendor-persisted', updatedAt: null },
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 200,
      agentModeId: 'plan',
      agentModeUpdatedAt: 210,
      modelId: 'claude-opus-4-7',
      modelUpdatedAt: 220,
      resume: 'vendor-persisted',
    });
  });

  it('keeps newer persisted metadata over stale incoming defaults', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: { v: 1, bindingsByServiceId: {} },
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        agentModeId: 'default',
        agentModeUpdatedAt: 100,
        modelId: 'old-model',
        modelUpdatedAt: 100,
        resume: 'incoming-resume',
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'build', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'new-model', updatedAt: 220 },
      },
      persistedVendorResumeId: 'persisted-resume',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 200,
      agentModeId: 'build',
      agentModeUpdatedAt: 210,
      modelId: 'new-model',
      modelUpdatedAt: 220,
      resume: 'incoming-resume',
    });
  });

  it('keeps explicit newer incoming runtime controls over persisted metadata', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: incomingConnectedServices,
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 300,
        agentModeId: 'review',
        agentModeUpdatedAt: 310,
        modelId: 'incoming-model',
        modelUpdatedAt: 320,
        resume: 'incoming-resume',
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 200,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 210 },
        modelOverrideV1: { v: 1, modelId: 'persisted-model', updatedAt: 220 },
      },
      persistedVendorResumeId: 'persisted-resume',
    });

    expect(result.snapshot).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: { value: 'read-only', updatedAt: 300 },
      agentModeId: { value: 'review', updatedAt: 310 },
      modelId: { value: 'incoming-model', updatedAt: 320 },
      vendorResumeId: { value: 'incoming-resume', updatedAt: null },
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 300,
      agentModeId: 'review',
      agentModeUpdatedAt: 310,
      modelId: 'incoming-model',
      modelUpdatedAt: 320,
      resume: 'incoming-resume',
    });
  });

  it('lets a newer explicit incoming native connected-service selection clear an older persisted binding', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 500,
      }),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 100,
      },
    });

    expect(result.snapshot.connectedServices).toEqual({ v: 1, bindingsByServiceId: {} });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 500,
    });
  });

  it('keeps newer persisted connected-service bindings over stale tracked bindings', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 500,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        connectedServicesUpdatedAt: 100,
      },
    });

    expect(result.snapshot.connectedServices).toEqual(persistedConnectedServices);
    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      connectedServicesUpdatedAt: 500,
    });
  });

  it('uses tracked spawn controls when they are newer than persisted metadata and incoming options omit them', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 100 },
        modelOverrideV1: { v: 1, modelId: 'persisted-model', updatedAt: 100 },
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 400,
        agentModeId: 'tracked-mode',
        agentModeUpdatedAt: 410,
        modelId: 'tracked-model',
        modelUpdatedAt: 420,
      },
      trackedVendorResumeId: 'tracked-resume',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 400,
      agentModeId: 'tracked-mode',
      agentModeUpdatedAt: 410,
      modelId: 'tracked-model',
      modelUpdatedAt: 420,
      resume: 'tracked-resume',
    });
  });

  it('restores the vendor resume id from persisted provider metadata when respawn options omit resume', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      }),
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: ' codex-thread-from-metadata ',
      },
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'codex-thread-from-metadata',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBe('codex-thread-from-metadata');
  });

  it('does not inherit provider resume ids from metadata for configured ACP attaches', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
      }),
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: 'codex-thread-from-metadata',
      },
      persistedVendorResumeId: 'persisted-provider-thread',
    });

    expect(result.snapshot.vendorResumeId).toBeNull();
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('preserves incoming controls without timestamps when no persisted or tracked snapshot exists', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        existingSessionId: undefined,
        permissionMode: 'default',
        agentModeId: 'plan',
        modelId: 'new-session-model',
        connectedServices: incomingConnectedServices,
      }),
    });

    expect(result.snapshot).toMatchObject({
      sessionId: null,
      connectedServices: incomingConnectedServices,
      connectedServicesUpdatedAt: null,
      permissionMode: null,
      agentModeId: null,
      modelId: null,
      vendorResumeId: null,
    });
    expect(result.spawnOptions).toMatchObject({
      connectedServices: incomingConnectedServices,
      permissionMode: 'default',
      agentModeId: 'plan',
      modelId: 'new-session-model',
    });
  });

  it('carries stable connected-service materialization identity from persisted metadata into resume spawn options', () => {
    const trackedIdentity = {
      v: 1,
      id: 'csm_tracked_1',
      createdAtMs: 9,
    } as const;
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions(),
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServices: incomingConnectedServices,
        connectedServiceMaterializationIdentityV1: trackedIdentity,
      } as SpawnSessionOptions & {
        connectedServiceMaterializationIdentityV1: typeof trackedIdentity;
      },
    });

    expect((result.snapshot as { connectedServiceMaterializationIdentityV1?: unknown }).connectedServiceMaterializationIdentityV1)
      .toEqual(materializationIdentity);
    expect((result.spawnOptions as { connectedServiceMaterializationIdentityV1?: unknown }).connectedServiceMaterializationIdentityV1)
      .toEqual(materializationIdentity);
  });

  // D15a (session cmq7pyqkj, 2026-06-12): a UI resume RPC carries one-shot delivery fields
  // (initialTranscriptAfterSeq etc.). Persisting them into tracked spawn options made every later
  // crash/auth respawn replay already-processed user messages via explicit startup catch-up.
  it('strips one-shot delivery fields from the durable spawn-options snapshot', () => {
    const result = resolveSessionRuntimeSnapshot({
      incomingOptions: baseIncomingOptions({
        initialTranscriptAfterSeq: 33294,
        executionAuthorization: { provenance: 'user_request', requestId: 'message-1' },
        pendingFirstInput: { text: 'one-shot prompt', localId: 'spawn-first:nonce' },
        initialGoal: { goalText: 'one-shot goal' } as unknown as SpawnSessionOptions['initialGoal'],
        existingSessionAttachPayload: { v: 2, encryptionMode: 'plain' },
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 100,
      }),
      persistedMetadata: null,
    });

    expect(result.spawnOptions.initialTranscriptAfterSeq).toBeUndefined();
    expect(result.spawnOptions.executionAuthorization).toBeUndefined();
    expect(result.spawnOptions.pendingFirstInput).toBeUndefined();
    expect(result.spawnOptions.initialGoal).toBeUndefined();
    expect(result.spawnOptions.existingSessionAttachPayload).toBeUndefined();
    // Durable runtime controls are preserved.
    expect(result.spawnOptions.permissionMode).toBe('yolo');
    expect(result.spawnOptions.directory).toBe('/tmp/repo');
  });
});
