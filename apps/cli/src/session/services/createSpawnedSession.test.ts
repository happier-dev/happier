import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const spawnDaemonSession = vi.hoisted(() => vi.fn());
const resolveDaemonSpawnSessionByNonce = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const validateStoredAuthTokenAgainstActiveServer = vi.hoisted(() => vi.fn());
const sendSessionMessage = vi.hoisted(() => vi.fn());
const callMachineRpc = vi.hoisted(() => vi.fn());
const requestSessionStop = vi.hoisted(() => vi.fn());
const archiveSessionOnceInactive = vi.hoisted(() => vi.fn());
const archiveSessionByIdBestEffort = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
  resolveDaemonSpawnSessionByNonce,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc }));

vi.mock('./sendSessionMessage', () => ({ sendSessionMessage }));
vi.mock('./requestSessionStop', () => ({ requestSessionStop }));
vi.mock('./archiveSessionOnceInactive', () => ({ archiveSessionOnceInactive }));
vi.mock('./setSessionArchivedState', () => ({ archiveSessionByIdBestEffort }));

import { createSpawnedSession, type CreateSpawnedSessionParams } from './createSpawnedSession';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';

describe('createSpawnedSession settlement', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
  };
  const providerConnectionId = ProviderConnectionIdSchema.parse('pc_work');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    spawnDaemonSession.mockReset();
    resolveDaemonSpawnSessionByNonce.mockReset();
    fetchSessionById.mockReset();
    validateStoredAuthTokenAgainstActiveServer.mockReset();
    sendSessionMessage.mockReset();
    callMachineRpc.mockReset();
    requestSessionStop.mockReset();
    archiveSessionOnceInactive.mockReset();
    archiveSessionByIdBestEffort.mockReset();
    sendSessionMessage.mockResolvedValue({ ok: true, sessionId: 'session-created', localId: 'local-1', waited: false });
    validateStoredAuthTokenAgainstActiveServer.mockResolvedValue({ state: 'valid' });
    requestSessionStop.mockResolvedValue({ ok: true, sessionId: 'session-abandoned', stopped: true });
    archiveSessionOnceInactive.mockResolvedValue({ archivedAt: 123 });
    archiveSessionByIdBestEffort.mockResolvedValue(undefined);
  });

  it('keeps the first turn in ephemeral spawn custody until the child commits it through Pending', async () => {
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'session-created' });
    fetchSessionById.mockResolvedValue({
      id: 'session-created',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    await createSpawnedSession({
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
        updatedAt: 1,
      },
      spawnNonce: 'launch-1',
      initialMessage: 'Inspect this repo',
    });

    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      pendingFirstInput: {
        text: 'Inspect this repo',
        localId: 'spawn-first-turn:launch-1',
      },
    }));
    expect(spawnDaemonSession.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(fetchSessionById).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-created',
    });
    expect(spawnDaemonSession.mock.invocationCallOrder[0]).toBeLessThan(fetchSessionById.mock.invocationCallOrder[0]);
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('submits Provider-bound actions atomically through the current-only machine RPC', async () => {
    callMachineRpc
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'provider-action-1',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-provider' });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    fetchSessionById.mockResolvedValue({
      id: 'session-provider',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-1',
    });

    expect(result.sessionId).toBe('session-provider');
    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      request: expect.objectContaining({
        machineId: 'machine-1',
        spawnNonce: 'provider-action-1',
        modelSelection: {
          v: 1,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId,
            modelId: 'shared-model',
          },
          updatedAt: 1,
        },
      }),
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'provider-action-1' },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it.each([
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
  ])('maps Provider-bound current-only receiver absence (%s) to typed daemon unavailability without fallback', async (rpcErrorCode) => {
    callMachineRpc.mockRejectedValue(createRpcCallError({
      error: 'RPC method unavailable',
      errorCode: rpcErrorCode,
    }));

    const error = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-2',
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      message: 'Provider-bound session creation is unavailable because the selected machine does not support this request',
    });
    expect(error).not.toHaveProperty('details');
    expect(error).not.toHaveProperty('rpcErrorCode');
    expect(JSON.stringify(error)).not.toContain('provider-action-2');
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      request: expect.objectContaining({ spawnNonce: 'provider-action-2' }),
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('retains the Provider spawn nonce only when machine-RPC submission is ambiguous', async () => {
    callMachineRpc.mockRejectedValue(Object.assign(new Error('Machine RPC call timeout'), {
      code: 'MACHINE_RPC_TIMEOUT',
    }));

    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-timeout',
    })).rejects.toMatchObject({
      code: 'MACHINE_RPC_TIMEOUT',
      details: { spawnNonce: 'provider-action-timeout' },
    });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });

  it('refuses a Provider-bound action without a machine target before invoking either transport', async () => {
    await expect(createSpawnedSession({
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
    })).rejects.toMatchObject({ code: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });

    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(validateStoredAuthTokenAgainstActiveServer).not.toHaveBeenCalled();
  });

  it('resumes Provider-bound nonce settlement against the exact machine without submitting again', async () => {
    callMachineRpc.mockResolvedValue({ status: 'success', sessionId: 'session-provider-recovered' });
    resolveDaemonSpawnSessionByNonce.mockResolvedValue({ status: 'unsupported' });
    fetchSessionById.mockResolvedValue({
      id: 'session-provider-recovered',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId,
          modelId: 'shared-model',
        },
        updatedAt: 1,
      },
      spawnNonce: 'provider-action-retry',
      resumeOnly: true,
    });

    expect(result.sessionId).toBe('session-provider-recovered');
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials,
      machineId: 'machine-1',
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      request: { spawnNonce: 'provider-action-retry' },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(resolveDaemonSpawnSessionByNonce).not.toHaveBeenCalled();
  });

  it('waits past the old three-second window for one accepted spawn and one nonce', async () => {
    spawnDaemonSession.mockResolvedValue({
      success: true,
      status: 'pending',
      sessionIdStatus: 'pending',
      spawnNonce: 'daemon-echoed-nonce',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-slow-registration' });
    fetchSessionById.mockResolvedValue({
      id: 'session-after-slow-registration',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });

    const result = await createSpawnedSession({
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    }).finally(() => nowSpy.mockRestore());

    expect(result.sessionId).toBe('session-after-slow-registration');
    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledTimes(5);
    const sentNonce = spawnDaemonSession.mock.calls[0]?.[0]?.spawnNonce;
    expect(sentNonce).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/i));
    expect(resolveDaemonSpawnSessionByNonce).toHaveBeenCalledWith(sentNonce);
  });

  it('abandons a late-settled generated-nonce child through stop then bounded inactive archive', async () => {
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '100');
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_POLL_INTERVAL_MS', '25');
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_TIMEOUT_MS', '1000');
    vi.stubEnv('HAPPIER_SPAWN_ABANDON_POLL_INTERVAL_MS', '100');
    spawnDaemonSession.mockResolvedValue({
      success: true,
      status: 'pending',
      sessionIdStatus: 'pending',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-abandoned' });
    const cleanupOrder: string[] = [];
    requestSessionStop.mockImplementation(async () => {
      cleanupOrder.push('stop');
      return { ok: true, sessionId: 'session-abandoned', stopped: true };
    });
    archiveSessionOnceInactive.mockImplementation(async () => {
      cleanupOrder.push('archive');
      return { archivedAt: 123 };
    });
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });

    try {
      await expect(createSpawnedSession({
        credentials,
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      })).rejects.toMatchObject({
        code: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
    } finally {
      nowSpy.mockRestore();
    }

    await vi.waitFor(() => {
      expect(archiveSessionOnceInactive).toHaveBeenCalledWith({
        token: 'token',
        sessionId: 'session-abandoned',
      });
    });
    expect(archiveSessionOnceInactive).toHaveBeenCalledOnce();
    expect(requestSessionStop).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'session-abandoned',
    });
    expect(requestSessionStop).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(['stop', 'archive']);
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('resumes a caller-owned ambiguous predecessor nonce without a second spawn', async () => {
    spawnDaemonSession.mockResolvedValue({
      success: true,
      status: 'pending',
      sessionIdStatus: 'pending',
    });
    resolveDaemonSpawnSessionByNonce
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-original-attempt' });
    fetchSessionById.mockResolvedValue({
      id: 'session-from-original-attempt',
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: { path: '/repo', host: 'host' },
    });

    const stableAttempt = {
      credentials,
      directory: '/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      spawnNonce: 'action-request:session-1:tool-call-1',
    } satisfies CreateSpawnedSessionParams & Readonly<{ spawnNonce: string }>;

    await expect(createSpawnedSession(stableAttempt)).rejects.toMatchObject({
      code: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
    });
    const recovered = await createSpawnedSession({
      ...stableAttempt,
      resumeOnly: true,
    } as CreateSpawnedSessionParams & Readonly<{ resumeOnly: true }>);

    expect(recovered.sessionId).toBe('session-from-original-attempt');
    expect(spawnDaemonSession).toHaveBeenCalledTimes(1);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      spawnNonce: stableAttempt.spawnNonce,
    }));
  });
});
