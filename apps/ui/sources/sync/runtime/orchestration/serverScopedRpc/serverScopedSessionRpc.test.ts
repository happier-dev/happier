import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { resetScopedSessionDataKeyCacheForTests } from './resolveScopedSessionDataKey';

const sessionListByIdFixture = {
  id: 'session-1',
  seq: 1,
  createdAt: 1,
  updatedAt: 1,
  active: false,
  activeAt: 1,
  archivedAt: null,
  metadata: 'metadata',
  metadataVersion: 1,
  agentState: null,
  agentStateVersion: 0,
  pendingCount: 0,
  pendingVersion: 0,
  dataEncryptionKey: 'k1',
} as const;

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
      timeoutMs: 5000,
    });

    expect(result).toEqual({ ok: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 1 }, { timeoutMs: 5000 });
    expect(ioSpy).not.toHaveBeenCalled();
  });

  it('falls back to a scoped plaintext RPC when active session RPC lacks local encryption context', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockRejectedValueOnce(new Error('Session encryption not found for session-1'));
    getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          session: {
            ...sessionListByIdFixture,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
          },
        }),
      })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { decodedPlain: true } }));
    const fakeSocket = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'connect') cb();
      }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck })),
      disconnect: vi.fn(),
    };
    ioSpy.mockReturnValue(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 4 },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 4 }, { timeoutMs: 5000 });
    expect(ioSpy).toHaveBeenCalledWith(
      'https://server-a.example.test',
      expect.objectContaining({
        path: '/v1/updates',
        auth: expect.objectContaining({
          token: 'token-a',
          clientType: 'user-scoped',
        }),
      }),
    );
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 4 },
      timeoutMs: 5000,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to a scoped plaintext RPC when active session RPC reports method not available', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error('RPC method not available');
    Object.assign(methodUnavailableError, { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    sessionRpcSpy.mockRejectedValueOnce(methodUnavailableError);
    getCredentialsSpy.mockResolvedValue({ token: 'token-a', secret: 'secret-a' });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          session: {
            ...sessionListByIdFixture,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
          },
        }),
      })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { decodedPlain: true } }));
    const fakeSocket = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'connect') cb();
      }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck })),
      disconnect: vi.fn(),
    };
    ioSpy.mockReturnValue(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 5 },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 5 }, { timeoutMs: 5000 });
    expect(ioSpy).toHaveBeenCalledWith(
      'https://server-a.example.test',
      expect.objectContaining({
        path: '/v1/updates',
        auth: expect.objectContaining({
          token: 'token-a',
          clientType: 'user-scoped',
        }),
      }),
    );
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 5 },
      timeoutMs: 5000,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
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
        json: async () => ({ session: sessionListByIdFixture }),
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
    const opts = ioSpy.mock.calls[0]?.[1] as any;
    expect(opts).not.toHaveProperty('transports');
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['session-1', expect.any(Uint8Array)]]));
    expect(sessionEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect((fakeSocket.timeout as any).mock.results[0].value.emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: 'encrypted-payload',
      timeoutMs: 5000,
    });
    expect(sessionEncryption.decryptRaw).toHaveBeenCalledWith('encrypted-result');
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses an exact same-URL alternate profile context instead of the active socket', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test/',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-a.example.test', name: 'Server A (alt id)' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });

    const initializeSessions = vi.fn(async () => {});
    const sessionEncryption = {
      encryptRaw: vi.fn(async () => 'encrypted-payload-alt'),
      decryptRaw: vi.fn(async () => ({ ok: true, source: 'alternate-profile' })),
    };
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => new Uint8Array([1])),
      initializeSessions,
      getSessionEncryption: vi.fn(() => sessionEncryption),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ session: sessionListByIdFixture }),
      })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result-alt' }));
    const fakeSocket = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'connect') cb();
      }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck })),
      disconnect: vi.fn(),
    };
    ioSpy.mockReturnValue(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(
      sessionRpcWithServerScope({
        sessionId: 'session-1',
        method: 'method-test',
        payload: { value: 6 },
        serverId: 'server-b',
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({ ok: true, source: 'alternate-profile' });

    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(getCredentialsSpy).toHaveBeenCalledWith('https://server-a.example.test', { serverId: 'server-b' });
    expect(ioSpy).toHaveBeenCalledWith(
      'https://server-a.example.test',
      expect.objectContaining({
        auth: expect.objectContaining({ token: 'token-b', clientType: 'user-scoped' }),
      }),
    );
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('routes plaintext RPC through a scoped socket when session encryptionMode is plain', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: 'token-b', secret: 'secret-b' });

    const initializeSessions = vi.fn(async () => {});
    const getSessionEncryption = vi.fn(() => null);
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions,
      getSessionEncryption,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          session: {
            ...sessionListByIdFixture,
            encryptionMode: 'plain',
            dataEncryptionKey: null,
          },
        }),
      })),
    );

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { decodedPlain: true } }));
    const fakeSocket = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'connect') cb();
      }),
      off: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck })),
      disconnect: vi.fn(),
    };
    ioSpy.mockReturnValue(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 3 },
      serverId: 'server-b',
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 3 },
      timeoutMs: 5000,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });
});
