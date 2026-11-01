import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { callSocketRpc } from '@happier-dev/sync-client';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../../../../../../cli/src/api/encryption';
import { isMachineDaemonRpcUnsupportedError } from '../../../../../../ui/sources/sync/domains/machines/machineDaemonRpcErrors';
import { db } from '@/storage/db';
import { getMachineSocketRoom } from '../../socketRooms';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

// Only persistence and metrics are external boundaries. The shared UI client,
// Home relay, Redis adapters and daemon handler manager all run their real logic.
vi.mock('@/storage/db', () => ({ db: { machine: { findFirst: vi.fn() } } }));
vi.mock('@/app/monitoring/metrics/index', () => ({
    observeRpcCall: vi.fn(), observeRpcTargetLookup: vi.fn(), recordRpcCallFailure: vi.fn(),
    recordRpcMethodNotAvailable: vi.fn(), recordRpcSelfCallRejection: vi.fn(), recordSocketClusterFetchSockets: vi.fn(),
    recordRpcRegistration: vi.fn(), recordRpcUnregistration: vi.fn(),
}));

import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';

describe('client to daemon RPC reply delivery across Redis adapter nodes', () => {
    let cluster: Awaited<ReturnType<typeof startRedisAdapterRecoveryCluster>>;
    const clients: ClientSocket[] = [];
    beforeAll(async () => { cluster = await startRedisAdapterRecoveryCluster(); });
    afterAll(async () => { await cluster?.close(); });
    afterEach(() => { for (const client of clients.splice(0)) client.disconnect(); });

    async function fixture(destinationIndex: 0 | 1 = 1) {
        const source = cluster.nodes[0];
        const destination = cluster.nodes[destinationIndex];
        const accepted = once(destination.io, 'connection');
        const target = connect(`http://127.0.0.1:${destination.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(target);
        await new Promise<void>(resolve => target.once('connect', resolve));
        const [targetSocket] = await accepted as [Socket];
        const method = `machine-${target.id}:plugin.delivery.read`;
        await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method }));
        return { source, target, targetSocket, method };
    }

    it.each(['plain', 'e2ee'] as const)('delivers Describe before a held sibling RPC on the same %s client and daemon sockets', async mode => {
        const { source, target, targetSocket, method } = await fixture();
        const machineId = method.slice(0, method.indexOf(':'));
        const describeMethod = RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE;
        const heldMethod = 'execution.run.start';
        for (const name of [describeMethod, heldMethod]) {
            await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method: `${machineId}:${name}` }));
        }
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let received!: () => void;
        const admitted = new Promise<void>(resolve => { received = resolve; });
        const key = randomBytes(32);
        const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: mode,
            ...(mode === 'e2ee' ? { encryptionKey: key, encryptionVariant: 'dataKey' as const } : {}), logger() {} });
        manager.registerHandler(heldMethod, async () => { received(); await held; return { completed: 'held' }; });
        manager.registerHandler(describeMethod, () => ({ completed: 'describe' }));
        target.on(SOCKET_RPC_EVENTS.REQUEST, (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
            void manager.handleRequest(request, ack);
        });
        const relay = (socket: Socket) => socket.on(SOCKET_RPC_EVENTS.CALL,
            async (request: SocketRpcRequestPayload, ack: (value: unknown) => void) => {
                ack(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, callerSocketId: socket.id, timeoutMs: null }));
            });
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        const content = mode === 'plain' ? { mode: 'plain' as const } : { mode: 'e2ee' as const, cipher: {
            encryptRaw: async (value: unknown) => encodeBase64(encrypt(key, 'dataKey', value)),
            decryptRaw: async (value: string) => decrypt(key, 'dataKey', decodeBase64(value)),
        } };
        const call = (name: string) => callSocketRpc({ socket: ui, target: { kind: 'machine', id: machineId },
            method: name, params: {}, content, timeoutMs: null });
        let completed = false;
        let long: Promise<unknown> | undefined;
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            long = call(heldMethod).then(result => { completed = true; return result; });
            await admitted;
            // No elapsed-time assertion: the held daemon handler cannot finish
            // until after this independent response crosses both real sockets.
            await expect(call(describeMethod)).resolves.toEqual({ completed: 'describe' });
            expect(completed).toBe(false);
            release();
            await expect(long).resolves.toEqual({ completed: 'held' });
        } finally {
            release();
            ui.disconnect();
            await long?.catch(() => {});
            source.io.off('connection', relay);
        }
    });

    it.each(['Home', 'daemon'] as const)('delivers binding status and preserves the %s timeout code through the real client codec', async origin => {
        const { source, target, targetSocket, method: fixtureMethod } = await fixture(0);
        const machineId = fixtureMethod.slice(0, fixtureMethod.indexOf(':'));
        const rpcMethod = RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS;
        const method = `${machineId}:${rpcMethod}`;
        await targetSocket.leave(buildRpcMethodRoom({ userId: 'account-one', method: fixtureMethod }));
        await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method }));
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let hold = true;
        const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger() {} });
        manager.registerHandler(rpcMethod, async (_input, context) => {
            if (hold && origin === 'daemon') await new Promise<void>((_resolve, reject) => {
                if (!context) throw new Error('Missing handler lifetime');
                if (context.signal.aborted) reject(context.signal.reason);
                else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
            });
            else if (hold) await pending;
            return { status: 'current' };
        });
        target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            // Control the daemon deadline independently of the Home ACK clock so
            // this case proves the inner error survives, without a timer race.
            acknowledge(await manager.handleRequest(origin === 'daemon' && hold ? { ...request, timeoutMs: 1 } : request));
        });
        const relay = (socket: Socket) => socket.on(SOCKET_RPC_EVENTS.CALL,
            async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                // The Home deadline is the controlled transport boundary; the
                // client stays alive to consume its actual error envelope.
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one',
                    method: request.method, callParams: request.params, timeoutMs: hold && origin === 'Home' ? 10 : null, callerSocketId: socket.id }));
            });
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        const call = () => callSocketRpc({ socket: ui, target: { kind: 'machine', id: machineId },
            method: rpcMethod, params: {}, content: { mode: 'plain' }, timeoutMs: null });
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            if (origin === 'Home') {
                expect(await call().catch((error: unknown) => error)).toMatchObject({ rpcErrorCode: 'MACHINE_RPC_TIMEOUT' });
            } else {
                await expect(call()).resolves.toEqual({ error: 'RPC request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' });
            }
            hold = false;
            release();
            await expect(call()).resolves.toEqual({ status: 'current' });
        } finally { release(); source.io.off('connection', relay); }
    });

    it('distinguishes a connected predecessor missing a method from failed discovery and recovers through real forwarding', async () => {
        const { source, target, targetSocket, method } = await fixture();
        const machineId = method.slice(0, method.indexOf(':'));
        const methodRoom = buildRpcMethodRoom({ userId: 'account-one', method });
        const machineRoom = getMachineSocketRoom('account-one', machineId);
        // cli-v0.2.16 / cli-v0.2.16-preview.1, b8d1c449c46ab4dfa8637db36b66f643d149e66d:
        // createMachineSocketTransport.ts authenticates the Machine; RpcHandlerManager.ts
        // registers only installed handlers with { method: `${scopePrefix}:${method}` }.
        // Such a daemon joins its Machine room but never the absent method's room.
        targetSocket.data = { clientType: 'machine-scoped', machineId };
        vi.mocked(db.machine.findFirst).mockResolvedValue({ revokedAt: null, replacedByMachineId: null } as Awaited<ReturnType<typeof db.machine.findFirst>>);
        await targetSocket.join(machineRoom);
        await targetSocket.leave(methodRoom);
        registerSocketRpcHandlers({ userId: 'account-one', socket: targetSocket, io: cluster.nodes[1].io });
        const register = async (method: string) => {
            const registered = once(target, SOCKET_RPC_EVENTS.REGISTERED);
            target.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
        };
        await register(`${machineId}:capabilities.describe`);
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, callerSocketId: socket.id }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        const call = () => callSocketRpc({ socket: ui, target: { kind: 'machine', id: machineId },
            method: 'plugin.delivery.read', params: {}, content: { mode: 'plain' } });
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            const missing = await call().catch((error: unknown) => error);
            expect(missing).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
            expect(isMachineDaemonRpcUnsupportedError(missing)).toBe(true);

            // Cluster transport is the only discovery mock; keep selection and forwarding real.
            const discovery = vi.spyOn(source.io.of('/').adapter, 'fetchSockets').mockRejectedValue(new Error('cluster timeout'));
            try {
                const unavailable = await call().catch((error: unknown) => error);
                expect(unavailable).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
                expect(isMachineDaemonRpcUnsupportedError(unavailable)).toBe(false);
            } finally {
                discovery.mockRestore();
            }
            await targetSocket.leave(machineRoom);
            const disconnected = await call().catch((error: unknown) => error);
            expect(disconnected).toMatchObject({ rpcErrorCode: 'target_unavailable' });
            expect(isMachineDaemonRpcUnsupportedError(disconnected)).toBe(false);

            await targetSocket.join(machineRoom);
            await register(method);
            target.on(SOCKET_RPC_EVENTS.REQUEST, (_request: unknown, acknowledge: (value: unknown) => void) => acknowledge({ recovered: true }));
            await targetSocket.leave(methodRoom);
            const lostRoom = await call().catch((error: unknown) => error);
            expect(lostRoom).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
            expect(isMachineDaemonRpcUnsupportedError(lostRoom)).toBe(false);
            await targetSocket.join(methodRoom);
            await expect(call()).resolves.toEqual({ recovered: true });
        } finally {
            source.io.off('connection', relay);
            vi.mocked(db.machine.findFirst).mockReset();
        }
    });

    it.each(['capabilities.describe', 'plugin.delivery.read'])(
        'delivers a local Machine %s reply while cluster discovery is unavailable', async rpcMethod => {
            const { source, target, targetSocket, method: fixtureMethod } = await fixture(0);
            const machineId = fixtureMethod.slice(0, fixtureMethod.indexOf(':'));
            const method = `${machineId}:${rpcMethod}`;
            targetSocket.data = { clientType: 'machine-scoped', machineId };
            vi.mocked(db.machine.findFirst).mockResolvedValue({ revokedAt: null, replacedByMachineId: null } as Awaited<ReturnType<typeof db.machine.findFirst>>);
            await targetSocket.leave(buildRpcMethodRoom({ userId: 'account-one', method: fixtureMethod }));
            await targetSocket.join(buildRpcMethodRoom({ userId: 'account-one', method }));
            const manager = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger() {} });
            manager.registerHandler(rpcMethod, (value: unknown) => ({ echoed: value }));
            target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await manager.handleRequest(request));
            });
            const census = vi.spyOn(source.io.of('/').adapter, 'fetchSockets')
                .mockRejectedValue(new Error('timeout reached: only 1 responses received out of 2'));
            const relay = (socket: Socket) => {
                socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                    acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                        callParams: request.params, callerSocketId: socket.id }));
                });
            };
            source.io.on('connection', relay);
            const ui = connect(`http://127.0.0.1:${source.port}`, {
                path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
            });
            clients.push(ui);
            try {
                await new Promise<void>(resolve => ui.once('connect', resolve));
                await expect(callSocketRpc({ socket: ui, target: { kind: 'machine', id: machineId },
                    method: rpcMethod, params: { probe: rpcMethod }, content: { mode: 'plain' } }))
                    .resolves.toEqual({ echoed: { probe: rpcMethod } });
                expect(census).not.toHaveBeenCalled();
            } finally {
                source.io.off('connection', relay);
                census.mockRestore();
                vi.mocked(db.machine.findFirst).mockReset();
            }
        },
    );

    it('delivers the exact daemon reply without waiting for unrelated cluster client counts', async () => {
        const { source, target, method } = await fixture();
        const scopePrefix = method.slice(0, method.indexOf(':'));
        const manager = new RpcHandlerManager({ scopePrefix, encryptionMode: 'plain', logger() {} });
        const handled: unknown[] = [];
        manager.registerHandler('plugin.delivery.read', (value: unknown) => { handled.push(value); return { echoed: value }; });
        target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            acknowledge(await manager.handleRequest(request));
        });
        // A subscriber that is not an answering Socket.IO server reproduces the
        // observed cluster census mismatch without replacing discovery or ACK logic.
        const silentSubscriber = source.redis.duplicate();
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, timeoutMs: 400, callerSocketId: socket.id,
                    targetGuard: {
                        filterTargets: async targets => targets,
                        runOperation: async ({ operation }) => {
                            // Discovery completes before a nonparticipant joins the census.
                            await silentSubscriber.subscribe('socket.io#/#');
                            return { status: 'current', value: await operation() };
                        },
                    } }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true,
        });
        clients.push(ui);
        try {
            await new Promise<void>(resolve => ui.once('connect', resolve));
            const outcome = await callSocketRpc({ socket: ui, target: { kind: 'machine', id: scopePrefix },
                method: 'plugin.delivery.read', params: { probe: 'reply' }, content: { mode: 'plain' }, timeoutMs: 2_000 })
                .catch((error: unknown) => error);
            expect(handled).toEqual([{ probe: 'reply' }]);
            expect(outcome).toEqual({ echoed: { probe: 'reply' } });
        } finally {
            source.io.off('connection', relay);
            await silentSubscriber.quit();
        }
    });

    it('keeps an old reply bound to the disconnected caller when a new caller reconnects', async () => {
        const { source, target, method } = await fixture();
        const scopePrefix = method.slice(0, method.indexOf(':'));
        let releaseOld!: () => void;
        const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
        let receivedOld!: () => void;
        const oldReceived = new Promise<void>(resolve => { receivedOld = resolve; });
        const dataKey = new Uint8Array(32).fill(19);
        const manager = new RpcHandlerManager({ scopePrefix, encryptionMode: 'e2ee', encryptionKey: dataKey,
            encryptionVariant: 'dataKey', logger() {} });
        manager.registerHandler('plugin.delivery.read', async (value: unknown) => {
            if (value === 'old') { receivedOld(); await oldGate; }
            return { echoed: value };
        });
        target.on(SOCKET_RPC_EVENTS.REQUEST, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
            acknowledge(await manager.handleRequest(request));
        });
        const relay = (socket: Socket) => {
            socket.on(SOCKET_RPC_EVENTS.CALL, async (request: SocketRpcRequestPayload, acknowledge: (value: unknown) => void) => {
                acknowledge(await forwardRpcCall({ io: source.io, targetUserId: 'account-one', method: request.method,
                    callParams: request.params, timeoutMs: 2_000, callerSocketId: socket.id }));
            });
        };
        source.io.on('connection', relay);
        const ui = connect(`http://127.0.0.1:${source.port}`, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false,
        });
        clients.push(ui);
        const connectUi = async () => {
            const connected = new Promise<void>(resolve => ui.once('connect', resolve));
            ui.connect();
            await connected;
        };
        const call = (value: string) => callSocketRpc({ socket: ui, target: { kind: 'machine' as const, id: scopePrefix },
            method: 'plugin.delivery.read', params: value, content: { mode: 'e2ee' as const, cipher: {
                encryptRaw: async (value: unknown) => encodeBase64(encrypt(dataKey, 'dataKey', value)),
                decryptRaw: async (value: string) => decrypt(dataKey, 'dataKey', decodeBase64(value)),
            } }, timeoutMs: 2_000 });
        try {
            await connectUi();
            const oldId = ui.id;
            const oldOutcome = call('old').catch((error: unknown) => error);
            await oldReceived;
            ui.io.engine.close();
            expect(await oldOutcome).toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            await connectUi();
            expect(ui.id).not.toBe(oldId);
            const fresh = call('fresh');
            releaseOld();
            await expect(fresh).resolves.toEqual({ echoed: 'fresh' });
            await expect(call('next')).resolves.toEqual({ echoed: 'next' });
        } finally {
            releaseOld();
            source.io.off('connection', relay);
        }
    });

});
