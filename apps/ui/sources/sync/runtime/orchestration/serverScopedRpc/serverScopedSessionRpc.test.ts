import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { resetScopedSessionDataKeyCacheForTests } from './resolveScopedSessionDataKey';

const TOKEN_A = `hdr.${btoa(JSON.stringify({ sub: 'account-a' }))}.sig`;
const TOKEN_B = `hdr.${btoa(JSON.stringify({ sub: 'account-b' }))}.sig`;

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

const sessionRpcSpy = vi.hoisted(() => vi.fn());
const createEphemeralSocketSpy = vi.hoisted(() => vi.fn());
const getCredentialsSpy = vi.hoisted(() => vi.fn());
const createEncryptionSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
  createEphemeralServerSocketClient: (...args: unknown[]) => createEphemeralSocketSpy(...args),
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
  isTokenOnlyAuthCredentials: (credentials: unknown) => {
    if (!credentials || typeof credentials !== 'object') return false;
    const record = credentials as Record<string, unknown>;
    return !('secret' in record) && !('encryption' in record);
  },
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
  createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryptionSpy(...args),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
  const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
  return createServerProfilesModuleMock({
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
  });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/v1/auth/ping')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    return globalThis.fetch(input, init);
  },
}));

describe('sessionRpcWithServerScope', () => {
  afterEach(() => {
    vi.useRealTimers();
    sessionRpcSpy.mockReset();
    createEphemeralSocketSpy.mockReset();
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
    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-test',
      { value: 1 },
      expect.objectContaining({
        timeoutMs: 5000,
        onIssued: expect.any(Function),
      }),
    );
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted session call before resolving or issuing it', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });
    const controller = new AbortController();
    controller.abort();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 1 },
      timeoutMs: 5000,
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'SOCKET_RPC_ABORTED',
    });

    expect(sessionRpcSpy).not.toHaveBeenCalled();
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('preserves an explicit unbounded RPC lifetime for the active server', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockResolvedValue({ ok: true });

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-watch',
      payload: { value: 1 },
      timeoutMs: null,
    })).resolves.toEqual({ ok: true });

    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-watch',
      { value: 1 },
      expect.objectContaining({
        timeoutMs: null,
        onIssued: expect.any(Function),
      }),
    );
  });

  it('keeps scoped connection setup bounded while preserving an unbounded RPC lifetime', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
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

    const emitWithAck = vi.fn(async () => ({ ok: true, result: { watched: true } }));
    const timeout = vi.fn(() => ({ emitWithAck: vi.fn() }));
    const fakeSocket = {
      timeout,
      emitWithAck,
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      serverId: 'server-b',
      method: 'method-watch',
      payload: { value: 2 },
      timeoutMs: null,
    })).resolves.toEqual({ watched: true });

    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 30_000,
    }));
    expect(timeout).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-watch',
      params: { value: 2 },
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('falls back to a scoped plaintext RPC when active session RPC lacks local encryption context', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    sessionRpcSpy.mockRejectedValueOnce(new Error('Session encryption not found for session-1'));
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: 'secret-a' });

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
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 4 },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith(
      'session-1',
      'method-test',
      { value: 4 },
      expect.objectContaining({
        timeoutMs: 5000,
        onIssued: expect.any(Function),
      }),
    );
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_A,
      timeoutMs: 5000,
    }));
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
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_A, secret: 'secret-a' });

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

    const calls: string[] = [];
    const emitWithAck = vi.fn(async () => {
      calls.push('emit');
      return { ok: true, result: { decodedPlain: true } };
    });
    const fakeSocket = {
      timeout: vi.fn(() => {
        calls.push('timeout-emitter');
        return { emitWithAck };
      }),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);
    const onIssued = vi.fn(() => calls.push('issued'));

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = await sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 5 },
      timeoutMs: 5000,
      onIssued,
    });

    expect(result).toEqual({ decodedPlain: true });
    expect(sessionRpcSpy).toHaveBeenCalledWith('session-1', 'method-test', { value: 5 }, {
      timeoutMs: 5000,
      onIssued: expect.any(Function),
    });
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_A,
      timeoutMs: 5000,
    }));
    expect(initializeSessions).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 5 },
      timeoutMs: 5000,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['timeout-emitter', 'issued', 'emit']);
    expect(onIssued).toHaveBeenCalledTimes(1);
  });

  it('does not fall back after an exact active session RPC crosses the socket issuance boundary', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error('RPC method not available after emit');
    Object.assign(methodUnavailableError, { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
    sessionRpcSpy.mockImplementationOnce(async (_sessionId, _method, _payload, options) => {
      options.onIssued();
      throw methodUnavailableError;
    });
    const onIssued = vi.fn();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 8 },
      timeoutMs: 5000,
      onIssued,
    })).rejects.toBe(methodUnavailableError);

    expect(onIssued).toHaveBeenCalledTimes(1);
    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('does not fall back after issuance when the caller does not request an issuance callback', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    const methodUnavailableError = new Error(
      'RPC method not available after emit',
    );
    Object.assign(methodUnavailableError, {
      rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
    });
    sessionRpcSpy.mockImplementationOnce(
      async (_sessionId, _method, _payload, options) => {
        options.onIssued();
        throw methodUnavailableError;
      },
    );

    const { sessionRpcWithServerScope } = await import(
      './serverScopedSessionRpc'
    );
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'session.model.transition',
      payload: { value: 9 },
      timeoutMs: 5000,
    })).rejects.toBe(methodUnavailableError);

    expect(createEphemeralSocketSpy).not.toHaveBeenCalled();
  });

  it('routes RPC through a scoped socket when target server differs from active server', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });

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

    const emitWithAck = vi.fn(async () => ({ ok: true, result: 'encrypted-result' }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

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
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-b.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
    expect(initializeSessions).toHaveBeenCalledWith(new Map([['session-1', expect.any(Uint8Array)]]));
    expect(sessionEncryption.encryptRaw).toHaveBeenCalledWith({ value: 2 });
    expect(fakeSocket.timeout).toHaveBeenCalledWith(5000);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
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
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });

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
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

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
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-a.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
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
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });

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
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

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
    expect(createEphemeralSocketSpy).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://server-b.example.test',
      token: TOKEN_B,
      timeoutMs: 5000,
    }));
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

  it('routes plaintext RPC with token-only credentials and never constructs encryption', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B });

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

    const emitWithAck = vi.fn(async () => ({
      ok: true,
      result: { decodedPlain: true },
    }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    await expect(sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 3 },
      serverId: 'server-b',
      timeoutMs: 5000,
    })).resolves.toEqual({ decodedPlain: true });

    expect(createEncryptionSpy).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, {
      method: 'session-1:method-test',
      params: { value: 3 },
      timeoutMs: 5000,
    });
  });

  it('rejects when a scoped socket ACK never settles', async () => {
    vi.useFakeTimers();
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([{ id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' }]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });

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

    const emitWithAck = vi.fn(() => new Promise<never>(() => {}));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const result = sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 7 },
      serverId: 'server-b',
      timeoutMs: 5000,
    }).then(
      () => ({ state: 'resolved' as const }),
      (error: unknown) => ({
        state: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    await vi.waitFor(() => {
      expect(emitWithAck).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(Promise.race([
      result,
      Promise.resolve({ state: 'pending' as const }),
    ])).resolves.toEqual({
      state: 'rejected',
      message: 'operation has timed out',
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('locally fences an old scoped peer that ignores cancellation and replies late', async () => {
    getActiveServerSnapshotSpy.mockReturnValue({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    });
    listServerProfilesSpy.mockReturnValue([
      { id: 'server-b', serverUrl: 'https://server-b.example.test', name: 'Server B' },
    ]);
    getCredentialsSpy.mockResolvedValue({ token: TOKEN_B, secret: 'secret-b' });
    createEncryptionSpy.mockResolvedValue({
      decryptEncryptionKey: vi.fn(async () => null),
      initializeSessions: vi.fn(async () => {}),
      getSessionEncryption: vi.fn(() => null),
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

    let resolveLateAck!: (value: unknown) => void;
    const emitWithAck = vi.fn<(event: string, payload: unknown) => Promise<unknown>>(() => new Promise<unknown>((resolve) => {
      resolveLateAck = resolve;
    }));
    const fakeSocket = {
      timeout: vi.fn(() => ({ emitWithAck })),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    createEphemeralSocketSpy.mockResolvedValueOnce(fakeSocket);
    const controller = new AbortController();

    const { sessionRpcWithServerScope } = await import('./serverScopedSessionRpc');
    const pending = sessionRpcWithServerScope({
      sessionId: 'session-1',
      method: 'method-test',
      payload: { value: 8 },
      serverId: 'server-b',
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledTimes(1));
    const issuedPayload = emitWithAck.mock.calls[0]?.[1] as { requestId?: unknown };

    controller.abort();

    const settled = await Promise.race([
      pending.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setTimeout(() => resolve({ status: 'pending' }), 50)),
    ]);
    expect(settled).toMatchObject({
      status: 'rejected',
      error: { name: 'AbortError', code: 'SOCKET_RPC_ABORTED' },
    });
    expect(issuedPayload.requestId).toEqual(expect.any(String));
    expect(fakeSocket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, {
      requestId: issuedPayload.requestId,
    });
    expect(fakeSocket.disconnect).toHaveBeenCalledTimes(1);

    resolveLateAck({ ok: true, result: { stale: true } });
    await Promise.resolve();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'SOCKET_RPC_ABORTED',
    });
  });
});
