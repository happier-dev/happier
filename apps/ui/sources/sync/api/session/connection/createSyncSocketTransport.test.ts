import { afterEach, describe, expect, it, vi } from 'vitest';

type SocketHandler = (...args: any[]) => void;

function createSocketStub() {
    const handlersByEvent = new Map<string, Set<SocketHandler>>();
    const socket = {
        connected: false,
        on: vi.fn((event: string, handler: SocketHandler) => {
            const bucket = handlersByEvent.get(event) ?? new Set<SocketHandler>();
            bucket.add(handler);
            handlersByEvent.set(event, bucket);
            return socket;
        }),
        connect: vi.fn(() => {
            socket.connected = true;
            for (const handler of handlersByEvent.get('connect') ?? []) {
                handler();
            }
        }),
        disconnect: vi.fn(() => {
            socket.connected = false;
            for (const handler of handlersByEvent.get('disconnect') ?? []) {
                handler('io client disconnect');
            }
        }),
        removeAllListeners: vi.fn(() => {
            handlersByEvent.clear();
        }),
        __emit(event: string, ...args: any[]) {
            for (const handler of handlersByEvent.get(event) ?? []) {
                handler(...args);
            }
        },
    };
    return socket;
}

describe('createSyncSocketTransport', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('forwards socket error events to transport.onError listeners', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        const errorListener = vi.fn();
        transport.onError(errorListener);

        const error = new Error('boom');
        socket.__emit('error', error);

        expect(errorListener).toHaveBeenCalledWith(error);
    });

    it('disconnects the underlying socket when transport.destroy is called', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        const { transport } = createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
        });

        const disconnectedListener = vi.fn();
        transport.onDisconnected(disconnectedListener);

        await transport.connect();
        expect(socket.connected).toBe(true);

        await transport.destroy();

        expect(socket.disconnect).toHaveBeenCalledTimes(1);
        expect(socket.connected).toBe(false);
        expect(disconnectedListener).not.toHaveBeenCalled();
    });
});
