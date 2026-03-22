import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resetScopedMachineDataKeyCacheForTests } from './serverScopedRpcPool';

const ioSpy = vi.hoisted(() => vi.fn());
const machineRpcSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioSpy(...args),
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

vi.mock('@/sync/domains/server/serverProfiles', () => ({
  listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

describe('machineRpcWithServerScope (retry)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ioSpy.mockReset();
    machineRpcSpy.mockReset();
    getCredentialsSpy.mockReset();
    createEncryptionSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'machine-1', dataEncryptionKey: null }],
    })));

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

    ioSpy.mockImplementation(() => ({
      on: (event: string, cb: () => void) => {
        if (event === 'connect') cb();
      },
      off: vi.fn(),
      timeout: vi.fn(() => ({
        emitWithAck: emitWithAckSpy,
      })),
      disconnect: vi.fn(),
    }));

    const { machineRpcWithServerScope } = await import('./serverScopedMachineRpc');

    const rpcPromise = machineRpcWithServerScope({
      machineId: 'machine-1',
      method: 'method-test',
      payload: { value: 1 },
      preferScoped: true,
    });
    const assertion = expect(rpcPromise).resolves.toEqual({ ok: true });

    await vi.runAllTimersAsync();
    await assertion;

    expect(machineRpcSpy).not.toHaveBeenCalled();
    expect(ioSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenCalledTimes(2);
    expect(emitWithAckSpy).toHaveBeenNthCalledWith(1, SOCKET_RPC_EVENTS.CALL, {
      method: 'machine-1:method-test',
      params: 'encrypted-payload',
      timeoutMs: 30000,
    });
  });
});
