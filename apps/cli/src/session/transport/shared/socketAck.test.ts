import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manager } from 'socket.io-client';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';

import { emitSocketCallbackAck, emitSocketWithAck } from './socketAck';

describe('Socket ACK transport', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves missing-method refusals on callback ACKs without interpreting ordinary domain rejections', async () => {
    vi.useFakeTimers();
    const refusal = { ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, method: 'probe' };
    const emit = vi.fn((_event: string, _payload: unknown, ack: (value: unknown) => void) => ack(refusal));
    await expect(emitSocketCallbackAck({ socket: { connected: true, emit }, event: 'probe', payload: {} }))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, method: 'probe', retryable: false });
    const domainRejection = { status: 'rejected', reason: 'session_not_found' };
    await expect(emitSocketWithAck({ socket: { connected: true, emitWithAck: async () => domainRejection },
      event: 'probe', payload: {} })).resolves.toBe(domainRejection);
  });

  it('classifies the native Socket.IO ACK deadline without claiming a disconnect', async () => {
    vi.useFakeTimers();
    const manager = new Manager({ autoConnect: false });
    const socket = manager.socket('/');
    socket.connected = true;
    // Network packet delivery is the boundary; retain Socket.IO's real ACK timer.
    Reflect.set(manager, '_packet', vi.fn());
    const result = emitSocketWithAck({ socket, event: 'probe', payload: { v: 1 }, timeoutMs: 100 })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toMatchObject({
      name: 'SocketAckError', code: 'socket_ack_timeout', event: 'probe', timeoutMs: 100,
      cause: expect.objectContaining({ message: 'operation has timed out' }),
    });
    expect(socket.connected).toBe(true);
  });

  it('preserves an actual post-emit disconnect and does not replay the input', async () => {
    const disconnected = new Error('socket has been disconnected');
    const emitWithAck = vi.fn().mockRejectedValue(disconnected);
    await expect(emitSocketWithAck({
      socket: { connected: true, emitWithAck }, event: 'probe', payload: { v: 1 },
    })).rejects.toBe(disconnected);
    expect(emitWithAck).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit admission budget beyond the former control clamp', async () => {
    vi.useFakeTimers();
    const emitWithAck = vi.fn(() => new Promise(resolve => setTimeout(() => resolve('accepted'), 65_000)));
    const result = emitSocketWithAck({ socket: { connected: true, emitWithAck }, event: 'admission',
      payload: { v: 1 }, timeoutMs: 90_000 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await result).toBe('accepted');
    expect(emitWithAck).toHaveBeenCalledOnce();
  });

  it('keeps a known pre-emit disconnect a definite rejection', async () => {
    const emitWithAck = vi.fn();
    await expect(emitSocketWithAck({
      socket: { connected: false, emitWithAck }, event: 'probe', payload: { v: 1 },
    })).rejects.toMatchObject({ code: 'socket_not_connected' });
    expect(emitWithAck).not.toHaveBeenCalled();
  });

  it('waits for an operation-owned ACK beyond the control deadline and still honors cancellation', async () => {
    vi.useFakeTimers();
    let acknowledge!: (value: unknown) => void;
    const signal = new AbortController();
    const socket = {
      connected: true,
      emitWithAck: vi.fn(() => new Promise(resolve => { acknowledge = resolve; })),
      timeout: vi.fn(),
    };
    let settled = false;
    const result = emitSocketWithAck({ socket, event: 'settlement', payload: {}, timeoutMs: null,
      signal: signal.signal }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);
    acknowledge('committed');
    expect(await result).toBe('committed');
    expect(socket.timeout).not.toHaveBeenCalled();

    const cancelled = emitSocketWithAck({ socket, event: 'settlement', payload: {}, timeoutMs: null,
      signal: signal.signal }).catch(error => error);
    signal.abort();
    expect(await cancelled).toMatchObject({ name: 'SocketAckAbortError' });
  });

  it('settles an operation-owned wait on a real Socket.IO disconnect', async () => {
    const manager = new Manager({ autoConnect: false });
    const socket = manager.socket('/');
    socket.connected = true;
    Reflect.set(manager, '_packet', vi.fn());
    const result = emitSocketWithAck({ socket, event: 'settlement', payload: {}, timeoutMs: null })
      .catch(error => error);
    socket.disconnect();
    expect(await result).toBeInstanceOf(Error);
  });
});
