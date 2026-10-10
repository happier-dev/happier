import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manager } from 'socket.io-client';

import { emitSocketWithAck } from './socketAck';

describe('Socket ACK transport', () => {
  afterEach(() => vi.useRealTimers());

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

  it('keeps a known pre-emit disconnect a definite rejection', async () => {
    const emitWithAck = vi.fn();
    await expect(emitSocketWithAck({
      socket: { connected: false, emitWithAck }, event: 'probe', payload: { v: 1 },
    })).rejects.toMatchObject({ code: 'socket_not_connected' });
    expect(emitWithAck).not.toHaveBeenCalled();
  });
});
