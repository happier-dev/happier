import { afterEach, describe, expect, it, vi } from 'vitest';

const ioSpy = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
    io: (...args: unknown[]) => ioSpy(...args),
}));

describe('createEphemeralServerSocketClient', () => {
    afterEach(() => {
        ioSpy.mockReset();
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
    });
});
