import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { readPendingQueueV2ActivationEligibilityFromServer } from '@/api/session/pendingQueueV2Transport';
import { reportPendingSessionActivationFailure } from '@/api/session/pendingActivationTransport';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import { activatePendingInactiveSession } from './activatePendingInactiveSession';

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(),
}));
vi.mock('@/api/session/pendingQueueV2Transport', () => ({
  readPendingQueueV2ActivationEligibilityFromServer: vi.fn(),
}));
vi.mock('@/api/session/pendingActivationTransport', () => ({
  reportPendingSessionActivationFailure: vi.fn(async () => ({ didFail: true })),
}));

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(7),
  },
};

describe('activatePendingInactiveSession', () => {
  beforeEach(() => {
    vi.mocked(fetchSessionByIdCompat).mockReset();
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockReset();
    vi.mocked(reportPendingSessionActivationFailure).mockClear();
  });

  it('starts the exact inactive session from durable Pending custody without any UI process', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death',
        requestedAt: 10,
        status: 'waiting',
      },
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
      runnerAcceptance: 'newly_accepted' as const,
    }));

    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'activated', runnerAcceptance: 'newly_accepted' });

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      initialTranscriptAfterSeq: 12,
      executionAuthorization: {
        provenance: 'user_request',
        requestId: 'pending-after-ui-death',
        requestedAt: 10,
      },
    }));
  });

  it('does not spawn when exact durable authorization changes after initial eligibility validation', async () => {
    const initialSession = {
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    };
    vi.mocked(fetchSessionByIdCompat)
      .mockResolvedValueOnce(initialSession)
      .mockResolvedValueOnce({
        ...initialSession,
        pendingVersion: 10,
        pendingActivationAuthorization: {
          requestId: 'pending-after-ui-death', requestedAt: 11, status: 'waiting',
        },
      });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer)
      .mockResolvedValueOnce('eligible')
      .mockResolvedValueOnce('eligible');
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(fetchSessionByIdCompat).toHaveBeenCalledTimes(2);
    expect(readPendingQueueV2ActivationEligibilityFromServer).toHaveBeenCalledTimes(2);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('does not spawn when the exact Pending row changes away from send-now before final Session validation', async () => {
    const rawSession = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex', codexSessionId: 'vendor-1' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 9,
      dataEncryptionKey: null,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer)
      .mockResolvedValueOnce('eligible')
      .mockResolvedValueOnce('ineligible');
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(fetchSessionByIdCompat).toHaveBeenCalledTimes(1);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('builds exact resume options from the final validated Session snapshot', async () => {
    const initialSession = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/old', flavor: 'codex', codexSessionId: 'vendor-1' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 9,
      dataEncryptionKey: null,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
    };
    vi.mocked(fetchSessionByIdCompat)
      .mockResolvedValueOnce(initialSession)
      .mockResolvedValueOnce({
        ...initialSession,
        seq: 13,
        metadataVersion: 2,
        metadata: JSON.stringify({ machineId: 'machine-1', path: '/current', flavor: 'codex', codexSessionId: 'vendor-1' }),
      });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toMatchObject({ status: 'activated' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/current',
      initialTranscriptAfterSeq: 13,
    }));
  });

  it('does not start an active runner or a session whose exact Pending authorization resolved', async () => {
    const baseSession = {
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    };
    const spawnSession = vi.fn();

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(baseSession);
    await expect(activatePendingInactiveSession({
      credentials,
      machineId: 'machine-1',
      sessionId: 'session-1',
      requestId: 'pending-after-ui-death',
      pendingVersion: 9,
      spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'active' });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...baseSession, active: false });
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

  it('rejects a Pending activation owned by a different exact machine', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1',
      seq: 12,
      createdAt: 1,
      updatedAt: 1,
      active: false,
      activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-1',
        path: '/repo',
        flavor: 'codex',
        codexSessionId: 'vendor-1',
      }),
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
      pendingCount: 1,
      pendingVersion: 9,
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting',
      },
      dataEncryptionKey: null,
      machineId: 'machine-1',
      path: '/repo',
    });
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
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['mismatched', { requestId: 'other', requestedAt: 10, status: 'waiting' as const }],
    ['failed', { requestId: 'pending-after-ui-death', requestedAt: 10, status: 'failed' as const, failureCode: 'runtime_start_failed' as const }],
  ])('does not start when durable activation authorization is %s', async (_label, pendingActivationAuthorization) => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadata: '{}', metadataVersion: 1, agentState: null,
      agentStateVersion: 0, pendingCount: 1, pendingVersion: 9, dataEncryptionKey: null,
      machineId: 'machine-1', path: '/repo',
      ...(pendingActivationAuthorization ? { pendingActivationAuthorization } : {}),
    });
    const spawnSession = vi.fn();

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });

    expect(readPendingQueueV2ActivationEligibilityFromServer).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects archived sessions and exact Pending rows that are not eligible user send-now custody', async () => {
    const baseSession = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain' as const, metadata: '{}', metadataVersion: 1, agentState: null,
      agentStateVersion: 0, pendingCount: 1, pendingVersion: 9, dataEncryptionKey: null,
      machineId: 'machine-1', path: '/repo',
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
    };
    const spawnSession = vi.fn();

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...baseSession, archivedAt: 11 });
    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'ineligible' });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(baseSession);
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('ineligible');
    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    })).resolves.toEqual({ status: 'rejected', reason: 'ineligible' });

    expect(spawnSession).not.toHaveBeenCalled();
    expect(reportPendingSessionActivationFailure).toHaveBeenCalledTimes(2);
  });

  it('leaves stale snapshots and ambiguous spawn outcomes waiting without failure CAS', async () => {
    const rawSession = {
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain' as const,
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex', codexSessionId: 'vendor-1' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 8,
      dataEncryptionKey: null, machineId: 'machine-1', path: '/repo',
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting' as const,
      },
    };
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue(rawSession);
    const spawnSession = vi.fn();
    const input = {
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9, spawnSession,
    };

    await expect(activatePendingInactiveSession(input)).resolves.toEqual({
      status: 'not-needed', reason: 'snapshot-stale',
    });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({ ...rawSession, pendingVersion: 9 });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    spawnSession.mockResolvedValue({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'runner may still attach',
    });
    await expect(activatePendingInactiveSession(input)).resolves.toEqual({
      status: 'not-needed', reason: 'spawn-ambiguous',
    });

    spawnSession.mockResolvedValue({ type: 'success', sessionIdStatus: 'pending' });
    await expect(activatePendingInactiveSession(input)).resolves.toEqual({
      status: 'not-needed', reason: 'spawn-ambiguous',
    });
    expect(reportPendingSessionActivationFailure).not.toHaveBeenCalled();
  });

  it('keeps a terminal spawn rejection observable when failure CAS transport fails', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex', codexSessionId: 'vendor-1' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 9,
      dataEncryptionKey: null, machineId: 'machine-1', path: '/repo',
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting',
      },
    });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    vi.mocked(reportPendingSessionActivationFailure).mockRejectedValueOnce(new Error('network unavailable'));

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'invalid persisted identity',
      })),
    })).rejects.toThrow('network unavailable');

    expect(reportPendingSessionActivationFailure).toHaveBeenCalledTimes(1);
  });

  it('treats a declined terminal failure CAS as an authorization-stale race', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValue({
      id: 'session-1', seq: 12, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'codex', codexSessionId: 'vendor-1' }),
      metadataVersion: 1, agentState: null, agentStateVersion: 0, pendingCount: 1, pendingVersion: 9,
      dataEncryptionKey: null, machineId: 'machine-1', path: '/repo',
      pendingActivationAuthorization: {
        requestId: 'pending-after-ui-death', requestedAt: 10, status: 'waiting',
      },
    });
    vi.mocked(readPendingQueueV2ActivationEligibilityFromServer).mockResolvedValue('eligible');
    vi.mocked(reportPendingSessionActivationFailure).mockResolvedValueOnce({ didFail: false });

    await expect(activatePendingInactiveSession({
      credentials, machineId: 'machine-1', sessionId: 'session-1',
      requestId: 'pending-after-ui-death', pendingVersion: 9,
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'invalid persisted identity',
      })),
    })).resolves.toEqual({ status: 'not-needed', reason: 'authorization-stale' });
  });
});
