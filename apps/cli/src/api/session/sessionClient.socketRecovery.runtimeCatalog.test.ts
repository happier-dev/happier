import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { ApiSessionClient } from './sessionClient';
import { reloadConfiguration, configuration } from '@/configuration';
import { createSessionClientDurableMutationPersistenceContext } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { parseRuntimeSessionClientDurableMutation } from './client/transport/mutations/sessionClientDurableMutationPersistence';

describe('Session activity startup socket recovery', () => {
    const clients: ApiSessionClient[] = [];

    afterEach(async () => {
        await Promise.all(clients.splice(0).map((client) => client.close()));
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        reloadConfiguration();
    });

    function createClient(options: Readonly<{ durable?: boolean; sessionId?: string }> = {}) {
        let connect!: () => void;
        let connected = new Promise<void>((resolve) => { connect = resolve; });
        let onDisconnected: Parameters<ManagedConnectionTransport['onDisconnected']>[0] | undefined;
        const home = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: (event, payload) => home.answer(event, payload) ?? { ok: true },
        });
        // Only HTTP and Socket.IO boundaries are replaced; the reconnect,
        // readiness, Activity and disposal owners all remain real.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {} });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {}, capabilities: { session: {
                runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 },
                publisherAuthority: { protocolVersion: 1 },
            } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })));
        const client = new ApiSessionClient('test-token', createPlainSessionFixture({ id: options.sessionId ?? 'socket-recovery' }), {
            transport: {
                serverId: 'socket-recovery-test',
                serverUrl: 'http://127.0.0.1:3000',
                createSessionSocketTransport: () => ({
                    // The canonical testkit implements the Socket.IO boundary.
                    socket: socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>,
                    transport: {
                        connect: async () => { await connected; socket.connected = true; },
                        disconnect: async () => { socket.connected = false; },
                        destroy: async () => {},
                        isConnected: () => socket.connected,
                        onConnected: () => () => {},
                        onDisconnected: (listener) => { onDisconnected = listener; return () => { onDisconnected = undefined; }; },
                        onError: () => () => {},
                    },
                }),
            },
            metadataAuthority: { kind: 'owner', credentials: { token: 'test-token', encryption: null } },
            durableMutationDeliveryInitiallyActive: options.durable === true,
        });
        clients.push(client);
        return { client, socket, connect: () => connect(), goOffline: () => {
            connected = new Promise<void>((resolve) => { connect = resolve; });
            socket.connected = false;
            onDisconnected?.({ reason: 'transport close' });
        } };
    }

    it('keeps an Activity write pending beyond a transport attempt budget and applies it on recovery', async () => {
        vi.useFakeTimers();
        const { client, socket, connect } = createClient();
        let outcome = 'pending';
        const write = client.updateRuntimeActivityProjection({
            runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        });
        void write.then(() => { outcome = 'applied'; }, () => { outcome = 'rejected'; });
        await vi.advanceTimersByTimeAsync(resolveSessionControlSocketConnectTimeoutMs() + 1);
        expect(outcome).toBe('pending');
        expect(socket.emitWithAck.mock.calls.some(([event]) => event === 'session-runtime-activity-snapshot')).toBe(false);
        connect();
        await vi.advanceTimersByTimeAsync(0);
        await write;
        expect(outcome).toBe('applied');
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', expect.objectContaining({
            sessionId: 'socket-recovery', snapshot: { state: 'active', activeCount: 1 },
        }));
    });

    it('cancels an offline Activity waiter when its Session is closed', async () => {
        const { client } = createClient();
        const write = client.updateRuntimeActivityProjection({
            runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0,
        });
        const rejected = expect(write).rejects.toMatchObject({ code: 'session_closed', retryable: false });
        await client.close();
        clients.splice(clients.indexOf(client), 1);
        await rejected;
    });

    it('closes offline durable Activity delivery while retaining its journal for recovery', async () => {
        const taskHome = await mkdtemp(join(tmpdir(), 'happier-gq-offline-close-'));
        vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
        reloadConfiguration();
        const sessionId = 'durable-offline-close';
        const { client, socket, connect, goOffline } = createClient({ durable: true, sessionId });
        connect();
        await client.enqueueRegisteredSessionStateFieldMutation({
            v: 1, sessionId, mutationId: 'activity-online', fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort', source: 'runtime', observedAt: 1,
            op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
        });
        goOffline();
        const mutation = {
            v: 1 as const, sessionId, mutationId: 'activity-offline', fieldId: 'runtime.activity' as const,
            deliveryClass: 'durable_best_effort' as const, source: 'runtime' as const, observedAt: 2,
            op: { kind: 'set' as const, value: { state: 'unknown', activeCount: 0 } },
        };
        const write = client.enqueueRegisteredSessionStateFieldMutation(mutation);
        // Observe real admission on disk before asking close to drain it.
        const persistence = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId,
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        await expect.poll(async () => {
            try { return await readFile(persistence.paths.queuePath, 'utf8'); } catch { return ''; }
        }).toContain('activity-offline');
        let writeOutcome = 'pending';
        void write.then(() => { writeOutcome = 'applied'; }, () => { writeOutcome = 'cancelled'; });
        try {
            await client.close();
            clients.splice(clients.indexOf(client), 1);
            expect(writeOutcome).toBe('cancelled');
            const journal = JSON.parse(await readFile(persistence.paths.queuePath, 'utf8')) as { mutations: unknown[] };
            expect(journal.mutations).toEqual(expect.arrayContaining([expect.objectContaining({ payload: mutation })]));
            expect(socket.connected).toBe(false);
        } finally {
            // Let an intentionally failing RED finish its owned offline waiter.
            connect();
        }
    });
});
