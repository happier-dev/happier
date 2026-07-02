import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

type RuntimeSnapshotValue<T extends string> = Readonly<{ value: T; updatedAt: number }>;

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
      modelId: RuntimeSnapshotValue<string> | null;
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
      modelId: 'claude-opus-4-7',
      modelUpdatedAt: 530,
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
        initialPrompt: 'one-shot wake prompt',
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
    expect('initialPrompt' in result.spawnOptions).toBe(false);
  });
});
