import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitWithAckCancellable } from '@happier-dev/sync-client';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
// The connection owner and the scoped pool share one real module graph; only
// Socket.IO and HTTP bytes are replaced.
import '@/sync/api/session/apiSocket';

const ioSpy = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));
vi.mock('@/utils/system/runtimeFetch', () => {
    const mocked = {
        runtimeFetch: vi.fn(async () => new Response('{}', { status: 200 })),
        resetRuntimeFetch: () => {},
        setRuntimeFetch: () => {},
        get runtimeFetchManualResponse() { return this.runtimeFetch; },
    };
    return mocked;
});

const ENDPOINT = 'https://server.example.test/';
const tokenFor = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.signature`;

async function bootAccountSocket(token: string) {
    const main = createSocketIoBoundaryStub();
    ioSpy.mockImplementation(() => (ioSpy.mock.calls.length === 1 ? main.socket : createSocketIoBoundaryStub({ autoConnect: false }).socket));
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    apiSocket.initialize({ endpoint: ENDPOINT, token, serverId: 'socket-test-home', generation: 1 }, null);
    await vi.waitFor(() => expect(main.socket.connected).toBe(true));
    return { apiSocket, main };
}

describe('createEphemeralServerSocketClient', () => {
    afterEach(async () => {
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        apiSocket.disconnect();
        const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
        const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
        await resetServerReachabilitySupervisors();
        ioSpy.mockReset();
    });

    it('rides the connected Account socket for the same Home and bearer instead of opening a second one', async () => {
        const token = tokenFor('self');
        const { main } = await bootAccountSocket(token);
        main.socket.emitWithAck.mockResolvedValueOnce({ result: 'success', lastViewedSessionSeq: 4 });
        const { createEphemeralServerSocketClient } = await import('./createEphemeralServerSocketClient');

        const client = await createEphemeralServerSocketClient({ serverUrl: 'https://server.example.test', token, timeoutMs: 1_000 });
        const ack = await emitWithAckCancellable({ socket: client, event: 'update-read-cursor', payload: { sid: 's', lastViewedSessionSeq: 4 }, timeoutMs: null });
        client.disconnect();

        expect(ack).toEqual({ result: 'success', lastViewedSessionSeq: 4 });
        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(main.socket.emitWithAck).toHaveBeenCalledWith('update-read-cursor', { sid: 's', lastViewedSessionSeq: 4 });
    });

    it('stops serving a lent client once the Account socket is reconfigured, so the pin cannot move', async () => {
        const token = tokenFor('self');
        const { apiSocket } = await bootAccountSocket(token);
        const { createEphemeralServerSocketClient } = await import('./createEphemeralServerSocketClient');
        const client = await createEphemeralServerSocketClient({ serverUrl: ENDPOINT, token, timeoutMs: 1_000 });
        const onDisconnect = vi.fn();
        client.on('disconnect', onDisconnect);
        expect(client.connected).toBe(true);

        apiSocket.updateToken(tokenFor('other'));

        expect(client.connected).toBe(false);
        expect(client.getSocketId()).toBe('');
        await expect(emitWithAckCancellable({ socket: client, event: 'update-read-cursor', payload: {}, timeoutMs: null }))
            .rejects.toMatchObject({ rpcErrorCode: 'RPC_TRANSPORT_UNAVAILABLE' });
        client.disconnect();
    });

    it('keeps a separate pooled socket for another Account bearer', async () => {
        await bootAccountSocket(tokenFor('self'));
        const { createEphemeralServerSocketClient } = await import('./createEphemeralServerSocketClient');
        const controller = new AbortController();
        const pending = createEphemeralServerSocketClient({ serverUrl: ENDPOINT, token: tokenFor('another'), timeoutMs: 1_000, signal: controller.signal });
        await vi.waitFor(() => expect(ioSpy).toHaveBeenCalledTimes(2));
        controller.abort();
        await expect(pending).rejects.toBeDefined();
    });
});
