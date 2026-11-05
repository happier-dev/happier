import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Socket } from 'socket.io';
import { vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { getMachineSocketRoom, getUserMachinesSocketRoom } from '@/app/api/socketRooms';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { db } from '@/storage/db';
import { buildRpcMethodRoom } from '@/app/api/socket/rpc/rpcMethodRoom';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createLightSqliteHarness } from './lightSqliteHarness';
import { holdRedisAdapterDiscoveryRequests, startRedisAdapterRecoveryCluster } from './redisAdapterRecoveryCluster';

/** Real Home transport and admission beneath a caller's HTTP/auth boundary fixture. */
export async function startExplicitSessionStopRedisServer(input: {
    targetNode: 0 | 1;
    installed: boolean;
    accountId?: string;
    machineId?: string;
    sessionId?: string;
}) {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-stop-redis-',
        initAuth: false, initEncrypt: false, initFiles: false });
    const cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 }).catch(async error => {
        await harness.close();
        throw error;
    });
    const held = holdRedisAdapterDiscoveryRequests(cluster.nodes[2]!.io);
    // A composed UI test can mock cold sockets for other Homes; these exact loopback transports stay real.
    const { io: connect } = await vi.importActual<typeof import('socket.io-client')>('socket.io-client');
    const clients: ReturnType<typeof connect>[] = [];
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => {
        held.release();
        for (const client of clients) client.disconnect();
        try {
            await cluster.close();
        } finally {
            await harness.close();
        }
    })();
    try {
        const owner = await db.account.create({ data: { ...(input.accountId ? { id: input.accountId } : {}), encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: {} });
        const machineId = input.machineId ?? randomUUID();
        const installationId = input.installed ? randomUUID() : undefined;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, active: true,
            ...(installationId ? { installationId } : {}),
            metadata: encodePlainMachineStoredContent({ host: 'stop-worker', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: Buffer.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        const session = await db.session.create({ data: { ...(input.sessionId ? { id: input.sessionId } : {}),
            accountId: owner.id, tag: randomUUID(), metadata: '{}' } });
        const foreignSession = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: 'encrypted' } });
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({ socket: {},
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        if (registered.status !== 'registered') throw new Error('Session publisher was not admitted');
        const destination = cluster.nodes[input.targetNode]!;
        const targetConnected = once(destination.io, 'connection');
        const target = connect(`http://127.0.0.1:${destination.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true });
        clients.push(target);
        const [targetSocket] = await targetConnected as [Socket];
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        ).evaluation;
        targetSocket.data = { clientType: 'machine-scoped', userId: owner.id, machineId,
            ...(installationId ? { verifiedMachineInstallationId: installationId } : {}),
            accountStoredContentCompatibility: compatibility };
        await targetSocket.join(getUserMachinesSocketRoom(owner.id));
        await targetSocket.join(getMachineSocketRoom(owner.id, machineId));
        const method = `${machineId}:${RPC_METHODS.STOP_SESSION}`;
        await targetSocket.join(buildRpcMethodRoom({ userId: owner.id, method }));
        // The external daemon acknowledges a confirmed stop; no operating-system process is killed.
        const stop = vi.fn((_request: unknown, acknowledge: (value: unknown) => void) => acknowledge({
            v: 1, result: { status: 'stopped' }, acknowledgement: { kind: 'session.stop', status: 'stopped' } }));
        target.on(SOCKET_RPC_EVENTS.REQUEST, stop);
        const source = cluster.nodes[0];
        source.io.once('connection', socket => {
            // Authentication is the external trust boundary; Session and current-Machine admission stay real.
            socket.data = { clientType: 'user-scoped', authAuthority: 'present_user', authTokenAuthenticationEvidence: [],
                accountStoredContentCompatibility: compatibility };
            registerSocketRpcHandlers({ userId: owner.id, socket, io: source.io, sessionPublisherPresence: presence });
        });
        const caller = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true });
        clients.push(caller);
        await new Promise<void>(resolve => caller.once('connect', () => resolve()));
        return {
            sessionId: session.id, foreignSessionId: foreignSession.id, machineId, method,
            installationId, targetSocket, stop,
            get heldCount() { return held.count; },
            call: (payload: unknown): Promise<unknown> => caller.emitWithAck(SOCKET_RPC_EVENTS.CALL, payload),
            readSessionActive: async () => (await db.session.findUniqueOrThrow({
                where: { id: session.id }, select: { active: true },
            })).active,
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}
