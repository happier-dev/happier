import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { SERVER_PEER_LIVENESS_WINDOW_MS } from '@/sync/runtime/connectivity/serverReachabilityTuning';

function createSocketStub() { return createSocketIoBoundaryStub().socket; }

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

        expect(socket.io.timeout()).toBe(SERVER_PEER_LIVENESS_WINDOW_MS);

        expect(ioSpy).toHaveBeenCalledWith(
            'https://api.example.test',
            expect.objectContaining({
                path: '/v1/updates/',
                auth: expect.objectContaining({
                    token: 'token-a',
                    clientType: 'user-scoped',
                    clientPurpose: 'concurrent-server-cache',
                    accountStoredContentCompatibility: {
                        v: 1,
                        protocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
                    },
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

    it('uses an Iroh runtime origin and forces websocket transport', async () => {
        vi.resetModules();
        const socket = createSocketStub();
        const ioSpy = vi.fn(() => socket);
        vi.doMock('socket.io-client', () => ({ io: ioSpy }));
        const { createConcurrentServerSocketTransport } = await import('./createConcurrentServerSocketTransport');
        createConcurrentServerSocketTransport({
            serverUrl: 'https://home.example',
            runtimeOrigin: 'http://127.0.0.1:4312/',
            carrier: 'iroh',
            token: 'token-a',
        });
        expect(ioSpy).toHaveBeenCalledWith('http://127.0.0.1:4312', expect.objectContaining({ transports: ['websocket'] }));
    });
});
