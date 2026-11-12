import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { AccountEncryptionMaterialUnavailableError } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { bindSocketErrorToRealtimeStore } from '@/sync/runtime/connectivity/bindSocketErrorToRealtimeStore';
import { storage } from '@/sync/domains/state/storage';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { apiSocket } from './apiSocket';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

// Only Socket.IO is mocked. Reachability uses real HTTP and the UI's error projection stays real.
const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));
const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
});
let endpoint: string;
const subscriptions: Array<() => unknown> = [];
beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback HTTP address');
    endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    apiSocket.disconnect();
    await (await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')).resetServerReachabilitySupervisors();
    storage.getState().setSocketError(null);
    storage.getState().clearSyncError();
    io.mockReset();
});
afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function boot() {
    const boundary = createSocketIoBoundaryStub();
    io.mockReturnValue(boundary.socket);
    const credentials = { token: 'handler-test-token' };
    apiSocket.initialize({ endpoint, token: credentials.token,
        request: createServerFetchAtEndpoint({ endpointUrl: endpoint, credentials }) }, null);
    await vi.waitFor(() => expect(boundary.socket.connected).toBe(true));
    subscriptions.push(bindSocketErrorToRealtimeStore(apiSocket.onError));
    return boundary;
}

describe('ApiSocket owns asynchronous subscriber failures', () => {
    it.each([
        { kind: 'typed', channel: 'update' }, { kind: 'untyped', channel: 'update' },
        { kind: 'typed', channel: 'reconnect' }, { kind: 'typed', channel: 'live-stream' },
    ] as const)('publishes a $kind $channel rejection through the existing UI error channel without an uncaught rejection', async ({ kind, channel }) => {
        const { trigger } = await boot();
        const error = kind === 'typed' ? new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired')
            : new Error('Unexpected update handler failure');
        const release = createDeferred<void>();
        const errors: Array<Error | null> = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        subscriptions.push(apiSocket.onError(value => { errors.push(value); }));
        const reject = async () => { await release.promise; throw error; };
        subscriptions.push(channel === 'reconnect' ? apiSocket.onReconnected(reject)
            : channel === 'live-stream' ? apiSocket.onMachineLiveStreamRelayEnvelope(reject)
                : apiSocket.onMessage('update', reject));
        process.on('unhandledRejection', onUnhandled);
        try {
            if (channel === 'reconnect') {
                trigger('disconnect', 'transport close');
                trigger('connect');
            } else if (channel === 'live-stream') {
                trigger(MACHINE_LIVE_STREAM_SOCKET_EVENT, { v: 1, sourceMachineId: 'source', targetMachineId: 'viewer',
                    message: { kind: 'control', control: { v: 1, streamId: 'stream', kind: 'stop' } } });
            } else trigger('update', { id: 'conversion-update' });
            release.resolve();
            await setImmediate();
            await vi.waitFor(() => expect(errors).toContain(error));
            expect(storage.getState().syncError).toMatchObject({ source: 'socket', message: error.message });
            expect(unhandled).toEqual([]);
        } finally { process.off('unhandledRejection', onUnhandled); }
    });
});
