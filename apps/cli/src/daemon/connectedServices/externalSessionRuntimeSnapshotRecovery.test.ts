import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSessionMarkersMock = vi.fn();

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: (...args: unknown[]) => listSessionMarkersMock(...args),
}));

import { resolveConnectedServiceRuntimeSnapshotForExternalSession } from './externalSessionRuntimeSnapshotRecovery';

describe('resolveConnectedServiceRuntimeSnapshotForExternalSession', () => {
  beforeEach(() => {
    listSessionMarkersMock.mockReset();
  });

  it('matches A13-retained directSessionV1 markers through the canonical link reader', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'work',
        },
      },
    };
    listSessionMarkersMock.mockResolvedValueOnce([{
      pid: 123,
      happySessionId: 'session_1',
      happyHomeDir: '/tmp/happier',
      createdAt: 1,
      updatedAt: 2,
      flavor: 'codex',
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          machineId: 'machine_1',
          remoteSessionId: 'thread_1',
          source: { kind: 'codexHome', home: 'user' },
        },
        connectedServices,
        connectedServicesUpdatedAt: 10,
      },
    }]);

    await expect(resolveConnectedServiceRuntimeSnapshotForExternalSession({
      agentId: 'codex',
      remoteSessionId: 'thread_1',
    })).resolves.toEqual({
      connectedServices,
      connectedServicesUpdatedAt: 10,
    });
  });
});
