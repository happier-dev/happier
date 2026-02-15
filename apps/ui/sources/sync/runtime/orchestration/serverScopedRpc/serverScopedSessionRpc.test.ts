import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { resetScopedSessionDataKeyCacheForTests } from './resolveScopedSessionDataKey';

const ioSpy = vi.hoisted(() => vi.fn());
const sessionRpcSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioSpy(...args),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
  apiSocket: {
    sessionRPC: (...args: unknown[]) => sessionRpcSpy(...args),
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

describe('sessionRpcWithServerScope', () => {
  afterEach(() => {
    ioSpy.mockReset();
    sessionRpcSpy.mockReset();
    getCredentialsSpy.mockReset();
    createEncryptionSpy.mockReset();
    listServerProfilesSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    vi.unstubAllGlobals();
    resetScopedSessionDataKeyCacheForTests();
  });

  it('delegates to apiSocket.sessionRPC when target server is omitted', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 1 },
    });

    expect(result).toEqual({ ok: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 1 });
    expect(ioSpy).not.toHaveBeenCalled();
  });

  it('routes RPC through a scoped socket when target server differs from active server', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });

    const sessionEncryption = {
      encryptRaw: vi.fn(async () => 'encrypted-payload'),
      decryptRaw: vi.fn(async () => ({ decoded: true })),
    };
    const initializeSessions = vi.fn(async () => {});
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => new Uint8Array([1])),
      initializeSessions,
      getSessionEncryption: vi.fn(() => sessionEncryption),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ session: { id: 'session-1', dataEncryptionKey: 'k1' } }),
      })),
    );

    const fakeSocket = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'connect') cb();
      }),
      off: vi.fn(),
      timeout: vi.fn(() => ({
        emitWithAck: vi.fn(async () => ({ ok: true, result: 'encrypted-result' })),
      })),
      disconnect: vi.fn(),
    };
    ioSpy.mockReturnValue(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 2 },
      serverId: 'server-b',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decoded: true });
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(ioSpy).toHaveBeenCalledWith(
      'https://server-b.example.test',
      expect.objectContaining({
        path: '/v1/updates',
        auth: expect.objectContaining({
          token: 'token-b',
          clientType: 'user-scoped',
        }),
      }),
    );
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['session-1', expect.any(Uint8Array)]]));
    expect(sessionEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect((fakeSocket.timeout as any).mock.results[0].value.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: 'encrypted-payload',
    });
    expect(sessionEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });
});

