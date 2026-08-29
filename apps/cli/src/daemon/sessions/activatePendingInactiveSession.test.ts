import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { listPendingQueueV2LocalIdsFromServer } from '@/api/session/pendingQueueV2Transport';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

import { activatePendingInactiveSession } from './activatePendingInactiveSession';

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  listPendingQueueV2LocalIdsFromServer: vi.fn(),
}));

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};
const tokenOnlyCredentials = {
  token: 'token-only',
  encryption: null,
};

function createSession(active: boolean) {
  return {
    id: 'session-1',
    seq: 12,
    createdAt: 1,
    updatedAt: 1,
    active,
    activeAt: 1,
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify({
      machineId: 'machine-1',
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'vendor-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    }),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    pendingCount: 1,
    pendingVersion: 9,
    dataEncryptionKey: null,
    machineId: 'machine-1',
    path: '/repo',
  };
}

describe('activatePendingInactiveSession', () => {
  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset();
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockReset();
  });

  it('starts the exact inactive session from durable Pending custody without any UI process', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated' });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      initialTranscriptAfterSeq: 12,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'pending-after-ui-death',
      },
    }));
  });

  it('starts a plaintext layout-v1 inactive session from its plain owner envelope without account encryption material', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
      },
      nativeSession: {
        codexSessionId: 'vendor-1',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          backendMode: 'appServer',
          providerSessionId: 'vendor-1',
        },
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'codex' },
      }),
      ownerMetadata:
        createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      machineId: undefined,
      path: undefined,
    });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue([
      'pending-after-ui-death',
    ]);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated' });

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: expect.objectContaining({
          backendMode: 'appServer',
          providerSessionId: 'vendor-1',
        }),
      },
    }));
  });

  it('keeps retained encrypted layout-v1 owner metadata locked for token-only credentials', async () => {
    const retainedOwnerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        machineId: 'machine-1',
        path: '/repo',
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        agentPresentation: { agentId: 'codex' },
      }),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: {
          type: 'legacy',
          secret: credentials.encryption.secret,
        },
        ownerMetadata: retainedOwnerMetadata,
        randomBytes: (length) =>
          new Uint8Array(length).fill(9),
      }),
      machineId: undefined,
      path: undefined,
    });
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue([
      'pending-after-ui-death',
    ]);
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({
      status: 'rejected',
      reason: 'identity-unavailable',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not start an active runner or a session whose exact Pending authorization resolved', async () => {
    const spawnSession = vi.fn();
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(true));
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'active' });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['different-pending']);
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'pending-resolved' });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects Pending activation for an externally linked session instead of spawning it', async () => {
    // A linked Session's hosted runtime is owned by External Sessions takeover:
    // durable Pending custody must not activate it behind takeover's back.
    const linked = createSession(false);
    linked.metadata = JSON.stringify({
      ...JSON.parse(linked.metadata),
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-1',
        source: { kind: 'codexHome', home: 'user' },
        linkedAtMs: 1,
      },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(linked);
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'takeover-required' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects Pending activation when the external link exists but is unresolved', async () => {
    const unresolved = createSession(false);
    unresolved.metadata = JSON.stringify({
      ...JSON.parse(unresolved.metadata),
      externalSessionV1: { v: 1 },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(unresolved);
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'takeover-required' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects a Pending activation owned by a different exact machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'identity-unavailable' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('accepts the evolved deferred spawn result for the exact existing session request', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(listPendingQueueV2LocalIdsFromServer).mockResolvedValue(['pending-after-ui-death']);
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      spawnNonce: 'spawn-1',
      sessionIdStatus: 'pending' as const,
    }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated' });

    expect(spawnSession).toHaveBeenCalledTimes(1);
  });
});
