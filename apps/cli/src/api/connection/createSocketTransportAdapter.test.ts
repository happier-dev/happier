import { describe, expect, it, vi } from 'vitest';

import { createSocketTransportAdapter, type SocketLike } from './createSocketTransportAdapter';

describe('createSocketTransportAdapter', () => {
  it('bridges socket lifecycle events to the managed transport interface', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let connected = false;

    const socket: SocketLike = {
      get connected() {
        return connected;
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
      },
      connect() {
        connected = true;
        handlers.get('connect')?.();
      },
      disconnect() {
        connected = false;
        handlers.get('disconnect')?.('transport close');
      },
      removeAllListeners: vi.fn(),
      io: {
        on(event: string, handler: (...args: unknown[]) => void) {
          handlers.set(`io:${event}`, handler);
        },
      },
    };

    const transport = createSocketTransportAdapter(socket);
    const connectedEvents: number[] = [];
    const disconnectedEvents: Array<{ intentional: boolean; reason?: string }> = [];
    const errors: unknown[] = [];

    transport.onConnected(() => connectedEvents.push(1));
    transport.onDisconnected((event) => disconnectedEvents.push(event));
    transport.onError((error) => errors.push(error));

    expect(transport.isConnected()).toBe(false);
    await transport.connect();
    expect(transport.isConnected()).toBe(true);
    expect(connectedEvents).toEqual([1]);

    handlers.get('connect_error')?.(new Error('boom'));
    expect(errors).toHaveLength(1);

    await transport.disconnect({ intentional: true });
    expect(transport.isConnected()).toBe(false);
    expect(disconnectedEvents).toEqual([{ intentional: true, reason: 'transport close' }]);

    await transport.destroy();
    expect(socket.removeAllListeners).toHaveBeenCalled();
  });
});
