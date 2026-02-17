import { afterEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
    io: (...args: unknown[]) => ioSpy(...args),
}));

describe('createEphemeralServerSocketClient', () => {
    const previousForceWebsocket = process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;

    afterEach(() => {
        ioSpy.mockReset();
        vi.resetModules();
        if (previousForceWebsocket === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET;
        else process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = previousForceWebsocket;
    });

    it('connects with user-scoped auth and resolves when socket connects', async () => {
        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') cb();
            }),
            off: vi.fn(),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { createEphemeralServerSocketClient } = await import('./createEphemeralServerSocketClient');
        const socket = await createEphemeralServerSocketClient({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
        });

        expect(socket).toBe(fakeSocket);
        expect(ioSpy).toHaveBeenCalledWith(
            'https://server-b.example.test',
            expect.objectContaining({
                path: '/v1/updates',
                auth: expect.objectContaining({
                    token: 'token-b',
                    clientType: 'user-scoped',
                }),
            }),
        );
        const opts = ioSpy.mock.calls[0]?.[1] as any;
        expect(opts).not.toHaveProperty('transports');
    });

    it('can force websocket-only via config flag', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';

        const fakeSocket = {
            on: vi.fn((event: string, cb: () => void) => {
                if (event === 'connect') cb();
            }),
            off: vi.fn(),
            disconnect: vi.fn(),
        };
        ioSpy.mockReturnValue(fakeSocket);

        const { createEphemeralServerSocketClient } = await import('./createEphemeralServerSocketClient');
        await createEphemeralServerSocketClient({
            serverUrl: 'https://server-b.example.test',
            token: 'token-b',
            timeoutMs: 5000,
        });

        const opts = ioSpy.mock.calls[0]?.[1] as any;
        expect(opts.transports).toEqual(['websocket']);
    });
});
