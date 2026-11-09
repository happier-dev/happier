import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { AccountEncryptionModeResponseSchema} from '@happier-dev/protocol/account/encryptionMode';
import { AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The app entry owns Sync installation. Keep its cold import outside timed
// per-case setup, as the canonical Session operations boundary keeper does.
const initialNetwork = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const baseline = storage.getState();
await initialNetwork.dispose();

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
describe('machine spawn nonce recovery and custody completion', () => {
  let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
  const homeUrl = 'https://server-b';
  beforeEach(async () => {
    // Disposal retires the external Socket factory as well as HTTP and
    // credentials. Install a fresh boundary for every case; the cached SDK
    // import dispatches through its current factory without reloading Sync.
    network = await installSessionOpsNetworkBoundary();
    network.resetRequests();
    const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
    getPersistenceStorage().clearAll();
    storage.setState(baseline, true);
    machineRpcWithServerScopeMock.mockReset();
    const home = await network.addHome(homeUrl, 'account-a');
    const homeA = await network.addHome('https://server-a', 'account-a');
    const homeC = await network.addHome('https://server-c', 'account-a');
    const homeIds = new Map([home, homeA, homeC].map((profile) => [profile.serverUrl, profile.id]));
    expect(home.id).toBe('server-b');
    network.setHttpResponder(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption') return Response.json(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 0 }));
      if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 0 }));
      return null;
    });
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await upsertAndActivateServer({ serverUrl: home.serverUrl });
    await restoreConnectionToActiveServer({ token: home.token });
    const { sync } = await import('@/sync/sync');
    // Keep the content-mode and access fields published by real hydration.
    await sync.refreshMachines();
    storage.setState({ settingsVersion: 0 });
    network.setRpcAckResponder(async (request) => {
      try {
        return { ok: true, result: await machineRpcWithServerScopeMock({
          machineId: request.targetId,
          serverId: homeIds.get(request.serverUrl),
          method: request.method,
          payload: request.payload,
          timeoutMs: request.timeoutMs,
        }) };
      } catch (error) {
        const errorCode = readRpcErrorCode(error);
        if (errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND || errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
          return { ok: false, error: 'Daemon method unavailable', errorCode };
        }
        throw error; // Socket ACK timeout/disconnect is a physical transport rejection.
      }
    });
  });

  afterEach(async () => {
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
    await serverScopedRpcSocketPool.stopAll();
    resetScopedMachineTransportCacheForTests();
    await network.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('completes persisted custody by its exact created session without issuing another machine RPC', async () => {
    const { acquireSpawnAttemptCustody, markSpawnAttemptCreated } = await import('../domains/session/spawn/spawnAttemptNonceStore');
    const { completePendingMachineSpawnAttemptCustodyForSession } = await import('./machines');
    const scope = { serverId: 'server-b', accountId: 'account-a' };
    const attempt = { scope, machineId: 'machine-1', targetFingerprint: 'created-session-custody', userAttemptId: 'attempt-1' };
    const acquired = await acquireSpawnAttemptCustody({ ...attempt, seedNonce: 'launch-1' });
    expect(acquired.status).toBe('acquired');
    await markSpawnAttemptCreated({ ...attempt, nonce: 'launch-1', createdSessionId: 'session-1' });
    await expect(completePendingMachineSpawnAttemptCustodyForSession({ sessionId: 'unrelated-session', serverId: 'server-b' }))
      .resolves.toBeNull();
    await expect(completePendingMachineSpawnAttemptCustodyForSession({ sessionId: 'session-1', serverId: 'server-b' }))
      .resolves.toBe(true);
    await expect(completePendingMachineSpawnAttemptCustodyForSession({ sessionId: 'session-1', serverId: 'server-b' }))
      .resolves.toBeNull();
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
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
    machineRpcWithServerScopeMock.mockRejectedValue(
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
    machineRpcWithServerScopeMock.mockImplementation(async ({ method }) => {
      if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) throw Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      return { status: 'success', sessionId: 'session-from-old-alias' };
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
    expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expect.objectContaining({
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

      await vi.advanceTimersByTimeAsync(0);
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
    vi.useFakeTimers();
    try {
      machineRpcWithServerScopeMock.mockResolvedValue({ status: 'pending' });

      const machines = await import('./machines');
      const resolveUntilSettled = (machines as Record<string, unknown>).machineResolveSpawnSessionByNonceUntilSettled;

      expect(typeof resolveUntilSettled).toBe('function');
      if (typeof resolveUntilSettled !== 'function') return;

      // The zero-duration contract still admits its first probe. Keep the
      // clock fixed while the genuine boundary returns its immediate ACK,
      // rather than spending the one-millisecond probe floor on setup.
      const resolution = resolveUntilSettled({
        machineId: 'machine-1',
        spawnNonce: 'spawn-nonce-still-pending',
        timeoutMs: 0,
        pollIntervalMs: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(resolution).resolves.toEqual({ status: 'pending' });
      expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

});
