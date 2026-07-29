import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

let nextRpcAck: any = null;
let nextSocket: FakeSocket | null = null;
let configureNextSocket: ((socket: FakeSocket) => void) | null = null;

class FakeSocket {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  public emitted: Array<{ event: string; data: any }> = [];
  public connectError: Error | null = null;
  public emitError: Error | null = null;
  public ackMode: 'sync' | 'never' = 'sync';
  public disconnectCalls = 0;
  public closeCalls = 0;

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(event, list.filter((item) => item !== handler));
    return this;
  }

  removeListener(event: string, handler: (...args: any[]) => void) {
    return this.off(event, handler);
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.length ?? 0;
  }

  connect() {
    if (this.connectError) {
      for (const handler of this.handlers.get('connect_error') ?? []) {
        handler(this.connectError);
      }
      return this;
    }
    for (const handler of this.handlers.get('connect') ?? []) {
      handler();
    }
    return this;
  }

  emit(event: string, data: any, callback: (payload: any) => void) {
    if (this.emitError) {
      throw this.emitError;
    }
    this.emitted.push({ event, data });
    if (this.ackMode === 'never') {
      return this;
    }
    callback(nextRpcAck ?? { ok: true, result: { echoed: data.params } });
    return this;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }
}

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: vi.fn(() => {
    nextSocket = new FakeSocket();
    configureNextSocket?.(nextSocket);
    return nextSocket;
  }),
  createUserScopedSocket: vi.fn(() => {
    nextSocket = new FakeSocket();
    configureNextSocket?.(nextSocket);
    return nextSocket;
  }),
}));

describe('callSessionRpc (plaintext sessions)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    nextRpcAck = null;
    nextSocket = null;
    configureNextSocket = null;
  });

  it('uses a user-scoped caller socket for one-shot runtime RPC calls', async () => {
    const sockets = await import('@/api/session/sockets');
    const { callSessionRpc } = await import('./sessionRpc');

    await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    expect(sockets.createUserScopedSocket).toHaveBeenCalledWith({ token: 't' });
    expect(sockets.createSessionScopedSocket).not.toHaveBeenCalled();
  });

  it('sends plaintext params and returns plaintext results when mode=plain', async () => {
    nextRpcAck = null;
    const { callSessionRpc } = await import('./sessionRpc');
    const req = { a: 1 };
    const res = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: req,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    expect(res).toEqual({ echoed: req });
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
    expect(nextSocket?.listenerCount('connect')).toBe(0);
    expect(nextSocket?.listenerCount('connect_error')).toBe(0);
  });

  it('throws RpcError with rpcErrorCode when the RPC response includes errorCode', async () => {
    nextRpcAck = {
      ok: false,
      error: 'RPC method not available',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };

    const { callSessionRpc } = await import('./sessionRpc');
    await expect(
      callSessionRpc({
        token: 't',
        sessionId: 'sess_1',
        mode: 'plain',
        method: 'sess_1:demo.method',
        request: { a: 1 },
        ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
      }),
    ).rejects.toSatisfy((error: unknown) => readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('closes the socket when connection fails before the RPC emit', async () => {
    const { callSessionRpc } = await import('./sessionRpc');
    configureNextSocket = (socket) => {
      socket.connectError = new Error('connect failed');
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    await expect(promise).rejects.toThrow('connect failed');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
    expect(nextSocket?.listenerCount('connect')).toBe(0);
    expect(nextSocket?.listenerCount('connect_error')).toBe(0);
  });

  it('closes the socket when emit throws synchronously', async () => {
    const { callSessionRpc } = await import('./sessionRpc');
    configureNextSocket = (socket) => {
      socket.emitError = new Error('emit failed');
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    await expect(promise).rejects.toThrow('emit failed');
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });

  it('closes the socket when the RPC ack times out', async () => {
    vi.useFakeTimers();
    const { callSessionRpc } = await import('./sessionRpc');
    configureNextSocket = (socket) => {
      socket.ackMode = 'never';
    };
    const promise = callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: { a: 1 },
      timeoutMs: 10,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });
    const rejection = expect(promise).rejects.toThrow('RPC call timeout');
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(nextSocket?.disconnectCalls).toBe(1);
    expect(nextSocket?.closeCalls).toBe(1);
  });
});
