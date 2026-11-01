import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { deriveAccountMachineKeyFromRecoverySecret, sealEncryptedDataKeyEnvelopeV1, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

const socketHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
const socket = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  close: vi.fn(),
  emit: vi.fn(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.set(event, [...(socketHandlers.get(event) ?? []), handler]);
    return socket;
  }),
  off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    socketHandlers.set(event, (socketHandlers.get(event) ?? []).filter((candidate) => candidate !== handler));
    return socket;
  }),
};
const axiosGet = vi.hoisted(() => vi.fn());
let disconnectWhenConnectWaitSettles = false;

function triggerSocketEvent(event: string, ...args: unknown[]): void {
  for (const handler of socketHandlers.get(event) ?? []) handler(...args);
}

vi.mock('@/api/session/sockets', () => ({
  createUserScopedSocket: vi.fn(() => socket),
}));
vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));
vi.mock('@/configuration', async (importOriginal) => ({
  configuration: {
    ...(await importOriginal<typeof import('@/configuration')>()).configuration,
    serverUrl: 'https://api.example.test',
    apiServerUrl: 'https://api.example.test',
  },
}));

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode, RpcError } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { readRpcRequestDisposition } from './rpcRequestDisposition';

import { callMachineRpc } from './machineRpc';

describe('callMachineRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axiosGet.mockReset();
    socket.emit.mockImplementation((_event, _payload, callback) => callback?.({ ok: true, result: null }));
    axiosGet.mockResolvedValue({ status: 404, data: { error: 'Machine not found' } });
    socket.connect.mockImplementation(() => {
      triggerSocketEvent('connect');
      if (disconnectWhenConnectWaitSettles) triggerSocketEvent('disconnect', 'transport close');
    });
    socketHandlers.clear();
    disconnectWhenConnectWaitSettles = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('encrypts and sends exactly one account-scoped call to the requested machine', async () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };
    socket.emit.mockImplementation((_event, payload, callback) => {
      expect(payload.method).toBe('machine-session:spawn-happy-session');
      expect(payload.timeoutMs).toBe(100);
      expect(decrypt(machineKey, 'dataKey', decodeBase64(payload.params, 'base64'))).toEqual({ sessionId: 'session-1' });
      expect(payload.authorization).toEqual({ kind: 'session.write', sessionId: 'session-1' });
      callback({
        ok: true,
        result: encodeBase64(encrypt(machineKey, 'dataKey', { type: 'success', sessionId: 'session-1' })),
      });
    });

    await expect(callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      authorization: { kind: 'session.write', sessionId: 'session-1' },
      timeoutMs: 100,
    })).resolves.toEqual({ type: 'success', sessionId: 'session-1' });

    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socketHandlers.get('disconnect')).toHaveLength(0);
    // A reached machine never pays for the replacement chain.
    expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines'))).toHaveLength(0);
  });

  it('executes plain machine RPC through the real handler without encryption material', async () => {
    axiosGet.mockImplementation(async (url: unknown) => String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : { status: 200, data: { machine: { id: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } } });
    const manager = new RpcHandlerManager({ scopePrefix: 'plain', encryptionKey: null, encryptionVariant: 'plain', logger: () => {} });
    manager.registerHandler('session-handoff', (request: unknown) => ({ accepted: request }));
    socket.emit.mockImplementation((_event, payload, callback) => {
      void manager.handleRequest(payload).then((result) => callback({ ok: true, result }));
    });
    await expect(callMachineRpc({ credentials: { token: 'token', encryption: null }, machineId: 'plain',
      method: 'session-handoff', request: { sessionId: 'session' } }))
      .resolves.toEqual({ accepted: { sessionId: 'session' } });
  });

  it('refuses an unopenable published target key before source handoff mutation', async () => {
    const callerKey = new Uint8Array(32).fill(7);
    const foreignKey = new Uint8Array(32).fill(99);
    const publishedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(19),
      recipientPublicKey: libsodiumPublicKeyFromSecretKey(foreignKey), randomBytes: getRandomBytes }));
    axiosGet.mockResolvedValue({ status: 200, data: { machine: { id: 'target', dataEncryptionKey: publishedKey } } });
    const manager = new RpcHandlerManager({ scopePrefix: 'target', encryptionKey: callerKey, encryptionVariant: 'dataKey', logger: () => {} });
    let sourceMutated = false;
    manager.registerHandler('session-handoff', () => { sourceMutated = true; return { status: 'accepted' }; });
    socket.emit.mockImplementation((_event, payload, callback) => {
      void manager.handleRequest(payload).then((result) => callback({ ok: true, result }));
    });
    const error = await callMachineRpc({ credentials: { token: 'account-token', encryption: { type: 'dataKey', machineKey: callerKey, publicKey: callerKey } },
      machineId: 'target', method: 'session-handoff', request: {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'target_key_unavailable' });
    expect(readRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
    expect(sourceMutated).toBe(false);
  });

  it.each(['dataKey', 'legacy'] as const)('uses the published target data key for %s account credentials', async (credentialType) => {
    const callerKey = new Uint8Array(32).fill(7);
    const recipientKey = credentialType === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(callerKey)
      : callerKey;
    const targetKey = new Uint8Array(32).fill(19);
    const credentials = { token: 'account-token', encryption: credentialType === 'legacy'
      ? { type: 'legacy' as const, secret: callerKey }
      : { type: 'dataKey' as const, publicKey: libsodiumPublicKeyFromSecretKey(callerKey), machineKey: callerKey } };
    const publishedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: targetKey, recipientPublicKey: libsodiumPublicKeyFromSecretKey(recipientKey), randomBytes: getRandomBytes,
    }));
    axiosGet.mockResolvedValue({ status: 200, data: { machine: { id: 'target', dataEncryptionKey: publishedKey } } });
    const manager = new RpcHandlerManager({ scopePrefix: 'target', encryptionKey: targetKey, encryptionVariant: 'dataKey', logger: () => {} });
    let mutationCount = 0;
    manager.registerHandler('session-handoff', (request: unknown) => {
      expect(request).toEqual({ sessionId: 'session-1' });
      mutationCount += 1;
      return { status: 'accepted' };
    });
    socket.emit.mockImplementation((_event, payload, callback) => {
      void manager.handleRequest(payload).then((result) => callback({ ok: true, result }));
    });
    await expect(callMachineRpc({ credentials, machineId: 'target', method: 'session-handoff', request: { sessionId: 'session-1' } }))
      .resolves.toEqual({ status: 'accepted' });
    expect(mutationCount).toBe(1);
  });

  it.each([
    { publishedKey: 'not-base64', reason: 'target_key_invalid' },
    { publishedKey: 42, reason: 'target_key_invalid' },
    { publishedKey: '', reason: 'target_key_invalid' },
  ])('refuses malformed published target key $publishedKey before emitting or mutating', async ({ publishedKey, reason }) => {
    const callerKey = new Uint8Array(32).fill(7);
    axiosGet.mockResolvedValue({ status: 200, data: { machine: { id: 'target', dataEncryptionKey: publishedKey } } });
    const error = await callMachineRpc({ credentials: { token: 'account-token', encryption: { type: 'legacy', secret: callerKey } },
      machineId: 'target', method: 'session-handoff', request: {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason });
    expect(readRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('refuses malformed published key encoding even when its decoded envelope can open', async () => {
    const key = new Uint8Array(32).fill(7);
    const publishedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
      recipientPublicKey: libsodiumPublicKeyFromSecretKey(key), randomBytes: getRandomBytes }));
    axiosGet.mockResolvedValue({ status: 200, data: { machine: { id: 'target', dataEncryptionKey: `${publishedKey}!` } } });
    const error = await callMachineRpc({ credentials: { token: 'account-token', encryption: { type: 'dataKey', machineKey: key, publicKey: key } },
      machineId: 'target', method: 'session-handoff', request: {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'target_key_invalid' });
    expect(readRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('rejects a response encrypted for a different key without retrying', async () => {
    const key = new Uint8Array(32).fill(7);
    socket.emit.mockImplementation((_event, _payload, callback) => callback({ ok: true,
      result: encodeBase64(encrypt(new Uint8Array(32).fill(8), 'dataKey', { status: 'accepted' })) }));
    const error = await callMachineRpc({ credentials: { token: 'account-token', encryption: { type: 'dataKey', machineKey: key, publicKey: key } },
      machineId: 'target', method: 'session-handoff', request: {} }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_ENCRYPTION_ERROR', reason: 'response_invalid' });
    expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('uses the caller connection budget for the target HTTP read and never emits after its timeout', async () => {
    vi.useFakeTimers();
    const key = new Uint8Array(32).fill(7);
    axiosGet.mockImplementation((_url: unknown, options: { timeout?: number }) => new Promise((resolve, reject) => {
      setTimeout(() => resolve({ status: 404, data: {} }), 50);
      if (options.timeout !== undefined) {
        setTimeout(() => reject(Object.assign(new Error('HTTP request timeout'), { code: 'ECONNABORTED' })), options.timeout);
      }
    }));
    const outcome = callMachineRpc({ credentials: { token: 'account-token', encryption: { type: 'legacy', secret: key } },
      machineId: 'target', method: 'session-handoff', request: {}, timeoutMs: 25 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await outcome;
    expect(error).toMatchObject({ code: 'ECONNABORTED' });
    expect(readRpcRequestDisposition(error)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'source', failure: 'key' },
    { role: 'target', failure: 'network' },
    { role: 'source', failure: 'unsupported' },
    { role: 'source', failure: 'unavailable' },
    { role: 'target', failure: 'decoded' },
  ] as const)('preserves $failure failures during existing-state $role admission before process mutation', async ({ role, failure }) => {
    const { registerMachineSessionHandoffRpcHandlers } = await import('@/api/machine/rpcHandlers.sessionHandoff');
    const key = new Uint8Array(32).fill(7);
    const peerMachineId = role === 'source' ? 'target' : 'source';
    const credentials = { token: 'account-token', encryption: { type: 'dataKey' as const, machineKey: key, publicKey: key } };
    if (failure === 'key') {
      const foreignKey = new Uint8Array(32).fill(99);
      const publishedKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
        recipientPublicKey: libsodiumPublicKeyFromSecretKey(foreignKey), randomBytes: getRandomBytes }));
      axiosGet.mockResolvedValue({ status: 200, data: { machine: { id: peerMachineId, dataEncryptionKey: publishedKey } } });
    } else if (failure === 'network') {
      axiosGet.mockRejectedValue(Object.assign(new Error('HTTP connection reset'), { code: 'ECONNRESET' }));
    } else if (failure === 'decoded') {
      const peer = new RpcHandlerManager({ scopePrefix: peerMachineId, encryptionKey: key,
        encryptionVariant: 'dataKey', logger: () => {} });
      peer.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, async () => {
        throw new RpcError('Target denied the capability request', RPC_ERROR_CODES.FORBIDDEN);
      });
      // Relay delivery is the network boundary; target execution and crypto stay real.
      socket.emit.mockImplementation(async (_event, payload, callback) => {
        const result = await peer.handleRequest({ method: payload.method, params: payload.params });
        callback({ ok: true, result });
      });
    } else {
      socket.emit.mockImplementation((_event, _payload, callback) => callback({
        ok: false, error: failure === 'unsupported' ? RPC_ERROR_MESSAGES.METHOD_NOT_FOUND : RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: failure === 'unsupported' ? RPC_ERROR_CODES.METHOD_NOT_FOUND : RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }));
    }
    const manager = new RpcHandlerManager({ scopePrefix: 'local', encryptionKey: key, encryptionVariant: 'dataKey', logger: () => {} });
    let stopCount = 0;
    let spawnCount = 0;
    registerMachineSessionHandoffRpcHandlers({
      rpcHandlerManager: manager,
      probeHandoffCapability: (machineId) => callMachineRpc({ credentials, machineId,
        method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, request: {}, timeoutMs: 100 }),
      // Stopping and launching runners are the process boundary; admission stays real.
      stopSessionForHandoff: async () => { stopCount += 1; return 'stopped'; },
      spawnSessionForHandoff: async () => { spawnCount += 1; return { type: 'success', sessionId: 'session-1', runnerAcceptance: 'newly_accepted' }; },
    });
    const request = role === 'source'
      ? manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, {
        sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        sessionStorageMode: 'persisted', stateTransfer: 'existing',
        preferredTransportStrategies: ['direct_peer'], negotiatedTransportStrategy: 'direct_peer',
      })
      : manager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, {
        handoffId: 'unadmitted-existing', sessionId: 'session-1', sourceMachineId: 'source', targetMachineId: 'target',
        targetPath: '/workspace', sourceSessionStorageMode: 'persisted', stateTransfer: 'existing',
        negotiatedTransportStrategy: 'direct_peer', endpointCandidates: [],
      });
    const error = await request.catch((caught: unknown) => caught);
    if (failure === 'unsupported') {
      expect(error).toMatchObject({ ok: false, errorCode: 'upgrade_required' });
    } else {
      expect(error).toBeInstanceOf(Error);
      if (failure !== 'decoded') expect(readRpcRequestDisposition(error)).toBe('notSent');
      if (failure === 'unavailable') expect(readRpcErrorCode(error)).toBe(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    }
    if (failure === 'key') {
      expect(readRpcErrorCode(error)).toBe('MACHINE_RPC_ENCRYPTION_ERROR');
      expect(error).toMatchObject({ reason: 'target_key_unavailable' });
    } else if (failure === 'network') {
      expect(error).toMatchObject({ code: 'ECONNRESET' });
    } else if (failure === 'decoded') {
      expect(readRpcErrorCode(error)).toBe(RPC_ERROR_CODES.FORBIDDEN);
      expect(error).toMatchObject({ message: 'Target denied the capability request' });
    }
    expect(stopCount).toBe(0);
    expect(spawnCount).toBe(0);
    if (failure === 'key' || failure === 'network') expect(socket.emit).not.toHaveBeenCalled();
  });

  it('keeps a typed pre-execution refusal distinct from an uncertain submission', async () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = { token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey } };
    socket.emit.mockImplementation((_event, _payload, callback) => callback({
      ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN,
    }));
    const error = await callMachineRpc({ credentials, machineId: 'machine-session',
      method: 'spawn-happy-session', request: {}, timeoutMs: 100 }).catch((error: unknown) => error);
    expect(error).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(readRpcRequestDisposition(error)).toBe('notSent');
  });

  it('rejects promptly and cleans up when the socket disconnects before acknowledgement', async () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };
    socket.emit.mockImplementation(() => undefined);

    const result = callMachineRpc({
      credentials,
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      timeoutMs: 10_000,
    });

    await vi.waitFor(() => {
      expect(socket.emit.mock.calls[0]?.[0]).toBe(SOCKET_RPC_EVENTS.CALL);
    });
    triggerSocketEvent('disconnect', 'transport close');

    const error = await result.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    const requestId = socket.emit.mock.calls[0]?.[1]?.requestId;
    expect(requestId).toEqual(expect.any(String));
    expect(socket.emit.mock.calls[0]?.[0]).toBe(SOCKET_RPC_EVENTS.CALL);
    expect(socket.emit.mock.calls[1]).toEqual([
      SOCKET_RPC_EVENTS.CANCEL,
      { requestId },
    ]);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socketHandlers.get('disconnect')).toHaveLength(0);
  });

  it('does not miss a disconnect that settles with the connection wait', async () => {
    vi.useFakeTimers();
    disconnectWhenConnectWaitSettles = true;
    socket.emit.mockImplementation(() => undefined);
    const machineKey = new Uint8Array(32).fill(3);
    const notSettled = Symbol('not settled');
    let outcome: unknown = notSettled;
    const result = callMachineRpc({
      credentials: {
        token: 'account-token',
        encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
      },
      machineId: 'machine-session',
      method: 'spawn-happy-session',
      request: { sessionId: 'session-1' },
      timeoutMs: 10_000,
    });
    void result.then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );

    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(outcome).toMatchObject({ message: 'RPC socket disconnected before acknowledgement' });
    expect(readRpcRequestDisposition(outcome)).toBe('notSent');
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socketHandlers.get('disconnect')).toHaveLength(0);
  });

  /**
   * A user who replaces a machine keeps the Sessions the previous one hosted.
   * Nothing re-homes those rows, so a CLI/MCP send or resume still addresses the
   * PREDECESSOR; reaching the successor is what makes the replacement usable.
   */
  describe('replaced machine', () => {
    const machineKey = new Uint8Array(32).fill(3);
    const credentials = {
      token: 'account-token',
      encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
    };

    function mockChainRead(machines: ReadonlyArray<Record<string, unknown>>): void {
      axiosGet.mockImplementation(async (url: unknown) => {
        if (!String(url).endsWith('/v1/machines')) return { status: 404, data: {} };
        return { status: 200, data: machines };
      });
    }

    function unreachable() {
      return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    it('reaches the successor when the addressed machine was replaced', async () => {
      mockChainRead([
        { id: 'machine-old', replacedByMachineId: 'machine-mid' },
        { id: 'machine-mid', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, payload, callback) => {
        if (payload.method !== 'machine-new:status') {
          callback(unreachable());
          return;
        }
        callback({ ok: true, result: encodeBase64(encrypt(machineKey, 'dataKey', { status: 'running' })) });
      });

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).resolves.toEqual({ status: 'running' });

      // Exactly one retry, addressed to the end of the replacement chain.
      expect(socket.emit).toHaveBeenCalledTimes(2);
      expect(socket.emit.mock.calls[0]?.[1]?.method).toBe('machine-old:status');
      expect(socket.emit.mock.calls[1]?.[1]?.method).toBe('machine-new:status');
      expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines'))).toHaveLength(1);
    });

    it('surfaces the original error unchanged when the machine has no successor', async () => {
      mockChainRead([{ id: 'machine-old', replacedByMachineId: null }]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('surfaces the original error when the replacement chain cannot be read', async () => {
      axiosGet.mockImplementation(async (url: unknown) => {
        if (String(url).endsWith('/v1/machines')) throw new Error('chain lookup failed');
        return { status: 404, data: {} };
      });
      socket.emit.mockImplementation((_event, _payload, callback) => callback(unreachable()));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toMatchObject({
        message: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      });
      expect(socket.emit).toHaveBeenCalledTimes(1);
    });

    it('never re-addresses an error the machine itself answered with', async () => {
      mockChainRead([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation((_event, _payload, callback) => callback({
        ok: false,
        error: 'Session is already running',
      }));

      await expect(callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 100,
      })).rejects.toThrow('Session is already running');

      // A successor EXISTS and is still not used: re-running an answered call
      // against a different machine would be a correctness bug.
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines'))).toHaveLength(0);
    });

    it('never re-addresses a call whose outcome is unknown', async () => {
      mockChainRead([
        { id: 'machine-old', replacedByMachineId: 'machine-new' },
        { id: 'machine-new', replacedByMachineId: null },
      ]);
      socket.emit.mockImplementation(() => undefined);

      const error = await callMachineRpc({
        credentials,
        machineId: 'machine-old',
        method: 'status',
        request: { ping: true },
        timeoutMs: 10,
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'MACHINE_RPC_TIMEOUT' });
      expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');

      const requestId = socket.emit.mock.calls[0]?.[1]?.requestId;
      expect(requestId).toEqual(expect.any(String));
      expect(socket.emit.mock.calls[0]?.[0]).toBe(SOCKET_RPC_EVENTS.CALL);
      expect(socket.emit.mock.calls[1]).toEqual([
        SOCKET_RPC_EVENTS.CANCEL,
        { requestId },
      ]);
      expect(axiosGet.mock.calls.filter(([url]) => String(url).endsWith('/v1/machines'))).toHaveLength(0);
    });
  });
});
