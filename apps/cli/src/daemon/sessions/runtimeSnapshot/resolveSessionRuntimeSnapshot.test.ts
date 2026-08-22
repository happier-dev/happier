import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ConnectedServiceBindingsV1, ProviderBoundModelRef } from '@happier-dev/protocol';

type RuntimeSnapshotValue<T> = Readonly<{ value: T; updatedAt: number }>;

type RuntimeSnapshotModule = Readonly<{
  resolveSessionRuntimeSnapshot: (params: Readonly<{
    incomingOptions: SpawnSessionOptions;
    persistedMetadata?: Record<string, unknown> | null;
    trackedSpawnOptions?: SpawnSessionOptions | null;
    persistedVendorResumeId?: string | null;
    trackedVendorResumeId?: string | null;
  }>) => Readonly<{
    snapshot: Readonly<{
      sessionId: string | null;
      connectedServices: ConnectedServiceBindingsV1 | null;
      connectedServicesUpdatedAt: number | null;
      permissionMode: RuntimeSnapshotValue<PermissionMode> | null;
      agentModeId: RuntimeSnapshotValue<string> | null;
      modelSelection: RuntimeSnapshotValue<ProviderBoundModelRef | null> | null;
      vendorResumeId: Readonly<{ value: string; updatedAt: number | null }> | null;
    }>;
    spawnOptions: SpawnSessionOptions;
  }>;
}>;

async function loadRuntimeSnapshotModule(): Promise<RuntimeSnapshotModule | null> {
  const modulePath = './resolveSessionRuntimeSnapshot';
  return await import(modulePath).catch(() => null) as RuntimeSnapshotModule | null;
}

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

const persistedMaterializationIdentity = {
  v: 1,
  id: 'csm_persisted',
  createdAt: 1,
} as const;

const persistedProviderBinding = {
  v: 1,
  connectionId: 'pc_work',
  contributionKey: 'plugin.gateway/gateway',
  connectionRevision: 2,
  protocol: 'openai-responses',
  materialization: 'engineConfig',
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility-v1',
  bindingSecurityFingerprint: 'security-v1',
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Work',
    connectionRole: 'named',
    connectionDisplayNameMode: 'custom',
  },
} as const;

describe('resolveSessionRuntimeSnapshot', () => {
  it('restores persisted runtime controls over stale incoming defaults', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        resume: 'incoming-vendor-resume',
      },
      persistedMetadata: {
        connectedServices: persistedConnectedServices,
        connectedServicesUpdatedAt: 500,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 510,
        sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 520 },
        modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 530 },
        connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
      },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'csm_tracked',
          createdAt: 2,
        },
      } as SpawnSessionOptions & Record<string, unknown>,
      persistedVendorResumeId: 'vendor-persisted',
    });

    expect(result.spawnOptions).toMatchObject({
      connectedServices: persistedConnectedServices,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 510,
      agentModeId: 'plan',
      agentModeUpdatedAt: 520,
      modelSelection: {
        v: 1,
        updatedAt: 530,
        ref: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'claude-opus-4-7' },
      },
      resume: 'incoming-vendor-resume',
    });
    expect((result.spawnOptions as unknown as Record<string, unknown>).connectedServiceMaterializationIdentityV1)
      .toEqual(persistedMaterializationIdentity);
    expect((result.spawnOptions as unknown as Record<string, unknown>).connectedServicesUpdatedAt).toBe(500);
    expect((result.snapshot as Record<string, unknown>).connectedServiceMaterializationIdentityV1)
      .toEqual(persistedMaterializationIdentity);
    expect(result.snapshot.connectedServicesUpdatedAt).toBe(500);
  });

  it('strips one-shot delivery fields from the durable spawn-options snapshot', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        initialTranscriptAfterSeq: 33294,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 510,
      },
      persistedMetadata: null,
      trackedSpawnOptions: {
        directory: '/tmp/repo',
      },
    });

    // Durable respawn identity must keep runtime controls but never replay one-shot
    // delivery cursors/prompts on later crash respawns.
    expect(result.spawnOptions).toMatchObject({
      directory: '/tmp/repo',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 510,
    });
    expect('initialTranscriptAfterSeq' in result.spawnOptions).toBe(false);
  });

  it('does not let undocumented bare metadata replace a canonical provider-bound selection', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        providerBindingV1: persistedProviderBinding,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 100,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
        modelId: 'stale-native-model',
        modelUpdatedAt: 999,
      },
    });

    expect(result.spawnOptions.modelSelection).toEqual({
      v: 1,
      updatedAt: 100,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    });
  });

  it('refuses malformed persisted Provider continuity before runtime-state arbitration', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    expect(() => runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        providerBindingV1: { v: 1, connectionId: 'pc_work' },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 100,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_work',
            modelId: 'provider-model',
          },
        },
      },
    })).toThrow(expect.objectContaining({
      providerError: expect.objectContaining({
        code: 'provider_binding_changed',
        connectionId: 'pc_work',
      }),
    }));
  });

  it('restores observed vendor resume evidence without persisting it as explicit resume', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: ' codex-thread-from-metadata ',
      },
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'codex-thread-from-metadata',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('prefers the persisted provider identity over stale tracked observation', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'codex',
        codexSessionId: 'codex-thread-persisted',
      },
      persistedVendorResumeId: 'codex-thread-persisted',
      trackedVendorResumeId: 'codex-thread-stale',
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'codex-thread-persisted',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('resumes an observed Claude identity from the persisted id alone', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'observed-claude-session',
      },
      trackedVendorResumeId: 'observed-claude-session',
    });

    // `AM-24`: the transcript-path gate is gone, and Claude now follows the same
    // rule as every other Agent — the persisted current view is the authority.
    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'observed-claude-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('restores observed Claude identity without persisting explicit resume', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'observed-claude-session',
        claudeTranscriptPath: '/tmp/observed-claude-session.jsonl',
      },
      trackedVendorResumeId: 'observed-claude-session',
    });

    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'observed-claude-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('does not persist an observed Claude identity as explicit resume authority', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const observedVendorResumeId = 'observed-claude-session';
    const first = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: observedVendorResumeId,
        claudeTranscriptPath: `/tmp/${observedVendorResumeId}.jsonl`,
      },
      trackedVendorResumeId: observedVendorResumeId,
    });

    const second = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: first.spawnOptions,
      trackedSpawnOptions: first.spawnOptions,
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: observedVendorResumeId,
      },
      trackedVendorResumeId: observedVendorResumeId,
    });

    // Still resumable from the persisted view, but never promoted into
    // `spawnOptions.resume`: an observation is not an explicit user instruction.
    expect(second.snapshot.vendorResumeId).toEqual({
      value: observedVendorResumeId,
      updatedAt: null,
    });
    expect(second.spawnOptions.resume).toBeUndefined();
  });

  it('prefers the persisted Claude id over a diverging tracked observation', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        flavor: 'claude',
        claudeSessionId: 'durably-proven-session',
        claudeTranscriptPath: '/tmp/durably-proven-session.jsonl',
      },
      trackedVendorResumeId: 'newer-observed-session',
    });

    // One rule for every Agent (`AM-24`): the persisted current view wins over a
    // tracked runtime observation. The Claude-only divergence gate that used to
    // refuse the resume outright existed to protect an id/proof pairing that no
    // longer exists, and Codex already behaved exactly this way.
    expect(result.snapshot.vendorResumeId).toEqual({
      value: 'durably-proven-session',
      updatedAt: null,
    });
    expect(result.spawnOptions.resume).toBeUndefined();
  });

  it('preserves explicit incoming and tracked spawn resume without derived proof', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const incoming = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        resume: 'explicit-incoming-resume',
      },
      persistedMetadata: { flavor: 'claude', claudeSessionId: 'observed-only' },
    });
    const tracked = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-1',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
      persistedMetadata: { flavor: 'claude', claudeSessionId: 'observed-only' },
      trackedSpawnOptions: {
        directory: '/tmp/repo',
        resume: 'explicit-tracked-resume',
      },
    });

    expect(incoming.spawnOptions.resume).toBe('explicit-incoming-resume');
    expect(tracked.spawnOptions.resume).toBe('explicit-tracked-resume');
  });

  it('retains an external Agent’s observed resume identity without consulting built-in policy', async () => {
    const runtimeSnapshot = await loadRuntimeSnapshotModule();
    expect(runtimeSnapshot).not.toBeNull();
    if (!runtimeSnapshot) return;

    const result = runtimeSnapshot.resolveSessionRuntimeSnapshot({
      incomingOptions: {
        directory: '/tmp/repo',
        existingSessionId: 'session-external-1',
        backendTarget: { kind: 'backend', backendId: 'acme.review-agent', sourceKind: 'built_in' },
      },
      persistedMetadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'acme.review-agent',
          agent: {},
        },
      },
      trackedVendorResumeId: 'acme-session-1',
    });

    expect(result.snapshot.vendorResumeId).toEqual({ value: 'acme-session-1', updatedAt: null });
  });
});
