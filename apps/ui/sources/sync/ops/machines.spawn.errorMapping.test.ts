import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { storage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import { serverAccountScopedStorageKey } from '@/sync/domains/scope/serverAccountScope';
import { createSpawnAttemptKeyForFreshSpawnOptions } from '@/sync/domains/session/spawn/spawnAttemptKey';
import {
  setActiveServerId,
  setServerProfileIdentityForUrl,
  upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const prepareAccountSettingsForDaemonSpawnMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

vi.mock('./accountSettingsDaemonSpawnPreparation', async (importOriginal) => ({
  ...await importOriginal<typeof import('./accountSettingsDaemonSpawnPreparation')>(),
  prepareAccountSettingsForDaemonSpawnIfNeeded: prepareAccountSettingsForDaemonSpawnMock,
  registerAccountSettingsDaemonSpawnPreparation: vi.fn(() => vi.fn()),
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

describe('machineSpawnNewSession error mapping', () => {
  const initialStorageState = storage.getState();
  const spawnCustodyStorageKey = serverAccountScopedStorageKey('session-spawn-attempts-v1', {
    serverId: 'server-b',
    accountId: 'account-a',
  });

  beforeEach(() => {
    const spawnTestServerUrl = 'https://spawn-test.example.test';
    upsertServerProfile({ serverUrl: spawnTestServerUrl, name: 'Spawn test server' });
    setServerProfileIdentityForUrl(spawnTestServerUrl, 'server-b');
    setActiveServerId('server-b', { scope: 'tab' });
    machineRpcWithServerScopeMock.mockReset();
    prepareAccountSettingsForDaemonSpawnMock.mockReset();
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValue({});
    storage.setState({
      ...initialStorageState,
      profileScope: { serverId: 'server-b', accountId: 'account-a' },
      machines: {
        'machine-1': {
          id: 'machine-1',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          metadata: {
            host: 'test-machine',
            platform: 'darwin',
            happyCliVersion: '0.2.0',
            happyHomeDir: '/Users/alice/.happier',
            homeDir: '/Users/alice',
          },
          metadataVersion: 1,
          daemonState: null,
          daemonStateVersion: 1,
        },
      },
    }, true);
    getPersistenceStorage().clearAll();
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

  it('prefers provider-safe spawn and falls back to legacy only after definitive method absence', async () => {
    machineRpcWithServerScopeMock
      .mockRejectedValueOnce(Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }))
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-from-released-daemon' });

    const { machineSpawnNewSession } = await import('./machines');
    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-from-released-daemon',
    });

    expect(machineRpcWithServerScopeMock.mock.calls.map(([call]) => call.method)).toEqual([
      RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      RPC_METHODS.SPAWN_HAPPY_SESSION,
    ]);
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload.spawnNonce)
      .toBe(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload.spawnNonce);
  });

  it('does not fall back to legacy spawn after an ambiguous transport timeout', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('RPC acknowledgement timed out'));

    const { machineSpawnNewSession } = await import('./machines');
    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    const spawnMethods = machineRpcWithServerScopeMock.mock.calls
      .map(([call]) => call.method)
      .filter((method) => method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
        || method === RPC_METHODS.SPAWN_HAPPY_SESSION);
    expect(spawnMethods).toEqual([RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE]);
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
    expect(call).toMatchObject({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      timeoutMs: expect.any(Number),
    });
    expect(call.timeoutMs).toBe(readSpawnSessionRpcTimeoutMsFromEnv());
    expect(call.timeoutMs).toBe(5 * 60_000);
  });

  it('prepares account settings and includes the returned version hint before spawning', async () => {
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValueOnce({ accountSettingsVersionHint: 22 });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result.type).toBe('success');
    expect(prepareAccountSettingsForDaemonSpawnMock).toHaveBeenCalledTimes(1);
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        accountSettingsVersionHint: 22,
      }),
    }));
  });

  it('does not spawn when account settings scope changes during preparation', async () => {
    prepareAccountSettingsForDaemonSpawnMock.mockRejectedValueOnce(
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

  it('does not override an explicit account settings version hint', async () => {
    prepareAccountSettingsForDaemonSpawnMock.mockResolvedValueOnce({ accountSettingsVersionHint: 22 });
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
    });

    expect(prepareAccountSettingsForDaemonSpawnMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        accountSettingsVersionHint: 12,
      }),
    }));
  });

  it('forwards an optional spawn nonce in the daemon spawn payload', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-1' });

    const { machineSpawnNewSession } = await import('./machines');
    await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
      spawnNonce: 'spawn-nonce-ui-1',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        spawnNonce: 'spawn-nonce-ui-1',
      }),
    }));
  });

  it('settles a pending ACK at the operation boundary and exposes its durable nonce while unresolved', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      type: 'success',
      spawnNonce: 'spawn-nonce-ui-pending',
      sessionIdStatus: 'pending',
    }).mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
      spawnNonce: 'spawn-nonce-ui-pending',
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: expect.any(String),
      spawnNonce: 'spawn-nonce-ui-pending',
    });
  });

  it('resolves a pending spawn ACK through the shared settled-spawn helper', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'spawn-nonce-generated-by-helper',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-from-helper-resolve',
      });

    const { machineSpawnNewSessionUntilResolved } = await import('./machines');
    const result = await machineSpawnNewSessionUntilResolved({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
    });

    expect(result).toMatchObject({
      type: 'success',
      sessionId: 'session-from-helper-resolve',
    });
    const spawnCall = machineRpcWithServerScopeMock.mock.calls[0]?.[0];
    const resolveCall = machineRpcWithServerScopeMock.mock.calls[1]?.[0];
    expect(spawnCall?.payload?.spawnNonce).toEqual(expect.stringMatching(/^ui-session-spawn-/));
    expect(resolveCall?.payload).toEqual({ spawnNonce: spawnCall?.payload?.spawnNonce });
  });

  it('keeps settling the accepted nonce across a transient resolver transport failure', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'spawn-nonce-transient-resolver',
        sessionIdStatus: 'pending',
      })
      .mockRejectedValueOnce(new Error('resolver transport interrupted'))
      .mockResolvedValueOnce({
        status: 'success',
        sessionId: 'session-after-transient-resolver',
      });

    const { machineSpawnNewSessionUntilResolved } = await import('./machines');
    const result = await machineSpawnNewSessionUntilResolved({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
      spawnNonce: 'spawn-nonce-transient-resolver',
    });

    expect(result).toMatchObject({
      type: 'success',
      sessionId: 'session-after-transient-resolver',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(3);
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload?.spawnNonce)
      .toBe('spawn-nonce-transient-resolver');
    expect(machineRpcWithServerScopeMock.mock.calls[1]?.[0]?.payload)
      .toEqual({ spawnNonce: 'spawn-nonce-transient-resolver' });
    expect(machineRpcWithServerScopeMock.mock.calls[2]?.[0]?.payload)
      .toEqual({ spawnNonce: 'spawn-nonce-transient-resolver' });
  });

  it('rehydrates an unresolved semantic attempt and resolves it without a second spawn', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'persisted-launch-nonce',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-persisted-launch' });

    const { machineSpawnNewSessionUntilResolved } = await import('./machines');
    const options = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      spawnNonce: 'persisted-launch-nonce',
      userAttemptId: 'attempt-a',
    } as const;

    await expect(machineSpawnNewSessionUntilResolved(options)).resolves.toMatchObject({
      type: 'error',
      spawnNonce: 'persisted-launch-nonce',
    });
    await expect(machineSpawnNewSessionUntilResolved(options)).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-from-persisted-launch',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'attempt-a',
        spawnNonce: 'persisted-launch-nonce',
      },
    });

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]?.payload?.spawnNonce).toBe('persisted-launch-nonce');
  });

  it('resubmits the same semantic attempt when the current daemon proves a persisted nonce is absent', async () => {
    vi.useFakeTimers();
    let spawnCallCount = 0;
    let resolveCallCount = 0;
    machineRpcWithServerScopeMock.mockImplementation(async ({ method }: { method: string }) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        spawnCallCount += 1;
        return spawnCallCount === 1
          ? {
            type: 'success',
            spawnNonce: 'persisted-launch-after-daemon-restart',
            sessionIdStatus: 'pending',
          }
          : { type: 'success', sessionId: 'session-after-daemon-restart' };
      }
      resolveCallCount += 1;
      return resolveCallCount === 1 ? { status: 'unsupported' } : { status: 'not_found' };
    });

    const { machineSpawnNewSessionUntilResolved } = await import('./machines');
    const options = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      spawnNonce: 'persisted-launch-after-daemon-restart',
      userAttemptId: 'attempt-after-daemon-restart',
    } as const;

    try {
      await expect(machineSpawnNewSessionUntilResolved(options)).resolves.toMatchObject({
        type: 'error',
        spawnNonce: 'persisted-launch-after-daemon-restart',
      });
      const retryPromise = machineSpawnNewSessionUntilResolved(options);
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(retryPromise).resolves.toMatchObject({
        type: 'success',
        sessionId: 'session-after-daemon-restart',
        spawnAttemptCustody: {
          status: 'completed',
          userAttemptId: 'attempt-after-daemon-restart',
          spawnNonce: 'persisted-launch-after-daemon-restart',
        },
      });

      const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
        ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      );
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls.map(([call]) => call.payload.spawnNonce)).toEqual([
        'persisted-launch-after-daemon-restart',
        'persisted-launch-after-daemon-restart',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails corrupt custody closed without creating a nonce or calling the daemon', async () => {
    getPersistenceStorage().set(spawnCustodyStorageKey, '{invalid-json');
    const { machineSpawnNewSession } = await import('./machines');

    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      userAttemptId: 'attempt-a',
      spawnNonce: 'must-not-be-used',
    })).resolves.toMatchObject({
      type: 'error',
      spawnAttemptCustody: { status: 'corrupt' },
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(getPersistenceStorage().getString(spawnCustodyStorageKey)).toBe('{invalid-json');
  });

  it('admits a stored same-target attempt with a different user identity independently', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'nonce-a',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-b' });
    const { machineSpawnNewSession } = await import('./machines');
    const base = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    } as const;

    await expect(machineSpawnNewSession({
      ...base,
      userAttemptId: 'attempt-a',
      spawnNonce: 'nonce-a',
    })).resolves.toMatchObject({ type: 'error', spawnNonce: 'nonce-a' });

    await expect(machineSpawnNewSession({
      ...base,
      userAttemptId: 'attempt-b',
      spawnNonce: 'nonce-b',
      permissionMode: 'yolo',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-b',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'attempt-b',
        spawnNonce: 'nonce-b',
      },
    });
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls.map(([call]) => call.payload.spawnNonce)).toEqual(['nonce-a', 'nonce-b']);
  });

  it.each([
    ['/repo', '/repo/'],
    ['~/repo', '/Users/alice/repo'],
    ['~\\repo', '/Users/alice/repo/'],
  ])('keeps equivalent target spellings %s and %s under one custody record', async (firstDirectory, secondDirectory) => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'nonce-a',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-attempt-a' });
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
    })).resolves.toMatchObject({ type: 'error', spawnNonce: 'nonce-a' });

    await expect(machineSpawnNewSession({
      ...base,
      directory: secondDirectory,
      userAttemptId: 'attempt-a',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'session-from-attempt-a',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'attempt-a',
        spawnNonce: 'nonce-a',
      },
    });

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls).toHaveLength(1);
    expect(getPersistenceStorage().getString(spawnCustodyStorageKey)).toContain('"phase":"post_spawn"');
  });

  it('uses the authoritative server-scoped machine home for custody identity', async () => {
    const remoteMachine = {
      ...storage.getState().machines['machine-1']!,
      metadata: {
        ...storage.getState().machines['machine-1']!.metadata!,
        host: 'remote-machine',
        homeDir: '/srv/remote-user',
      },
    };
    storage.setState((state) => ({
      machineListByServerId: {
        ...state.machineListByServerId,
        'server-c': [remoteMachine],
      },
    }));
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', spawnNonce: 'remote-nonce', sessionIdStatus: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-remote-attempt' });
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
      type: 'success',
      sessionId: 'session-from-remote-attempt',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: 'remote-attempt',
        spawnNonce: 'remote-nonce',
      },
    });
  });

  it('fails closed before custody when authoritative machine home is unavailable', async () => {
    storage.setState((state) => ({ machines: { ...state.machines, 'machine-1': { ...state.machines['machine-1']!, metadata: null } } }));
    const { machineSpawnNewSession } = await import('./machines');

    await expect(machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
    expect(getPersistenceStorage().getString(spawnCustodyStorageKey)).toBeUndefined();
  });

  it('keeps Windows mixed-separator/case spellings under one custody record while distinct directories remain independent', async () => {
    storage.setState((state) => ({
      machines: {
        ...state.machines,
        'machine-1': {
          ...state.machines['machine-1'],
          metadata: {
            ...state.machines['machine-1']!.metadata!,
            platform: 'win32',
            homeDir: 'C:\\Users\\Alice',
          },
        },
      },
    }));
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ type: 'success', spawnNonce: 'nonce-a', sessionIdStatus: 'pending' })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-from-attempt-a' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'session-distinct' });
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
      type: 'success',
      sessionId: 'session-from-attempt-a',
      spawnAttemptCustody: { status: 'completed', userAttemptId: 'attempt-a', spawnNonce: 'nonce-a' },
    });

    await expect(machineSpawnNewSession({
      ...base,
      directory: 'C:\\Users\\Alice2\\Repo',
    })).resolves.toMatchObject({ type: 'success', sessionId: 'session-distinct' });
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls).toHaveLength(2);
  });

  it('keeps concurrent distinct user attempts independent on the same target', async () => {
    const originalNavigator = globalThis.navigator;
    let tail = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        ...originalNavigator,
        locks: {
          request: async <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
            const prior = tail;
            let release!: () => void;
            tail = new Promise<void>((resolve) => { release = resolve; });
            await prior;
            try {
              return await callback();
            } finally {
              release();
            }
          },
        },
      },
    });
    machineRpcWithServerScopeMock.mockImplementation(async ({ method, payload }: { method: string; payload: { spawnNonce?: string } }) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        return {
          type: 'success',
          sessionId: payload.spawnNonce === 'second-nonce' ? 'session-from-attempt-b' : 'session-from-attempt-a',
        };
      }
      return { status: 'not_found' };
    });

    try {
      const { machineSpawnNewSession } = await import('./machines');
      const options = {
        machineId: 'machine-1',
        directory: '/repo',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        serverId: 'server-b',
        userAttemptId: 'attempt-a',
        spawnNonce: 'shared-nonce',
      } as const;
      const first = machineSpawnNewSession(options);
      const second = machineSpawnNewSession({ ...options, userAttemptId: 'attempt-b', spawnNonce: 'second-nonce' });
      const results = await Promise.all([first, second]);

      const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
        ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
      );
      expect(spawnCalls.map(([call]) => call.payload.spawnNonce)).toEqual(['shared-nonce', 'second-nonce']);
      expect(results).toEqual([
        expect.objectContaining({
          type: 'success',
          sessionId: 'session-from-attempt-a',
          spawnAttemptCustody: expect.objectContaining({
            status: 'completed',
            userAttemptId: 'attempt-a',
            spawnNonce: 'shared-nonce',
          }),
        }),
        expect.objectContaining({
          type: 'success',
          sessionId: 'session-from-attempt-b',
          spawnAttemptCustody: expect.objectContaining({
            status: 'completed',
            userAttemptId: 'attempt-b',
            spawnNonce: 'second-nonce',
          }),
        }),
      ]);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }
  });

  it('retains durable custody after spawn and releases it only after follow-up completion', async () => {
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
    if (first.type !== 'success' || first.spawnAttemptCustody?.status !== 'completed') {
      throw new Error('expected completed spawn custody');
    }
    await expect(machineSpawnNewSession({
      ...base,
      spawnNonce: 'must-not-submit',
      userAttemptId: 'attempt-1',
    })).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
    await completeMachineSpawnAttemptCustody({
      machineId: base.machineId,
      serverId: base.serverId,
      custody: first.spawnAttemptCustody,
    });
    await machineSpawnNewSession({ ...base, spawnNonce: 'launch-2', userAttemptId: 'attempt-2' });

    expect(first).toMatchObject({
      type: 'success',
      spawnAttemptCustody: {
        status: 'completed',
        spawnNonce: 'launch-1',
        userAttemptId: 'attempt-1',
        targetFingerprint: createSpawnAttemptKeyForFreshSpawnOptions(base, '/Users/alice'),
      },
    });

    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls.map(([call]) => call.payload.spawnNonce)).toEqual(['launch-1', 'launch-2']);
  });

  it('keeps one machine-detail attempt through ambiguous settlement and clears it only after success', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'machine-detail-nonce',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'machine-detail-session' })
      .mockResolvedValueOnce({ type: 'success', sessionId: 'later-session' });

    const {
      createMachineDetailSpawnAttempt,
      runMachineDetailSpawnAttempt,
    } = await import('@/components/machines/machineDetailSpawnAttempt');
    const options = {
      machineId: 'machine-1',
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
    } as const;
    const attempt = createMachineDetailSpawnAttempt();

    await expect(runMachineDetailSpawnAttempt({ options, attempt })).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      spawnAttemptCustody: {
        status: 'unresolved',
        userAttemptId: attempt.userAttemptId,
        firstTurnLocalId: attempt.firstTurnLocalId,
        attachmentMessageLocalId: attempt.attachmentMessageLocalId,
      },
    });
    await expect(runMachineDetailSpawnAttempt({ options, attempt })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'machine-detail-session',
      spawnAttemptCustody: {
        status: 'completed',
        userAttemptId: attempt.userAttemptId,
      },
    });

    const laterAttempt = createMachineDetailSpawnAttempt();
    await expect(runMachineDetailSpawnAttempt({ options, attempt: laterAttempt })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'later-session',
    });
    const spawnCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      ([call]) => call.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    );
    expect(spawnCalls.map(([call]) => call.payload.spawnNonce)).toHaveLength(2);
  });

  it('exposes the accepted nonce when settlement remains unresolved', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({
        type: 'success',
        spawnNonce: 'spawn-nonce-unresolved',
        sessionIdStatus: 'pending',
      })
      .mockResolvedValueOnce({ status: 'unsupported' });

    const { machineSpawnNewSessionUntilResolved } = await import('./machines');
    await expect(machineSpawnNewSessionUntilResolved({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
      accountSettingsVersionHint: 12,
      spawnNonce: 'spawn-nonce-unresolved',
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      spawnNonce: 'spawn-nonce-unresolved',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
  });

  it('resolves a spawn nonce through machine RPC when supported', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      status: 'success',
      sessionId: 'session-from-nonce',
    });

    const { machineResolveSpawnSessionByNonce } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonce({
      machineId: 'machine-1',
      serverId: 'server-b',
      spawnNonce: 'spawn-nonce-ui-2',
    });

    expect(result).toEqual({ status: 'success', sessionId: 'session-from-nonce' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server-b',
      payload: { spawnNonce: 'spawn-nonce-ui-2' },
    }));
  });

  it('classifies unavailable spawn nonce resolution as unsupported', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { machineResolveSpawnSessionByNonce } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-ui-3',
    });

    expect(result).toEqual({ status: 'unsupported' });
  });

  it('classifies spawn nonce resolver transport failures separately from definite not_found', async () => {
    machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('network unavailable'));

    const { machineResolveSpawnSessionByNonce } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonce({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-ui-transport-error',
    });

    expect(result).toEqual({ status: 'transport_error' });
  });

  it('polls pending spawn nonce resolution until it settles successfully', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-pending' });

    const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonceUntilSettled({
      machineId: 'machine-1',
      serverId: 'server-b',
      spawnNonce: 'spawn-nonce-ui-pending',
      timeoutMs: 1_000,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ status: 'success', sessionId: 'session-after-pending' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(2);
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
        spawnNonce: 'spawn-nonce-ui-default-delay',
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

  it('uses the spawn RPC budget when a healthy child registers after the old three-second recovery window', async () => {
    machineRpcWithServerScopeMock
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'success', sessionId: 'session-after-slow-registration' });
    let nowMs = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });

    try {
      const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
      const result = await machineResolveSpawnSessionByNonceUntilSettled({
        machineId: 'machine-1',
        serverId: 'server-b',
        spawnNonce: 'spawn-nonce-ui-slow-registration',
        pollIntervalMs: 0,
      });

      expect(result).toEqual({ status: 'success', sessionId: 'session-after-slow-registration' });
      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(5);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns the explicit pending state when spawn nonce polling expires', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({ status: 'pending' });

    const { machineResolveSpawnSessionByNonceUntilSettled } = await import('./machines');
    const result = await machineResolveSpawnSessionByNonceUntilSettled({
      machineId: 'machine-1',
      spawnNonce: 'spawn-nonce-ui-still-pending',
      timeoutMs: 0,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({ status: 'pending' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
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

  it('reconciles a server-scoped machine RPC timeout through the accepted nonce without spawning twice', async () => {
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
      RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
    ]);
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

  it('maps legacy daemon success envelopes into a structured spawn success result', async () => {
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      success: true,
      sessionId: 'session-legacy',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-legacy' });
  });

  it('builds a legacy spawn payload for older daemon versions', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
          host: 'legacy-machine', platform: 'darwin', happyCliVersion: '0.0.99',
          happyHomeDir: '/Users/alice/.happier', homeDir: '/Users/alice',
        },
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.0.99',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-legacy' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-legacy' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'spawn-in-directory',
        directory: '/tmp',
        agent: 'codex',
        experimentalCodexAcp: true,
      }),
    }));
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload).not.toHaveProperty('backendTarget');
  });

  it('keeps the modern spawn payload for compatible 0.1.0 dev daemon versions', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-dev',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
          host: 'dev-machine', platform: 'darwin', happyCliVersion: '0.1.0-dev',
          happyHomeDir: '/Users/alice/.happier', homeDir: '/Users/alice',
        },
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.1.0-dev.1775063171.91734',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({ type: 'success', sessionId: 'session-dev' });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-dev',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
      serverId: 'server-b',
    });

    expect(result).toMatchObject({ type: 'success', sessionId: 'session-dev' });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        type: 'spawn-in-directory',
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      }),
    }));
    expect(machineRpcWithServerScopeMock.mock.calls[0]?.[0]?.payload).not.toHaveProperty('agent');
  });

  it('fails early when an older daemon cannot represent the selected configured backend target', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
          host: 'legacy-machine', platform: 'darwin', happyCliVersion: '0.0.99',
          happyHomeDir: '/Users/alice/.happier', homeDir: '/Users/alice',
        },
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.0.99',
        },
        daemonStateVersion: 1,
      },
    ]);

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
      errorMessage: expect.stringContaining('0.2.0'),
    });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('maps misleading legacy daemon directory errors into a compatibility hint when the app sent a directory', async () => {
    storage.getState().applyMachines([
      {
        id: 'machine-legacy',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
          host: 'legacy-machine', platform: 'darwin', happyCliVersion: '0.0.99',
          happyHomeDir: '/Users/alice/.happier', homeDir: '/Users/alice',
        },
        metadataVersion: 0,
        daemonState: {
          startedWithCliVersion: '0.0.99',
        },
        daemonStateVersion: 1,
      },
    ]);
    machineRpcWithServerScopeMock.mockResolvedValueOnce({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Directory is required',
    });

    const { machineSpawnNewSession } = await import('./machines');
    const result = await machineSpawnNewSession({
      machineId: 'machine-legacy',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      serverId: 'server-b',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: expect.stringContaining('incompatible'),
    });
    if (result.type !== 'error') throw new Error('expected an error result');
    expect(result.errorMessage).toContain('re-authorize');
  });
});
