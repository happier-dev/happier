import { afterEach, describe, expect, it, vi } from 'vitest';

type SocketHandler = (...args: any[]) => void;

function createSocketStub() {
    const handlersByEvent = new Map<string, Set<SocketHandler>>();
    const anyHandlers = new Set<SocketHandler>();
    const socket = {
        connected: false,
        on: vi.fn((event: string, handler: SocketHandler) => {
            const bucket = handlersByEvent.get(event) ?? new Set<SocketHandler>();
            bucket.add(handler);
            handlersByEvent.set(event, bucket);
            return socket;
        }),
        onAny: vi.fn((handler: SocketHandler) => {
            anyHandlers.add(handler);
            return socket;
        }),
        offAny: vi.fn(() => {
            anyHandlers.clear();
            return socket;
        }),
        connect: vi.fn(() => {
            socket.connected = true;
            for (const handler of handlersByEvent.get('connect') ?? []) {
                handler();
            }
        }),
        disconnect: vi.fn(() => {
            const wasConnected = socket.connected;
            socket.connected = false;
            if (!wasConnected) {
                return;
            }
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

    it('configures socket.io to avoid Manager cache retention', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        const ioSpy = vi.fn(() => socket);
        vi.doMock('socket.io-client', () => ({
            io: ioSpy,
        }));

        const { createSyncSocketTransport } = await import('./createSyncSocketTransport');
        createSyncSocketTransport({
            endpoint: 'https://api.example.test',
            token: 'token-a',
            transports: ['websocket'],
        });

        expect(ioSpy).toHaveBeenCalledWith(
            'https://api.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                    clientPurpose: 'sync',
                }),
                transports: ['websocket'],
                forceNew: true,
                multiplex: false,
                reconnection: false,
                withCredentials: false,
                autoConnect: false,
            }),
        );
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

    it('clears socket.onAny listeners when transport.destroy is called (prevents handler leaks across rebuilds)', async () => {
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

        await transport.destroy();

        expect(socket.offAny).toHaveBeenCalledTimes(1);
    });

    it('treats disconnect() while already disconnected as idempotent and does not poison the next disconnect', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        socket.disconnect.mockImplementation(() => {
            if (!socket.connected) {
                throw new Error('socket has been disconnected');
            }
            socket.connected = false;
            socket.__emit('disconnect', 'io client disconnect');
        });
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

        await expect(transport.disconnect({ intentional: true })).resolves.toBeUndefined();
        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(disconnectedListener).not.toHaveBeenCalled();

        await transport.connect();
        socket.__emit('disconnect', 'transport close');

        expect(disconnectedListener).toHaveBeenCalledWith(
            expect.objectContaining({ intentional: false }),
        );
    });
});
