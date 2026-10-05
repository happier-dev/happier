import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();

const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const runtimeFetchWithServerReachabilitySpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: (...args: unknown[]) => runtimeFetchWithServerReachabilitySpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

// Load one real graph after the transport boundaries, outside RPC budgets.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { Encryption } = await import('@/sync/encryption/encryption');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
// Observe forbidden active-path admission without replacing its real codec.
const machineRpcSpy = vi.spyOn(apiSocket, 'machineRPC');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const getCredentialsSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
let home: Awaited<ReturnType<typeof upsertAndActivateServer>>;
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');
const encryption = await Encryption.create(new Uint8Array(32).fill(1));
await encryption.initializeMachines(new Map([['machine-1', null]]));
const machineEncryption = encryption.getMachineEncryption('machine-1');
if (!machineEncryption) throw new Error('Expected initialized legacy Machine encryption');
const credentials = {
  token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`,
  secret: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
};
afterAll(() => {
  machineRpcSpy.mockRestore();
  getCredentialsSpy.mockRestore();
});

describe('machineRpcWithServerScope (retry)', () => {
  beforeEach(async () => {
    // The package setup clears the native storage boundary before every case.
    home = await upsertAndActivateServer({ serverUrl: 'https://server-a.example.test' });
    machineRpcSpy.mockClear();
    createEphemeralSocketSpy.mockReset();
    getCredentialsSpy.mockReset();
    getCredentialsSpy.mockResolvedValue(credentials);
    runtimeFetchWithServerReachabilitySpy.mockReset();
    runtimeFetchWithServerReachabilitySpy.mockImplementation(async () => Response.json({
      machine: { id: 'machine-1', dataEncryptionKey: null },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetScopedMachineTransportCacheForTests();
  });

  it('retries once when the scoped rpc method is not available', async () => {
    const emitWithAckSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'RPC method not available',
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: await machineEncryption.encryptRaw({ ok: true }),
      });

    const fakeSocket = {
      timeout: vi.fn(() => ({
        emitWithAck: emitWithAckSpy,
      })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValue(fakeSocket);

    const rpcPromise = machineRpcWithServerScope({
      serverId: home.id,
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 1 },
      preferScoped: true,
      timeoutMs: 1_000,
    });
    const assertion = expect(rpcPromise).resolves.toEqual({ ok: true });

    await assertion;

    expect(machineRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenNthCalledWith(1, SOCKET_RPC_EVENTS.CALL, expect.objectContaining({
      method: 'machine-1:method-test',
      params: expect.any(String),
      timeoutMs: expect.any(Number),
    }));
    expect(await machineEncryption.decryptRaw(emitWithAckSpy.mock.calls[0]?.[1]?.params)).toEqual({ value: 1 });
    expect((emitWithAckSpy.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
    expect((emitWithAckSpy.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('does not retry a scoped exact machine RPC after the real socket emit is issued', async () => {
    const emitWithAckSpy = vi.fn(async () => ({
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck: emitWithAckSpy })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValue(fakeSocket);
    const onIssued = vi.fn();

    await expect(machineRpcWithServerScope({
      serverId: home.id,
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 1 },
      preferScoped: true,
      timeoutMs: 1_000,
      onIssued,
    })).rejects.toThrow('RPC method not available');

    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(emitWithAckSpy).toHaveBeenCalledTimes(1);
    expect(createEphemeralSocketSpy).toHaveBeenCalledTimes(1);
  });
});
