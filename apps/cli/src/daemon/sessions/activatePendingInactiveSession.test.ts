import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';

import { activatePendingInactiveSession } from './activatePendingInactiveSession';
type ResumeOptions = Parameters<Parameters<typeof activatePendingInactiveSession>[0]['spawnSession']>[0];

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  readPendingQueueV2ActivationEligibilityFromServer: vi.fn(),
}));
vi.mock('@/api/session/pendingActivationTransport', () => ({
  reportPendingSessionActivationFailure: vi.fn(async () => ({ didFail: true })),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain' })),
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
    pendingActivationAuthorization: {
      requestId: 'pending-after-ui-death',
      requestedAt: 10,
      status: 'waiting' as const,
    },
    dataEncryptionKey: null,
    machineId: 'machine-1',
    path: '/repo',
  };
}

describe('activatePendingInactiveSession', () => {
  it('retains requester pending custody without reporting failure or spawning after Machine admission is lost', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn(async (_options: ResumeOptions) => ({ type: 'success' as const, sessionId: 'session-1' }));
    const params = {
      credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
      requester: { serverHttpBaseUrl: 'https://bob-home.test',
        attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'machine-1', installationId: 'installation' },
        isCurrent: async () => false },
    };
    expect(await activatePendingInactiveSession(params)).toEqual({ status: 'not-needed', reason: 'authorization-stale' });
    expect(spawnSession).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('preserves exact requester/Home custody on inactive resume and rechecks admission before spawn', async () => {
    let current = true;
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn(async (_options: ResumeOptions) => ({ type: 'success' as const, sessionId: 'session-1' }));
    const requester = { serverHttpBaseUrl: 'https://bob-home.test',
      attribution: { serverId: 'bob-home', accountId: 'bob', machineId: 'machine-1', installationId: 'installation' },
      isCurrent: async () => current };
    const params = { credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession, requester };
    expect(await activatePendingInactiveSession(params)).toEqual({ status: 'activated' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'session-1',
      requesterWorkAttributionV1: requester.attribution,
      verifyRequesterMachineAdmissionCurrent: expect.any(Function) }));
    const options = spawnSession.mock.calls[0]?.[0];
    current = false;
    expect(await options?.verifyRequesterMachineAdmissionCurrent()).toBe(false);
  });

  it('leaves the queued prompt in custody when the managed session directory is missing', async () => {
    const session = createSession(false);
    session.metadata = JSON.stringify({
      machineId: 'machine-1', path: '/repo',
      acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'my-acp', title: 'My ACP' },
      sessionDirectoryV1: { v: 1, kind: 'managed' },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(session);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn(async () => ({
      type: 'error' as const,
      errorCode: 'SESSION_DIRECTORY_MISSING' as const,
      errorMessage: 'Session folder is missing',
    }));
    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'session-directory-missing' });
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token-only', sessionId: 'session-1', requestId: 'pending-after-ui-death',
      requestedAt: 10, failureCode: 'runtime_start_failed',
    });
  });

  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset();
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockReset();
    vi.mocked(reportPendingSessionActivationFailure).mockClear();
  });

  it('starts the exact inactive session from durable Pending custody without any UI process', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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
        requestedAt: 10,
      },
    }));
  });

  it('does not spawn when the exact durable authorization is rearmed before the final decision', async () => {
    vi.mocked(fetchSessionByIdCompat)
      .mockResolvedValueOnce(createSession(false))
      .mockResolvedValueOnce({
        ...createSession(false),
        pendingActivationAuthorization: {
          requestId: 'pending-after-ui-death',
          requestedAt: 11,
          status: 'waiting' as const,
        },
      });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials: tokenOnlyCredentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(fetchSessionByIdCompat).toHaveBeenCalledTimes(2);
    expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalledTimes(2);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
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
          agent: {
            backendMode: 'appServer',
            providerSessionId: 'vendor-1',
          },
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
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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

  it('delegates an active relay projection to the canonical runner serviceability owner', async () => {
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
      runnerAcceptance: 'preexisting_or_adopted' as const,
    }));
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(true));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated' });
    expect(spawnSession).toHaveBeenCalledOnce();
  });

  it('does not start a session whose exact Pending authorization resolved', async () => {
    const spawnSession = vi.fn();

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('missing');
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
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledOnce();
  });

  it('rejects Pending activation when the external link exists but is unresolved', async () => {
    const unresolved = createSession(false);
    unresolved.metadata = JSON.stringify({
      ...JSON.parse(unresolved.metadata),
      externalSessionV1: { v: 1 },
    });
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(unresolved);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token-only', sessionId: 'session-1', requestId: 'pending-after-ui-death',
      requestedAt: 10, failureCode: 'runtime_start_failed',
    });
  });

  it('rejects a Pending activation owned by a different exact machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'target-mismatch' });

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('leaves the evolved deferred spawn result waiting because session identity is ambiguous', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
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
    })).resolves.toEqual({ status: 'not-needed', reason: 'spawn-ambiguous' });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['mismatched', { requestId: 'other', requestedAt: 10, status: 'waiting' as const }],
    ['failed', { requestId: 'pending-after-ui-death', requestedAt: 10, status: 'failed' as const, failureCode: 'runtime_start_failed' as const }],
  ])('does not start when durable activation authorization is %s', async (_label, authorization) => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      pendingActivationAuthorization: authorization,
    });
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(readPendingQueueV2ActivationEligibilityFromServer).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('reports deterministic ineligibility through the exact failure CAS', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      ...createSession(false),
      archivedAt: 11,
    });
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'ineligible' });

    expect(reportPendingSessionActivationFailure).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      requestedAt: 10,
      failureCode: 'runtime_start_failed',
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('does not terminally fail a durable authorization targeted at another machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-2',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession: vi.fn(),
    })).resolves.toEqual({ status: 'not-needed', reason: 'target-mismatch' });

    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('reports a deterministic spawn rejection and keeps CAS transport failure observable', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    vi.mocked(reportPendingSessionActivationFailure).mockRejectedValueOnce(new Error('network unavailable'));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'invalid persisted identity',
      })),
    })).rejects.toThrow('network unavailable');
  });

  it('treats a declined terminal failure CAS as an authorization-stale race', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(createSession(false));
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('ineligible');
    vi.mocked(reportPendingSessionActivationFailure).mockResolvedValueOnce({ didFail: false });

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession: vi.fn(),
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });
  });
});
