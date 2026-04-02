import { afterEach, describe, expect, it, vi } from 'vitest';

type SocketHandler = (...args: any[]) => void;

vi.mock('@/sync/runtime/socketIoTransports', () => ({
    resolveSocketIoTransports: () => undefined,
}));

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
            if (!wasConnected) return;
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

describe('createConcurrentServerSocketTransport', () => {
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

        const { createConcurrentServerSocketTransport } = await import('./createConcurrentServerSocketTransport');
        createConcurrentServerSocketTransport({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
        });

        expect(ioSpy).toHaveBeenCalledWith(
            'https://api.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                    clientPurpose: 'concurrent-server-cache',
                }),
                forceNew: true,
                multiplex: false,
                reconnection: false,
                withCredentials: false,
                autoConnect: false,
            }),
        );
    });

    it('disconnects and clears onAny listeners when transport.destroy is called', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => socket),
        }));

        const { createConcurrentServerSocketTransport } = await import('./createConcurrentServerSocketTransport');
        const { transport } = createConcurrentServerSocketTransport({
            serverUrl: 'https://api.example.test',
            token: 'token-a',
        });

        await transport.connect();
        expect(socket.connected).toBe(true);

        await transport.destroy();

        expect(socket.offAny).toHaveBeenCalledTimes(1);
        expect(socket.disconnect).toHaveBeenCalledTimes(1);
        expect(socket.connected).toBe(false);
    });
});
