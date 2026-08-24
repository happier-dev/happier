import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';

const machineRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const runtimeFetchWithServerReachabilitySpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
  runtimeFetchWithServerReachability: (...args: unknown[]) => runtimeFetchWithServerReachabilitySpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    machineRPC: (...args: unknown[]) => machineRpcSpy(...args),
  },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
  TokenStorage: {
    getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsSpy(...args),
  },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
  createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
  const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
  return createServerProfilesModuleMock({
    importOriginal,
    overrides: {
      listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
    },
  });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');

describe('machineRpcWithServerScope (retry)', () => {
  beforeEach(() => {
    machineRpcSpy.mockReset();
    createEphemeralSocketSpy.mockReset();
    getCredentialsSpy.mockReset();
    createEncryptionSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    runtimeFetchWithServerReachabilitySpy.mockReset();
    runtimeFetchWithServerReachabilitySpy.mockResolvedValue(Response.json([
      { id: 'machine-1', dataEncryptionKey: null },
    ]));
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetScopedMachineDataKeyCacheForTests();
  });

  it('retries once when the scoped rpc method is not available', async () => {
    getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

    const machineEncryption = {
      encryptRaw: vi.fn(async () => 'encrypted-payload'),
      decryptRaw: vi.fn(async () => ({ ok: true })),
    };
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeMachines: vi.fn(async () => {}),
      getMachineEncryption: vi.fn(() => machineEncryption),
    });

    const emitWithAckSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'RPC method not available',
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      })
      .mockResolvedValueOnce({
        ok: true,
        result: 'encrypted-result',
      });

    const fakeSocket = {
      timeout: vi.fn(() => ({
        emitWithAck: emitWithAckSpy,
      })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValue(fakeSocket);

    const authorization = { kind: 'session.write', sessionId: 'sess_1' } as const;
    const rpcPromise = machineRpcWithServerScope({
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 1 },
      preferScoped: true,
      timeoutMs: 1_000,
      authorization,
    });
    await expect(rpcPromise).resolves.toEqual({ ok: true });

    expect(machineRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenNthCalledWith(1, SOCKET_RPC_EVENTS.CALL, {
      method: 'machine-1:method-test',
      params: 'encrypted-payload',
      authorization,
      timeoutMs: 1_000,
    });
    expect(emitWithAckSpy).toHaveBeenNthCalledWith(2, SOCKET_RPC_EVENTS.CALL, {
      method: 'machine-1:method-test',
      params: 'encrypted-payload',
      authorization,
      timeoutMs: 1_000,
    });
  });

  it('does not retry a scoped exact machine RPC after its socket emission was attempted', async () => {
    getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

    const machineEncryption = {
      encryptRaw: vi.fn(async () => 'encrypted-payload'),
      decryptRaw: vi.fn(async () => ({ ok: true })),
    };
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeMachines: vi.fn(async () => {}),
      getMachineEncryption: vi.fn(() => machineEncryption),
    });
    const emitWithAckSpy = vi.fn(async () => ({
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    }));
    createEphemeralSocketSpy.mockResolvedValue({
      timeout: vi.fn(() => ({ emitWithAck: emitWithAckSpy })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    });
    const onIssued = vi.fn();

    const rpcPromise = machineRpcWithServerScope({
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 2 },
      preferScoped: true,
      timeoutMs: 1_000,
      onIssued,
    });
    await expect(rpcPromise).rejects.toThrow('RPC method not available');

    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(createEphemeralSocketSpy).toHaveBeenCalledTimes(1);
    expect(emitWithAckSpy).toHaveBeenCalledTimes(1);
  });
});
