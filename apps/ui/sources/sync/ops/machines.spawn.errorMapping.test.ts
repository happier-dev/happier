import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionModelSelectionV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createSpawnAttemptKeyForFreshSpawnOptions } from '@/sync/domains/session/spawn/spawnAttemptKey';
import { readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnIfNeededMock = vi.hoisted(() => vi.fn(async () => ({})));
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'generated-spawn-id'));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('../api/session/apiSocket', () => ({
  apiSocket: {
    machineRPC: vi.fn(),
    sessionRPC: vi.fn(),
  },
}));

vi.mock('@/sync/runtime/socketIoAckTimeout', () => ({
  isSocketIoAckTimeoutError: (error: unknown) =>
    error instanceof Error && error.message.includes('timed out'),
}));

vi.mock('@/platform/randomUUID', () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock('./accountSettingsDaemonSpawnPreparation', async (importOriginal) => ({
  ...await importOriginal<typeof import('./accountSettingsDaemonSpawnPreparation')>(),
  prepareAccountSettingsForDaemonSpawnIfNeeded: prepareAccountSettingsForDaemonSpawnIfNeededMock,
  registerAccountSettingsDaemonSpawnPreparation: vi.fn(() => vi.fn()),
}));

describe('machineSpawnNewSession error mapping', () => {
  const initialStorageState = storage.getInitialState();
  const providerModelSelection = SessionModelSelectionV1Schema.parse({
    v: 1,
    updatedAt: 1,
    ref: {
      agentTargetKey: 'backend:claude',
      providerConnectionId: 'pc_work',
      modelId: 'provider-model',
    },
  });
  const nativeModelSelection = SessionModelSelectionV1Schema.parse({
    v: 1,
    updatedAt: 1,
    ref: {
      agentTargetKey: 'backend:claude',
      providerConnectionId: null,
      modelId: 'native-model',
    },
  });

  function buildMachine(params: Readonly<{
    id: string;
    cliVersion?: string | null;
    homeDir?: string | null;
    platform?: string;
  }>): Machine {
    const homeDir = params.homeDir === undefined ? '/Users/alice' : params.homeDir;
    return {
      id: params.id,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      revokedAt: null,
      metadata: homeDir === null ? null : {
        host: params.id,
        platform: params.platform ?? 'darwin',
        happyCliVersion: params.cliVersion ?? '0.2.0',
        happyHomeDir: `${homeDir}/.happier`,
        homeDir,
      },
      metadataVersion: 0,
      daemonState: params.cliVersion
        ? ({ cliVersion: params.cliVersion } as any)
        : null,
      daemonStateVersion: params.cliVersion ? 1 : 0,
    };
  }

  beforeEach(() => {
    storage.setState({
      ...initialStorageState,
      profileScope: { serverId: 'server-b', accountId: 'account-a' },
      machines: { 'machine-1': buildMachine({ id: 'machine-1' }) },
    }, true);
    getPersistenceStorage().clearAll();
    machineRpcWithServerScopeMock.mockReset();
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockReset();
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValue({});
    randomUUIDMock.mockReset();
    randomUUIDMock.mockReturnValue('generated-spawn-id');
  });

  it('uses one current-only Provider-safe RPC so an older daemon refuses before spawn', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
    const beforeProfileScope = storage.getState().profileScope;

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelSelection: providerModelSelection,
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'error' });
    expect(storage.getState().profileScope).toEqual(beforeProfileScope);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      serverId: 'server-b',
    }));
  });

  it('clears fresh Provider spawn custody when the current-only daemon method is not found', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not found'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      }),
    );

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelSelection: providerModelSelection,
      serverId: 'server-b',
      userAttemptId: 'provider-method-not-found-attempt',
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    });
    expect(result.spawnAttemptCustody).toBeUndefined();
    expect(readSpawnAttemptCustodyState({ serverId: 'server-b', accountId: 'account-a' }))
      .toEqual({ status: 'missing' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      serverId: 'server-b',
    }));
  });

  it.each([
    ['no model selection', undefined],
    ['a native model selection', nativeModelSelection],
  ])('uses the versioned asynchronous spawn RPC for %s', async (_label, modelSelection) => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-native' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      ...(modelSelection ? { modelSelection } : {}),
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-native' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
  });

  it.each([
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
  ])('falls back to legacy spawn only after definitive provider-safe absence: %s', async (rpcErrorCode) => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(Object.assign(new Error('RPC method absent'), { rpcErrorCode }))
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-legacy' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'same-spawn-nonce',
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-legacy' });
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      payload: expect.objectContaining({ spawnNonce: 'same-spawn-nonce' }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
      payload: expect.objectContaining({ spawnNonce: 'same-spawn-nonce' }),
    }));
  });

  it('does not replay spawn through legacy after an ambiguous provider-safe timeout', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(new Error('machine RPC timed out'))
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      spawnNonce: 'ambiguous-spawn-nonce',
      serverId: 'server-b',
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });

    expect(machineRpcWithServerScopeMock.mock.calls.some(([call]) => (
      call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION
    ))).toBe(false);
  });

  it('keeps startup instructions out of ordinary spawn and admits them only through the trusted hidden-system seam', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-ordinary' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-hidden' });
    const startupInstructions = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 1,
      instructions: 'Hidden system-session startup text.',
    };
    const {
      machineSpawnNewSession,
      machineSpawnTrustedHiddenSystemSession,
    } = await import('./machines');

    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp/ordinary',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      serverId: 'server-b',
      userAttemptId: 'ordinary-startup-instructions-attempt',
      agentSessionStartupInstructionsV1: startupInstructions,
    } as any);
    await machineSpawnTrustedHiddenSystemSession({
      machineId: 'machine-1',
      directory: '/tmp/hidden',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      serverId: 'server-b',
      userAttemptId: 'hidden-startup-instructions-attempt',
    }, startupInstructions);

    const spawnPayloads = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE)
      .map((call) => call.payload);
    expect(spawnPayloads).toHaveLength(2);
    expect(spawnPayloads[0]).not.toHaveProperty('agentSessionStartupInstructionsV1');
    expect(spawnPayloads[1]?.agentSessionStartupInstructionsV1).toEqual(startupInstructions);
  });

  it('starts a Provider-bound session through the atomic Provider-safe RPC', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-provider' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelSelection: providerModelSelection,
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-provider' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      serverId: 'server-b',
    }));
  });

  it('returns a descriptive error when daemon RPC method is not available', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }))
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }));

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE);
    expect(result.errorMessage.toLowerCase()).toContain('daemon');
    expect(result.errorMessage.toLowerCase()).toContain('rpc');
  });

  it('uses the daemon-aligned RPC timeout for spawn session calls', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const { readSpawnSessionRpcTimeoutMsFromEnv } = await import('../domains/session/spawn/spawnSessionRpcTimeout');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('success');
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    const call = machineRpcWithServerScopeMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ timeoutMs: expect.any(Number) });
    expect(call.timeoutMs).toBe(readSpawnSessionRpcTimeoutMsFromEnv());
    expect(call.timeoutMs).toBe(5 * 60_000);
  });

  it('includes prepared account settings version hints in spawn requests', async () => {
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValueOnce({ accountSettingsVersionHint: 17 });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ accountSettingsVersionHint: 17 }),
    }));
  });

  it('generates a UI spawn nonce when fresh session callers omit one', async () => {
    randomUUIDMock.mockReturnValueOnce('fresh-spawn-1');
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      userAttemptId: 'attempt-fresh-spawn',
    });

    expect(result.type).toBe('success');
    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        spawnNonce: 'ui-session-spawn-fresh-spawn-1',
      }),
    }));
  });

  it('resolves a timed-out fresh spawn by generated nonce before returning failure', async () => {
    randomUUIDMock.mockReturnValueOnce('timeout-spawn-1');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-after-timeout',
      });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      userAttemptId: 'attempt-timeout-spawn',
    });

    expect(result).toMatchObject({
      type: 'success',
      sessionId: 'session-after-timeout',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      payload: expect.objectContaining({
        spawnNonce: 'ui-session-spawn-timeout-spawn-1',
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
      payload: { spawnNonce: 'ui-session-spawn-timeout-spawn-1' },
    }));
  });

  it('returns terminal child-exit resolution and clears durable launch custody', async () => {
    const errorMessage = 'Child process exited before session webhook (pid=8892, code=1, signal=null)';
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({
        status: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
        errorMessage,
      });

    const { machineSpawnNewSession } = await import('./machines');
    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      userAttemptId: 'attempt-child-exit',
      spawnNonce: 'nonce-child-exit',
    })).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage,
    });

    expect(readSpawnAttemptCustodyState({ serverId: 'server-b', accountId: 'account-a' }))
      .toEqual({ status: 'missing' });
  });

  it('consumes the Remote predecessor accepted-pending success and resolves the sent nonce', async () => {
    randomUUIDMock.mockReturnValueOnce('remote-predecessor-accepted');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'ui-session-spawn-remote-predecessor-accepted',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-from-remote-predecessor',
      });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      userAttemptId: 'attempt-remote-predecessor',
    });

    expect(result).toMatchObject({
      type: 'success',
      sessionId: 'session-from-remote-predecessor',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(3);
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload?.spawnNonce)
      .toBe('ui-session-spawn-remote-predecessor-accepted');
    expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload)
      .toEqual({ spawnNonce: 'ui-session-spawn-remote-predecessor-accepted' });
    expect(machineRpcWithServerScopeMock.mock.calls[2]?.[0]?.payload)
      .toEqual({ spawnNonce: 'ui-session-spawn-remote-predecessor-accepted' });
  });

  it('retains the Remote predecessor accepted-pending nonce for an unresolved retry', async () => {
    randomUUIDMock
      .mockReturnValueOnce('remote-predecessor-retry-1')
      .mockReturnValueOnce('remote-predecessor-retry-2');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'ui-session-spawn-remote-predecessor-retry-1',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-from-accepted-retry',
      });
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 6 * 60_000;
      return nowMs;
    });

    try {
      const { machineSpawnNewSession } = await import('./machines');
      const options = {
        machineId: 'machine-1',
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        serverId: 'server-b',
        userAttemptId: 'attempt-remote-predecessor-retry',
      } as const;

      const unresolved = await machineSpawnNewSession(options);
      expect(unresolved).toMatchObject({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      });
      await expect(machineSpawnNewSession(options)).resolves.toMatchObject({
        type: 'success',
        sessionId: 'session-from-accepted-retry',
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.payload.spawnNonce).toBe('ui-session-spawn-remote-predecessor-retry-1');
  });

  it('reuses the attempt nonce for retryable unresolved spawn timeouts', async () => {
    randomUUIDMock
      .mockReturnValueOnce('attempt-spawn-1')
      .mockReturnValueOnce('attempt-spawn-2');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    const baseOptions = {
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      userAttemptId: 'attempt-spawn-action-target-1',
    } as const;

    await machineSpawnNewSession(baseOptions);
    await machineSpawnNewSession(baseOptions);

    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        spawnNonce: 'ui-session-spawn-attempt-spawn-1',
      }),
    }));
  });

  it('retires a submitted launch only after the nonce owner proves it was not found', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
    try {
      let spawnCalls = 0;
      let resolverCalls = 0;
      machineRpcWithServerScopeMock.mockImplementation(async (call: { method?: string }) => {
        if (call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
          spawnCalls += 1;
          return spawnCalls === 1
            ? { type: 'success', spawnNonce: 'nonce-a', sessionIdStatus: 'pending' }
            : { type: 'success', sessionId: 'session-after-proven-not-found' };
        }
        resolverCalls += 1;
        return resolverCalls === 1 ? { status: 'unsupported' } : { status: 'not_found' };
      });

      const { machineSpawnNewSession } = await import('./machines');
      const options = {
        machineId: 'machine-1',
        directory: '/repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' as const },
        serverId: 'server-b',
        userAttemptId: 'attempt-a',
        spawnNonce: 'nonce-a',
      } as const;
      await expect(machineSpawnNewSession(options)).resolves.toMatchObject({
        type: 'error',
        spawnAttemptCustody: { status: 'unresolved', spawnNonce: 'nonce-a' },
      });

      const retry = machineSpawnNewSession(options);
      await vi.advanceTimersByTimeAsync(15_500);
      await expect(retry).resolves.toMatchObject({
        type: 'success',
        sessionId: 'session-after-proven-not-found',
      });
      expect(spawnCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits fresh generated attempts independently on the same target', async () => {
    randomUUIDMock
      .mockReturnValueOnce('derived-attempt-spawn-1')
      .mockReturnValueOnce('derived-attempt-spawn-2')
      .mockReturnValueOnce('derived-attempt-spawn-3')
      .mockReturnValueOnce('derived-attempt-spawn-4');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', sessionId: 'generated-session-a' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'generated-session-b' });

    const { machineSpawnNewSession } = await import('./machines');
    const baseOptions = {
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
    } as const;

    const first = await machineSpawnNewSession(baseOptions);
    const second = await machineSpawnNewSession(baseOptions);

    expect(first).toMatchObject({
      type: 'success',
      sessionId: 'generated-session-a',
      spawnAttemptCustody: { status: 'completed' },
    });
    expect(second).toMatchObject({
      type: 'success',
      sessionId: 'generated-session-b',
      spawnAttemptCustody: { status: 'completed' },
    });
    expect(randomUUIDMock).toHaveBeenCalledTimes(4);
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls.map((call) => call.payload.spawnNonce)).toEqual([
      'ui-session-spawn-derived-attempt-spawn-2',
      'ui-session-spawn-derived-attempt-spawn-4',
    ]);
  });

  it('admits explicit attempts independently when environment variables differ', async () => {
    randomUUIDMock
      .mockReturnValueOnce('env-attempt-spawn-1')
      .mockReturnValueOnce('env-attempt-spawn-2');
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', sessionId: 'environment-session-a' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'environment-session-b' });

    const { machineSpawnNewSession } = await import('./machines');
    const baseOptions = {
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
    } as const;

    const first = await machineSpawnNewSession({
      ...baseOptions,
      environmentVariables: { FEATURE_FLAG: 'off' },
      spawnAttemptKey: 'voice.tool.spawn-session:options-a',
      userAttemptId: 'environment-attempt-a',
    } as any);
    const second = await machineSpawnNewSession({
      ...baseOptions,
      environmentVariables: { FEATURE_FLAG: 'on' },
      spawnAttemptKey: 'machine-detail.start-session:options-b',
      userAttemptId: 'environment-attempt-b',
    } as any);

    expect(first).toMatchObject({
      type: 'success',
      sessionId: 'environment-session-a',
      spawnAttemptCustody: { status: 'completed' },
    });
    expect(second).toMatchObject({
      type: 'success',
      sessionId: 'environment-session-b',
      spawnAttemptCustody: { status: 'completed' },
    });
    expect(randomUUIDMock).toHaveBeenCalledTimes(2);
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          environmentVariables: { FEATURE_FLAG: 'off' },
          spawnNonce: 'ui-session-spawn-env-attempt-spawn-1',
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          environmentVariables: { FEATURE_FLAG: 'on' },
          spawnNonce: 'ui-session-spawn-env-attempt-spawn-2',
        }),
      }),
    ]);
  });

  it('reuses the caller-seeded attempt nonce for retryable unresolved spawn timeouts', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Session startup timed out',
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    const baseOptions = {
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      initialPrompt: 'first prompt',
      userAttemptId: 'caller-seeded-attempt',
    } as const;

    await machineSpawnNewSession({
      ...baseOptions,
      spawnNonce: 'new-session-spawn-first',
    });
    await machineSpawnNewSession({
      ...baseOptions,
      spawnNonce: 'new-session-spawn-second',
    });

    expect(randomUUIDMock).not.toHaveBeenCalled();
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        spawnNonce: 'new-session-spawn-first',
      }),
    }));
  });

  it('retains durable custody after positive settlement until the consumer completes it', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-2' });
    const { completeMachineSpawnAttemptCustody, machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    } as const;

    const first = await machineSpawnNewSession({
      ...base,
      spawnNonce: 'launch-1',
      userAttemptId: 'attempt-1',
    });
    expect(first).toMatchObject({
      type: 'success',
      spawnAttemptCustody: {
        status: 'completed',
        spawnNonce: 'launch-1',
        userAttemptId: 'attempt-1',
        targetFingerprint: createSpawnAttemptKeyForFreshSpawnOptions(base, '/Users/alice'),
      },
    });
    if (first.spawnAttemptCustody?.status !== 'completed') {
      throw new Error('expected completed custody');
    }
    const second = await machineSpawnNewSession({
      ...base,
      spawnNonce: 'launch-2',
      userAttemptId: 'attempt-2',
    });
    expect(second).toMatchObject({
      type: 'success',
      sessionId: 'session-2',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'attempt-2',
        spawnNonce: 'launch-2',
        firstTurnLocalId: 'spawn-first-turn:launch-2',
        attachmentMessageLocalId: 'spawn-attachment:launch-2',
      },
    });
    if (second.spawnAttemptCustody?.status !== 'completed') {
      throw new Error('expected second completed custody');
    }
    expect(second.spawnAttemptCustody.firstTurnLocalId).not.toBe(first.spawnAttemptCustody.firstTurnLocalId);
    expect(second.spawnAttemptCustody.attachmentMessageLocalId).not.toBe(first.spawnAttemptCustody.attachmentMessageLocalId);
    await expect(completeMachineSpawnAttemptCustody(first.spawnAttemptCustody)).resolves.toBe(true);

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls.map((call) => call.payload.spawnNonce)).toEqual(['launch-1', 'launch-2']);
  });

  it('completes persisted custody by its exact created session without issuing another machine RPC', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });
    const {
      completePendingMachineSpawnAttemptCustodyForSession,
      machineSpawnNewSession,
    } = await import('./machines');

    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      spawnNonce: 'launch-1',
      userAttemptId: 'attempt-1',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-1',
      spawnAttemptCustody: { status: 'completed' },
    });

    await expect(completePendingMachineSpawnAttemptCustodyForSession({
      sessionId: 'session-1',
      serverId: 'server-b',
    })).resolves.toBe(true);
    await expect(completePendingMachineSpawnAttemptCustodyForSession({
      sessionId: 'session-1',
      serverId: 'server-b',
    })).resolves.toBeNull();

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toHaveLength(1);
  });

  it.each([
    ['/repo', '/repo/'],
    ['~/repo', '/Users/alice/repo'],
    ['~\\repo', '/Users/alice/repo/'],
  ])('keeps equivalent target spellings %s and %s under one custody record', async (firstDirectory, secondDirectory) => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', spawnNonce: 'nonce-a', sessionIdStatus: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'unsupported' });
    const { machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    } as const;

    await expect(machineSpawnNewSession({
      ...base,
      directory: firstDirectory,
      userAttemptId: 'attempt-a',
      spawnNonce: 'nonce-a',
    })).resolves.toMatchObject({ type: 'error', spawnAttemptCustody: { status: 'unresolved' } });
    await expect(machineSpawnNewSession({
      ...base,
      directory: secondDirectory,
      userAttemptId: 'attempt-a',
    })).resolves.toMatchObject({
      type: 'error',
      spawnAttemptCustody: {
        status: 'unresolved',
        userAttemptId: 'attempt-a',
        spawnNonce: 'nonce-a',
      },
    });

    expect(randomUUIDMock).not.toHaveBeenCalled();
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls).toHaveLength(1);
  });

  it('uses Windows path identity without merging a home sibling or distinct directory', async () => {
    storage.setState((state) => ({
      machines: { ...state.machines, 'machine-1': buildMachine({ id: 'machine-1', homeDir: 'C:\\Users\\Alice', platform: 'win32' }) },
    }));
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', spawnNonce: 'nonce-a', sessionIdStatus: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'unsupported' });
    const { machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    } as const;

    await machineSpawnNewSession({
      ...base,
      directory: '~\\Repo',
      userAttemptId: 'attempt-a',
      spawnNonce: 'nonce-a',
    });
    await expect(machineSpawnNewSession({
      ...base,
      directory: 'c:/users/alice/repo/',
      userAttemptId: 'attempt-a',
    })).resolves.toMatchObject({
      spawnAttemptCustody: { status: 'unresolved', userAttemptId: 'attempt-a', spawnNonce: 'nonce-a' },
    });

    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'sibling-session' });
    await expect(machineSpawnNewSession({ ...base, directory: 'C:\\Users\\Alice2\\Repo' })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sibling-session',
    });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'distinct-session' });
    await expect(machineSpawnNewSession({ ...base, directory: 'C:\\Users\\Alice\\Other' })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'distinct-session',
    });
  });

  it('uses the authoritative server-scoped machine home for custody identity', async () => {
    storage.setState((state) => ({
      machineListByServerId: {
        ...state.machineListByServerId,
        'server-c': [buildMachine({ id: 'machine-1', homeDir: '/srv/remote-user' })],
      },
    }));
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', spawnNonce: 'remote-nonce', sessionIdStatus: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'unsupported' });
    const { machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-c',
    } as const;

    await machineSpawnNewSession({
      ...base,
      directory: '~/repo',
      userAttemptId: 'remote-attempt',
      spawnNonce: 'remote-nonce',
    });
    await expect(machineSpawnNewSession({
      ...base,
      directory: '/srv/remote-user/repo/',
      userAttemptId: 'remote-attempt',
    })).resolves.toMatchObject({
      spawnAttemptCustody: {
        status: 'unresolved',
        userAttemptId: 'remote-attempt',
        spawnNonce: 'remote-nonce',
      },
    });
  });

  it('fails closed before custody when authoritative machine home is unavailable', async () => {
    storage.setState((state) => ({
      machines: { ...state.machines, 'machine-1': buildMachine({ id: 'machine-1', homeDir: null }) },
    }));
    const { machineSpawnNewSession } = await import('./machines');

    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    })).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(randomUUIDMock).not.toHaveBeenCalled();
  });

  it('admits a second user attempt without adopting the submitted launch identity', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-a' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-b' });
    const { machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
    } as const;

    await machineSpawnNewSession({ ...base, userAttemptId: 'attempt-a', spawnNonce: 'nonce-a' });
    const secondResult = await machineSpawnNewSession({
      ...base,
      userAttemptId: 'attempt-b',
      spawnNonce: 'nonce-b',
    });
    expect(secondResult).toMatchObject({
      type: 'success',
      sessionId: 'session-b',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'attempt-b',
        spawnNonce: 'nonce-b',
      },
    });

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call)
      .filter((call) => call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    expect(spawnCalls.map((call) => call.payload.spawnNonce)).toEqual(['nonce-a', 'nonce-b']);
  });

  it('passes the spawn nonce without forwarding retired direct provider input', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-b',
      initialPrompt: '  first prompt  ',
      spawnNonce: '  new-session-spawn-1  ',
    } as any);

    const spawnCall = machineRpcWithServerScopeMock.mock.calls.find(([call]) =>
      call?.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    )?.[0];
    expect(spawnCall?.payload).toEqual(expect.objectContaining({
      spawnNonce: 'new-session-spawn-1',
    }));
    expect(spawnCall?.payload).not.toHaveProperty('initialPrompt');
    expect(result).toEqual(expect.objectContaining({ type: 'success' }));
    expect(result).not.toHaveProperty('usedInitialPrompt');
  });

  it('does not send an initial prompt or spawn nonce to an unsupported daemon', async () => {
    storage.setState({
      ...initialStorageState,
      profileScope: { serverId: 'server-a', accountId: 'account-1' },
      machines: {
        ...initialStorageState.machines,
        'machine-1': buildMachine({ id: 'machine-1', cliVersion: '0.0.9' }),
      },
    }, true);
    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      serverId: 'server-a',
      initialPrompt: 'first prompt',
      spawnNonce: 'new-session-spawn-1',
    } as any);

    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage:
        'This machine is running an unsupported Happier CLI (detected 0.0.9). ' +
        'Update Happier CLI on the machine before starting a session.',
    });
  });

  it('does not spawn when account settings scope changes during preparation', async () => {
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockRejectedValueOnce(
      new Error('Account settings scope changed while preparing session spawn'),
    );

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe('ACCOUNT_SCOPE_CHANGED');
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('maps socket ack timeouts to SESSION_WEBHOOK_TIMEOUT', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(new Error('operation has timed out'))
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT);
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage.length).toBeGreaterThan(0);
  });

  it('reconciles a scoped machine RPC timeout through the submitted nonce without spawning twice', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(Object.assign(new Error('scoped spawn exceeded its RPC budget'), {
        code: 'MACHINE_RPC_TIMEOUT',
      }))
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-after-scoped-timeout',
      });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      spawnNonce: 'spawn-nonce-scoped-timeout',
    });

    expect(result).toMatchObject({
      type: 'success',
      sessionId: 'session-after-scoped-timeout',
      spawnAttemptCustody: {
        status: 'completed',
        spawnNonce: 'spawn-nonce-scoped-timeout',
        createdSessionId: 'session-after-scoped-timeout',
      },
    });
    expect(machineRpcWithServerScopeMock.mock.calls.map(([call]) => call.method)).toEqual([
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
    ]);
  });

  it('maps mid-spawn socket disconnects to SESSION_WEBHOOK_TIMEOUT so nonce recovery can run', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(new Error('socket has been disconnected'))
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT);
    expect(typeof result.errorMessage).toBe('string');
    expect(result.errorMessage.length).toBeGreaterThan(0);
  });

  it('resolves a timed-out spawn by nonce through the machine daemon', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      status: 'success',
      sessionId: ' session-from-nonce ',
    });

    const machines = await import('./machines');
    const resolveSpawnSessionByNonce = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonce;

    expect(typeof resolveSpawnSessionByNonce).toBe('function');
    if (typeof resolveSpawnSessionByNonce !== 'function') throw new Error('missing resolver');

    await expect(resolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: ' spawn-nonce-1 ',
      serverId: 'server-b',
    })).resolves.toEqual({
      status: 'success',
      sessionId: 'session-from-nonce',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.spawnSession.resolveByNonce',
      payload: { spawnNonce: 'spawn-nonce-1' },
      serverId: 'server-b',
    }));
  });

  it('treats missing spawn nonce resolver support as an old-daemon fallback', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const machines = await import('./machines');
    const resolveSpawnSessionByNonce = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonce;

    expect(typeof resolveSpawnSessionByNonce).toBe('function');
    if (typeof resolveSpawnSessionByNonce !== 'function') throw new Error('missing resolver');

    await expect(resolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-1',
      serverId: 'server-b',
    })).resolves.toEqual({ status: 'unsupported' });
  });

  it('falls back to the older spawn nonce RPC method alias when the renamed method is unavailable', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }))
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-from-old-alias',
      });

    const { machineResolveSpawnSessionByNonce } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-legacy-alias',
      serverId: 'server-b',
    });

    expect(result).toEqual({ status: 'success', sessionId: 'session-from-old-alias' });
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'daemon.spawnSession.resolveByNonce',
      payload: { spawnNonce: 'spawn-nonce-legacy-alias' },
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'daemon.spawnSession.resolve',
      payload: { spawnNonce: 'spawn-nonce-legacy-alias' },
    }));
  });

  it('classifies spawn nonce resolver transport failures separately from definite not_found', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('network unavailable'));

    const { machineResolveSpawnSessionByNonce } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-transport-error',
      serverId: 'server-b',
    });

    expect(result).toEqual({ status: 'transport_error' });
  });

  it('preserves transport ambiguity through settled nonce recovery', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('network unavailable'));

    const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
    await expect(machineResolveSpawnSessionByNonceUntilSettled({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-transport-error',
      serverId: 'server-b',
      timeoutMs: 0,
      pollIntervalMs: 1,
    })).resolves.toEqual({ status: 'transport_error' });
  });

  it('polls pending spawn nonce resolution until it settles successfully', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-pending' });

    const machines = await import('./machines');
    const resolveUntilSettled = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonceUntilSettled;

    expect(typeof resolveUntilSettled).toBe('function');
    if (typeof resolveUntilSettled !== 'function') return;

    await expect(resolveUntilSettled({
      machineId: 'machine-1',
      serverId: 'server-b',
      spawnNonce: 'spawn-nonce-pending',
      timeoutMs: 1_000,
      pollIntervalMs: 0,
    })).resolves.toEqual({ status: 'success', sessionId: 'session-after-pending' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging resolver probe by the remaining settlement deadline', async () => {
    vi.useFakeTimers();
    try {
      machineRpcWithServerScopeMock.mockImplementation((params: Readonly<{ timeoutMs?: number }>) => (
        new Promise((_resolve, reject) => {
          if (typeof params.timeoutMs === 'number') {
            setTimeout(() => reject(new Error('resolver transport timed out')), params.timeoutMs);
          }
        })
      ));

      const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
      const resultPromise = machineResolveSpawnSessionByNonceUntilSettled({
        machineId: 'machine-1',
        serverId: 'server-b',
        spawnNonce: 'spawn-nonce-hanging-resolver',
        timeoutMs: 10,
        pollIntervalMs: 1_000,
      });
      const finiteResult = Promise.race([
        resultPromise,
        new Promise<{ status: 'test_timeout' }>((resolve) => {
          setTimeout(() => resolve({ status: 'test_timeout' }), 100);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(100);

      await expect(finiteResult).resolves.toEqual({ status: 'transport_error' });
      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
      const probeTimeoutMs = machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.timeoutMs;
      expect(probeTimeoutMs).toBeGreaterThan(0);
      expect(probeTimeoutMs).toBeLessThanOrEqual(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits one second between spawn nonce probes by default', async () => {
    vi.useFakeTimers();
    try {
      machineRpcWithServerScopeMock
        .mockResolvedValueOnce({ status: 'pending' })
        .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-default-delay' });

      const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
      const resultPromise = machineResolveSpawnSessionByNonceUntilSettled({
        machineId: 'machine-1',
        serverId: 'server-b',
        spawnNonce: 'spawn-nonce-default-delay',
        timeoutMs: 5_000,
      });

      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({
        status: 'success',
        sessionId: 'session-after-default-delay',
      });
      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling a live pending spawn nonce past the short ambiguity window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));

    try {
      const startMs = Date.now();
      machineRpcWithServerScopeMock.mockImplementation(async () => {
        if (Date.now() - startMs >= 3_200) {
          return { status: 'success', sessionId: 'session-after-slow-spawn' };
        }
        return { status: 'pending' };
      });

      const machines = await import('./machines');
      const resolveUntilSettled = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonceUntilSettled;

      expect(typeof resolveUntilSettled).toBe('function');
      if (typeof resolveUntilSettled !== 'function') return;

      const resolution = resolveUntilSettled({
        machineId: 'machine-1',
        serverId: 'server-b',
        spawnNonce: 'spawn-nonce-slow-pending',
      });

      // Polls observe at 0/1000/2000/3000ms, so advance through the next poll that
      // can observe the mocked >=3200ms success.
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(resolution).resolves.toEqual({
        status: 'success',
        sessionId: 'session-after-slow-spawn',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns pending when spawn nonce polling expires before settlement', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({ status: 'pending' });

    const machines = await import('./machines');
    const resolveUntilSettled = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonceUntilSettled;

    expect(typeof resolveUntilSettled).toBe('function');
    if (typeof resolveUntilSettled !== 'function') return;

    await expect(resolveUntilSettled({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-still-pending',
      timeoutMs: 0,
      pollIntervalMs: 0,
    })).resolves.toEqual({ status: 'pending' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
  });

  it('maps legacy daemon error envelopes into a structured spawn error result', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      success: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      error: 'Claude CLI override is invalid',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Claude CLI override is invalid',
    });
  });

  it('remaps the legacy directory-required daemon error into the new compatibility message', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'directory is required',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('error');
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST);
    expect(result.errorMessage).toContain('selected machine rejected the session directory');
    expect(result.errorMessage).toContain('incompatible daemon');
  });

  it('fails closed before RPC when an older daemon sees a configured ACP backend target', async () => {
    storage.getState().applyMachines([buildMachine({
      id: 'machine-legacy',
      cliVersion: '0.0.9',
    })]);

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage:
        'This machine is running an unsupported Happier CLI (detected 0.0.9). ' +
        'Update Happier CLI on the machine before starting a session.',
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('fails closed before RPC for an unsupported pre-backend-target daemon', async () => {
    storage.getState().applyMachines([buildMachine({
      id: 'machine-legacy',
      cliVersion: '0.0.9',
    })]);

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage:
        'This machine is running an unsupported Happier CLI (detected 0.0.9). ' +
        'Update Happier CLI on the machine before starting a session.',
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });
});
