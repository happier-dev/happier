import { describe, expect, it } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { buildInactiveUsageLimitResumeSpawnOptions } from './buildInactiveUsageLimitResumeSpawnOptions';

const connectedServices = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected',
      selection: 'profile',
      profileId: 'claude-profile-1',
    },
  },
} as const;

const materializationIdentity = {
  v: 1,
  id: 'csm_usage_limit_1',
  createdAtMs: 123,
} as const;

function rawSession(overrides: Partial<RawSessionRecord>): RawSessionRecord {
  // RawSessionRecord is a protocol fixture; this helper only reads path and machineId.
  return overrides as RawSessionRecord;
}

describe('buildInactiveUsageLimitResumeSpawnOptions', () => {
  it('rehydrates persisted runtime controls through the session runtime snapshot', () => {
    const result = buildInactiveUsageLimitResumeSpawnOptions({
      sessionId: 'session-1',
      fallbackMachineId: 'fallback-machine',
      rawSession: rawSession({
        id: 'session-1',
        path: '/repo/from-raw',
        machineId: 'raw-machine',
      }),
      metadata: {
        flavor: 'claude',
        path: '/repo/from-raw',
        connectedServices,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
        connectedServicesUpdatedAt: 1000,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 1010,
        sessionModeOverrideV1: { v: 1, modeId: 'build', updatedAt: 1020 },
        modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 1030 },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'claude',
          provider: {},
        },
      },
    });

    expect(result).toMatchObject({
      existingSessionId: 'session-1',
      machineId: 'raw-machine',
      directory: '/repo/from-raw',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      approvedNewDirectoryCreation: true,
      connectedServices,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      connectedServicesUpdatedAt: 1000,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 1010,
      agentModeId: 'build',
      agentModeUpdatedAt: 1020,
      modelId: 'claude-opus-4-7',
      modelUpdatedAt: 1030,
      agentRuntimeDescriptorV1: expect.objectContaining({
        providerId: 'claude',
        provider: {},
      }),
    });
  });

  it('returns null when the inactive session cannot be mapped to a spawn target', () => {
    expect(buildInactiveUsageLimitResumeSpawnOptions({
      sessionId: 'session-1',
      fallbackMachineId: 'fallback-machine',
      rawSession: rawSession({ id: 'session-1' }),
      metadata: {},
    })).toBeNull();
  });
});
