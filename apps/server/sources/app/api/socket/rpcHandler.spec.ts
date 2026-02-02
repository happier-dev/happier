import { describe, it, expect, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

class FakeSocket {
  public connected = true;
  public id = 'fake-socket';
  public handlers = new Map<string, any>();
  public emit = vi.fn();

  on(event: string, handler: any) {
    this.handlers.set(event, handler);
  }

  timeout() {
    return {
      emitWithAck: async () => {
        throw new Error('not implemented');
      },
    };
  }
}

describe('rpcHandler', () => {
  it('returns an explicit errorCode when the RPC method is not available', async () => {
    vi.resetModules();
    const { rpcHandler } = await import('./rpcHandler');
    const socket = new FakeSocket();
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    rpcHandler('user-1', socket as any, userRpcListeners as any, allRpcListeners as any, {
      io: {} as any,
      redisRegistry: { enabled: false },
    });

    const handler = socket.handlers.get(SOCKET_RPC_EVENTS.CALL);
    expect(typeof handler).toBe('function');

    const callback = vi.fn();
    await handler({ method: 'missing-method', params: {} }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: 'RPC method not available',
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
  });

  it('uses Redis RPC registry + io.emitWithAck when enabled', async () => {
    vi.resetModules();
    const targetSocketId = 'target-socket';
    const hmget = vi.fn().mockResolvedValue([targetSocketId]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock('@/storage/redis', () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    const { rpcHandler } = await import('./rpcHandler');
    const socket = new FakeSocket();
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const emitWithAck = vi.fn().mockResolvedValue([{ ok: true, value: 123 }]);
    const to = vi.fn(() => ({ emitWithAck }));
    const timeout = vi.fn(() => ({ to }));
    const io = { timeout } as any;

    rpcHandler('user-1', socket as any, userRpcListeners as any, allRpcListeners as any, {
      io,
      redisRegistry: { enabled: true, instanceId: 'instance-1', ttlSeconds: 120 },
    });

    const handler = socket.handlers.get(SOCKET_RPC_EVENTS.CALL);
    expect(typeof handler).toBe('function');

    const callback = vi.fn();
    await handler({ method: 'some-method', params: { a: 1 } }, callback);

    expect(timeout).toHaveBeenCalledWith(30000);
    expect(to).toHaveBeenCalledWith(targetSocketId);
    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, {
      method: 'some-method',
      params: { a: 1 },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: { ok: true, value: 123 },
      }),
    );
  });

  it('treats an empty io.emitWithAck response as method not available and cleans up stale Redis mapping', async () => {
    vi.resetModules();
    const targetSocketId = 'target-socket';
    const hmget = vi.fn().mockResolvedValue([targetSocketId]);
    const evalFn = vi.fn();
    const multi = vi.fn(() => ({ hset: () => ({ expire: () => ({ exec: vi.fn() }) }) }));

    vi.doMock('@/storage/redis', () => ({
      getRedisClient: () => ({ hmget, eval: evalFn, multi }),
    }));

    const { rpcHandler } = await import('./rpcHandler');
    const socket = new FakeSocket();
    const userRpcListeners = new Map<string, any>();
    const allRpcListeners = new Map<string, any>();

    const emitWithAck = vi.fn().mockResolvedValue([]);
    const to = vi.fn(() => ({ emitWithAck }));
    const timeout = vi.fn(() => ({ to }));
    const io = { timeout } as any;

    rpcHandler('user-1', socket as any, userRpcListeners as any, allRpcListeners as any, {
      io,
      redisRegistry: { enabled: true, instanceId: 'instance-1', ttlSeconds: 120 },
    });

    const handler = socket.handlers.get(SOCKET_RPC_EVENTS.CALL);
    expect(typeof handler).toBe('function');

    const callback = vi.fn();
    await handler({ method: 'some-method', params: { a: 1 } }, callback);

    expect(timeout).toHaveBeenCalledWith(30000);
    expect(to).toHaveBeenCalledWith(targetSocketId);
    expect(emitWithAck).toHaveBeenCalled();

    expect(evalFn).toHaveBeenCalledWith(expect.any(String), 1, `rpc:user-1:some-method`, targetSocketId);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: 'RPC method not available',
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );
  });
});
