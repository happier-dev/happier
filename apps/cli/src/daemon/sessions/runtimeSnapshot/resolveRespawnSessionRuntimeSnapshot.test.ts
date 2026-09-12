import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import { resolveRespawnSessionRuntimeSnapshot } from './resolveRespawnSessionRuntimeSnapshot';

const persistedConnectedServices = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'profile',
      profileId: 'persisted-codex-profile',
    },
  },
} as const;

const persistedMaterializationIdentity = {
  v: 1,
  id: 'csm_respawn_snapshot_1',
  createdAtMs: 123,
} as const;

function defaultRespawnOptions(overrides: Partial<SpawnSessionOptions> = {}): SpawnSessionOptions {
  return {
    directory: '/tmp/repo',
    existingSessionId: 'session-1',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    approvedNewDirectoryCreation: true,
    ...overrides,
  };
}

function credentials(token: string): Credentials {
  return {
    token,
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

describe('resolveRespawnSessionRuntimeSnapshot', () => {
  it('applies the persisted runtime snapshot before respawning a tracked session', async () => {
    const readCredentials = vi.fn(async () => credentials('fresh-token'));
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: { v: 2 as const, encryptionMode: 'plain' as const },
      vendorResumeId: 'persisted-vendor-resume',
      sessionPath: '/tmp/repo',
      deliveredUserMessageSeq: null,
      metadata: {
        connectedServices: persistedConnectedServices,
        connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
        connectedServicesUpdatedAt: 700,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 710,
        sessionModeOverrideV1: { v: 1, modeId: 'build', updatedAt: 720 },
        modelOverrideV1: { v: 1, modelId: 'gpt-5.3-codex', updatedAt: 730 },
      },
    }));

    const trackedSpawnOptions = defaultRespawnOptions({
      permissionMode: 'default',
      permissionModeUpdatedAt: 100,
      connectedServices: { v: 1, bindingsByServiceId: {} },
      connectedServicesUpdatedAt: 100,
      resume: 'stale-vendor-resume',
    });

    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: trackedSpawnOptions,
      vendorResumeId: 'tracked-vendor-resume',
      defaultOptions: defaultRespawnOptions({
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 100,
        resume: 'stale-vendor-resume',
      }),
      credentials: credentials('stale-token'),
      readCredentials,
      resolveAttachContext,
    });

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(resolveAttachContext).toHaveBeenCalledWith(expect.objectContaining({
      token: 'fresh-token',
      sessionId: 'session-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }));
    expect(result).toMatchObject({
      connectedServices: persistedConnectedServices,
      connectedServiceMaterializationIdentityV1: persistedMaterializationIdentity,
      connectedServicesUpdatedAt: 700,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 710,
      agentModeId: 'build',
      agentModeUpdatedAt: 720,
      modelId: 'gpt-5.3-codex',
      modelUpdatedAt: 730,
      resume: 'stale-vendor-resume',
    });
  });

  it('falls back to default respawn options when persisted metadata cannot be loaded', async () => {
    const defaultOptions = defaultRespawnOptions({ resume: 'vendor-resume' });
    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: defaultOptions,
      vendorResumeId: 'vendor-resume',
      defaultOptions,
      credentials: credentials('token'),
      readCredentials: async () => null,
      resolveAttachContext: async () => ({ ok: false as const, reason: 'missingToken' }),
    });

    expect(result).toBe(defaultOptions);
  });

  it('uses the canonical default backend target when legacy respawn options omit it', async () => {
    const resolveAttachContext = vi.fn(async () => ({
      ok: true as const,
      attachPayload: { v: 2 as const, encryptionMode: 'plain' as const },
      vendorResumeId: 'claude-session-1',
      sessionPath: '/tmp/repo',
      deliveredUserMessageSeq: null,
      metadata: {
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 710,
      },
    }));
    const legacyOptions = defaultRespawnOptions({ backendTarget: undefined });

    const result = await resolveRespawnSessionRuntimeSnapshot({
      sessionId: 'session-1',
      spawnOptions: legacyOptions,
      vendorResumeId: 'claude-session-1',
      defaultOptions: legacyOptions,
      credentials: credentials('token'),
      readCredentials: async () => null,
      resolveAttachContext,
    });

    expect(resolveAttachContext).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    }));
    expect(result).toMatchObject({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 710,
    });
  });
});
