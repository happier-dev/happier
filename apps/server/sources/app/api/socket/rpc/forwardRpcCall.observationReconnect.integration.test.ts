import { once } from 'node:events';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isSocketIoAckTimeoutError } from '@happier-dev/protocol/rpcErrors';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import { waitForExecutionRunTerminal } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { reloadConfiguration } from '../../../../../../cli/src/configuration';
import { withUserScopedRpcSocket, readRpcObservation } from '../../../../../../cli/src/session/transport/rpc/withUserScopedRpcSocket';
import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';

// Persistence and metrics are external boundaries; observation, relay, discovery,
// both adapter nodes and the daemon dispatcher remain real.
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst: vi.fn() } } }));
vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(), observeRpcTargetLookup: vi.fn(), recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(), recordRpcSelfCallRejection: vi.fn(), recordSocketClusterFetchSockets: vi.fn(),
}));

describe('CLI Run observation across target reconnect', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;
    const clients: ClientSocket[] = [];
    beforeAll(async () => {
        vi.stubEnv('HAPPIER_SOCKET_TRANSPORTS', 'websocket');
        reloadConfiguration();
        cluster = await startRedisAdapterRecoveryCluster();
    });
    afterAll(async () => { await cluster?.close(); vi.unstubAllEnvs(); reloadConfiguration(); });
    afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); });

    it.each(['control', 'reconnect', 'finished-offline', 'never-returns'] as const)('%s preserves the caller observation', async scenario => {
        const [source, destination] = cluster.nodes;
        const sessionId = `wait-${scenario}`;
        const method = SESSION_RPC_METHODS.EXECUTION_RUN_WAIT;
        const scopedMethod = `${sessionId}:${method}`;
        let finish!: () => void;
        const terminal = new Promise<void>(resolve => { finish = resolve; });
        let status = 'running';
        let observed!: () => void;
        const firstObservation = new Promise<void>(resolve => { observed = resolve; });
        const issuedBudgets: Array<number | null | undefined> = [];
        const manager = new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain', logger() {} });
        manager.registerHandler(method, async (_request, context) => {
            observed();
            return waitForExecutionRunTerminal({ runId: 'retained-run', timeoutMs: null, signal: context?.signal,
                readRun: async () => ({ ok: true as const, data: { run: { runId: 'retained-run', status } } }),
                waitForTerminal: async () => terminal });
        });
        async function target() {
            const accepted = once(destination.io, 'connection');
            const client = connect(`http://127.0.0.1:${destination.port}`, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
            });
            clients.push(client);
            const [socket] = await accepted as [Socket];
            client.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, ack) => {
                issuedBudgets.push(request.timeoutMs);
                void manager.handleRequest(request, ack);
            });
            await socket.join(buildRpcMethodRoom({ userId: 'account-one', method: scopedMethod }));
            return { client, socket };
        }
        const original = await target();
        const relay = (socket: Socket) => socket.on(SOCKET_RPC_EVENTS.CALL,
            async (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
                ack(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, callerSocketId: socket.id, timeoutMs: request.timeoutMs }));
            });
        source.io.on('connection', relay);
        const timeoutMs = scenario === 'never-returns' ? 500 : scenario === 'reconnect' ? null : 5_000;
        const pending = withUserScopedRpcSocket({ token: 'fixture', serverUrl: `http://127.0.0.1:${source.port}`,
            connectTimeoutMs: 5_000, disconnectMessage: 'Caller disconnected' }, async (socket, ready) => {
            await ready();
            return readRpcObservation({ request: { runId: 'retained-run' }, observation: {}, read: request => callSocketRpc({
                socket, target: { kind: 'session', id: sessionId }, method, params: request,
                content: { mode: 'plain' }, timeoutMs,
            }) });
        });
        // Attach rejection handling before deliberately breaking the transport.
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        try {
            await Promise.race([firstObservation, outcome.then(result => {
                if ('error' in result) throw result.error;
                throw new Error('Wait returned before the daemon observed the Run');
            })]);
            if (scenario !== 'control') {
                const disconnected = once(original.socket, 'disconnect');
                original.client.disconnect();
                await disconnected;
                if (scenario === 'finished-offline') {
                    status = 'succeeded'; finish();
                    // Spend part of the caller's budget with no registered target.
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (scenario !== 'never-returns') await target();
            }
            if (scenario !== 'never-returns') { status = 'succeeded'; finish(); }
            const result = await outcome;
            if (scenario === 'finished-offline') {
                expect(issuedBudgets).toHaveLength(2);
                expect(issuedBudgets[1]).toBeLessThan(Number(issuedBudgets[0]) - 50);
            }
            if (scenario === 'never-returns') {
                expect(result).toHaveProperty('error');
                if ('error' in result) expect(isSocketIoAckTimeoutError(result.error)).toBe(true);
            } else {
                expect(result).toMatchObject({ value: { ok: true, status: 'succeeded', result: { run: { runId: 'retained-run' } } } });
            }
        } finally {
            finish();
            source.io.off('connection', relay);
            await outcome;
        }
    });
});
