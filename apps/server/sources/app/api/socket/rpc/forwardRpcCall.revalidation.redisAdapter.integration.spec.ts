import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { holdRedisAdapterDiscoveryRequests, startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { buildRpcMethodRoom } from './rpcMethodRoom';
import { createLiveApprovalOriginTargetGuard } from './liveApprovalOrigin';
import { createProtectedRawSessionTargetGuard } from './protectedRawSessionTargetGuard';
import { forwardRpcCall } from './forwardRpcCall';

describe('RPC target revalidation across real Redis adapters', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>> | undefined;
    let held: ReturnType<typeof holdRedisAdapterDiscoveryRequests> | undefined;
    const clients: ClientSocket[] = [];

    afterEach(async () => {
        held?.release();
        held = undefined;
        vi.restoreAllMocks();
        for (const client of clients.splice(0)) client.disconnect();
        await cluster?.close();
    });

    it.each(['approval', 'protected-session'] as const)('preserves a %s revalidation timeout as unavailable while keeping a real refusal forbidden', async kind => {
        cluster = await startRedisAdapterRecoveryCluster();
        const [source, destination] = cluster.nodes;
        const userId = 'revalidation-account';
        const sessionId = 'revalidation-session';
        const method = kind === 'approval' ? 'approval-origin.revalidation:approval.origin.decide'
            : `${sessionId}:${RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE}`;
        async function connectTo(node: NonNullable<typeof source>) {
            const joined = new Promise<Socket>(resolve => node.io.once('connection', resolve));
            const client = connect(`http://127.0.0.1:${node.port}`, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
            });
            clients.push(client);
            return { client, socket: await joined };
        }
        const caller = await connectTo(source!);
        const origin = await connectTo(destination!);
        caller.socket.data = { clientType: 'user-scoped' };
        origin.socket.data = kind === 'approval' ? { clientType: 'user-scoped', authTokenKind: 'account' }
            : { clientType: 'session-scoped', userId, sessionScopedBinding: {
                sessionId, machineId: 'revalidation-machine', proof: 'machine-access-key',
            } };
        await origin.socket.join(buildRpcMethodRoom({ userId, method }));
        const requests: unknown[] = [];
        origin.client.on(SOCKET_RPC_EVENTS.REQUEST, (request: unknown) => requests.push(request));

        // Delay only the exact-socket lookup at the upstream adapter boundary.
        // Initial method discovery still traverses the real Redis transport.
        const adapter = source!.io.sockets.adapter;
        const fetch = adapter.fetchSockets.bind(adapter);
        const lookup = vi.spyOn(adapter, 'fetchSockets').mockImplementation(options => {
            if (options.rooms.has(origin.socket.id) && !held) {
                held = holdRedisAdapterDiscoveryRequests(destination!.io);
            }
            return fetch(options);
        });
        const targetGuard = kind === 'approval' ? createLiveApprovalOriginTargetGuard({ userId, socket: caller.socket })
            : createProtectedRawSessionTargetGuard({ method, actorAccountId: userId, targetUserId: userId,
                callerSocket: caller.socket, callerAuthority: 'present_user', knownSessionSource: false })?.targetGuard;
        if (!targetGuard) throw new Error('Expected the protected method to have a target guard');
        const forward = () => forwardRpcCall({ io: source!.io, targetUserId: userId, method,
            callParams: {}, callerSocketId: caller.socket.id,
            ...(kind === 'approval' ? { answeringClient: { requireSingle: true } } : {}),
            targetGuard,
        });

        expect(await forward()).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            failureCause: { phase: 'rpc.target.revalidation', errorCode: 'ETIMEDOUT' } });
        expect(held?.count).toBeGreaterThan(0);
        expect(requests).toEqual([]);
        held?.release();
        held = undefined;
        lookup.mockRestore();

        // Healthy lookup reaches the guard's real authority/binding refusal.
        if (kind === 'protected-session') origin.socket.data.sessionScopedBinding.proof = 'owner-session';
        expect(await forward()).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(requests).toEqual([]);
    });
});
