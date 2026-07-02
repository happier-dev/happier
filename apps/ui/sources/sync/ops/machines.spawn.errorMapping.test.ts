import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnIfNeededMock = vi.hoisted(() => vi.fn(async () => ({})));

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

vi.mock('./accountSettingsDaemonSpawnPreparation', async (importOriginal) => ({
  ...await importOriginal<typeof import('./accountSettingsDaemonSpawnPreparation')>(),
  prepareAccountSettingsForDaemonSpawnIfNeeded: prepareAccountSettingsForDaemonSpawnIfNeededMock,
  registerAccountSettingsDaemonSpawnPreparation: vi.fn(() => vi.fn()),
}));

describe('machineSpawnNewSession error mapping', () => {
  const initialStorageState = storage.getInitialState();

  function buildMachine(params: Readonly<{ id: string; startedWithCliVersion?: string | null }>): Machine {
    return {
      id: params.id,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
      active: true,
      activeAt: 1,
      revokedAt: null,
      metadata: null,
      metadataVersion: 0,
      daemonState: params.startedWithCliVersion
        ? ({ startedWithCliVersion: params.startedWithCliVersion } as any)
        : null,
      daemonStateVersion: params.startedWithCliVersion ? 1 : 0,
    };
  }

  beforeEach(() => {
    storage.setState(initialStorageState, true);
    machineRpcWithServerScopeMock.mockReset();
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockReset();
    prepareAccountSettingsForDaemonSpawnIfNeededMock.mockResolvedValue({});
  });

  it('returns a descriptive error when daemon RPC method is not available', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
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
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE);
    expect(result.errorMessage.toLowerCase()).toContain('daemon');
    expect(result.errorMessage.toLowerCase()).toContain('rpc');
  });

  it('uses an extended RPC timeout for spawn session calls', async () => {
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
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('operation has timed out'));

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
      startedWithCliVersion: '0.0.9',
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
        'The selected backend target requires a compatible 0.1.0-dev build or Happier CLI v0.2.0 ' +
        'or newer on this machine (detected 0.0.9).',
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('converts V2 built-in backend targets for older daemon compatibility', async () => {
    storage.getState().applyMachines([buildMachine({
      id: 'machine-legacy',
      startedWithCliVersion: '0.0.9',
    })]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-legacy-built-in' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      serverId: 'server-b',
    });

    expect(result).toEqual({ type: 'success', sessionId: 'session-legacy-built-in' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        agent: 'codex',
      }),
    }));
  });
});
