import http from "node:http";

import { createAdapter } from "@socket.io/redis-streams-adapter";
import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from "@happier-dev/protocol/rpc/methods";
import { getMachineSocketRoom } from "../socketRooms";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startRedisAdapterRecoveryCluster, holdRedisAdapterDiscoveryRequests } from "@/testkit/redisAdapterRecoveryCluster";

import { readRedisStreamsAdapterOptionsFromEnv } from "@/config/socketAdapter";

import { resolveRedisAdapterValidationRedisUrl } from "../../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { registerSocketRpcHandlers } from "./rpc/registerSocketRpcHandlers";
import { buildRpcMethodRoom } from "./rpc/rpcMethodRoom";
import { registerSocketRoomDiscovery } from './socketRoomDiscovery';
import { forwardRpcCall } from './rpc/forwardRpcCall';
import { discoverRpcTargets } from './rpc/rpcTargetDiscovery';

const USER_ID = "user-redis-adapter";
const SOCKET_PATH = "/v1/updates";

function registerTestRpcHandlers(io: Server): void {
    io.on('connection', socket => {
        // This transport fixture supplies the identity normally admitted by startSocket.
        socket.data.authAuthority = 'present_user';
        socket.data.authTokenAuthenticationEvidence = [];
        registerSocketRpcHandlers({ userId: USER_ID, socket, io });
    });
}

type RedisMemoryInstance = Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

type StartedCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    redisA: Redis;
    redisB: Redis;
    redisMemory: RedisMemoryInstance;
    portA: number;
    portB: number;
    close: () => Promise<void>;
}>;

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address && typeof address === "object") {
        return address.port;
    }
    throw new Error("Failed to determine server port");
}

async function closeServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startCluster(): Promise<StartedCluster> {
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: process.env,
    });

    const redisA = new Redis(redisUrl);
    const redisB = new Redis(redisUrl);
    const httpA = http.createServer();
    const httpB = http.createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA, readRedisStreamsAdapterOptionsFromEnv({})),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB, readRedisStreamsAdapterOptionsFromEnv({})),
    });

    registerSocketRoomDiscovery(ioA);
    registerSocketRoomDiscovery(ioB);
    registerTestRpcHandlers(ioA);
    registerTestRpcHandlers(ioB);

    const portA = await listen(httpA);
    const portB = await listen(httpB);

    return {
        ioA,
        ioB,
        redisA,
        redisB,
        redisMemory,
        portA,
        portB,
        close: async () => {
            await ioA.close();
            await ioB.close();
            await closeServer(httpA);
            await closeServer(httpB);
            await redisA.quit();
            await redisB.quit();
            if (redisMemory) {
                await redisMemory.stop();
            }
        },
    };
}

async function connectClient(port: number): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 5_000,
    });

    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout connecting socket client on port ${port}`)), 6_000);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

    return socket;
}

async function emitWithAck<TResponse>(
    socket: ClientSocket,
    event: string,
    payload: unknown,
): Promise<TResponse> {
    return await new Promise<TResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ack for ${event}`)), 6_000);
        socket.emit(event, payload, (response: TResponse) => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

async function waitForEvent<TPayload>(socket: ClientSocket, event: string): Promise<TPayload> {
    return await new Promise<TPayload>((resolve) => {
        socket.once(event, (payload: TPayload) => resolve(payload));
    });
}

async function waitForCondition(
    predicate: () => Promise<boolean>,
    timeoutMs = 6_000,
    pollMs = 25,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error("Timed out waiting for condition");
}

describe("rpcHandler redis adapter integration", () => {
    const startedClusters: StartedCluster[] = [];
    const startedClients: ClientSocket[] = [];

    afterEach(async () => {
        while (startedClients.length > 0) {
            startedClients.pop()?.disconnect();
        }
        while (startedClusters.length > 0) {
            await startedClusters.pop()?.close();
        }
    });

    it('publishes effective UI availability across real Redis nodes without repeating unchanged owners', async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        await waitForCondition(async () => await cluster.ioA.sockets.adapter.serverCount() === 2);
        const observer = await connectClient(cluster.portA);
        const first = await connectClient(cluster.portA);
        const second = await connectClient(cluster.portB);
        startedClients.push(observer, first, second);
        const method = `availability-machine:${RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME}`;
        const machineRoom = getMachineSocketRoom(USER_ID, 'availability-machine');
        await cluster.ioA.sockets.sockets.get(observer.id!)!.join(machineRoom);
        const available: string[] = [];
        const unavailable: string[] = [];
        observer.on(SOCKET_RPC_EVENTS.REGISTERED, ({ method }: { method: string }) => available.push(method));
        observer.on(SOCKET_RPC_EVENTS.UNREGISTERED, ({ method }: { method: string }) => unavailable.push(method));
        const localBroadcast = vi.spyOn(cluster.ioA, 'to');
        const remoteBroadcast = vi.spyOn(cluster.ioB, 'to');
        const register = async (socket: ClientSocket) => {
            const ack = waitForEvent<{ method: string }>(socket, SOCKET_RPC_EVENTS.REGISTERED);
            socket.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(await ack).toEqual({ method });
        };
        try {
            await register(first);
            await vi.waitFor(() => expect(available).toEqual([method]));
            localBroadcast.mockClear();
            remoteBroadcast.mockClear();
            await register(first);
            await register(second);
            await register(second);
            const withdrawn = waitForEvent(first, SOCKET_RPC_EVENTS.UNREGISTERED);
            first.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method });
            await withdrawn;
            expect(localBroadcast.mock.calls.filter(([room]) => room === machineRoom)).toHaveLength(0);
            expect(remoteBroadcast.mock.calls.filter(([room]) => room === machineRoom)).toHaveLength(0);
            expect(available).toEqual([method]);
            expect(unavailable).toEqual([]);

            second.disconnect();
            await vi.waitFor(() => expect(unavailable).toEqual([method]));
            await register(first);
            await vi.waitFor(() => expect(available).toEqual([method, method]));
            // Finish the real withdrawal before closing its Redis transport.
            const restoredWithdrawn = waitForEvent(first, SOCKET_RPC_EVENTS.UNREGISTERED);
            first.emit(SOCKET_RPC_EVENTS.UNREGISTER, { method });
            await restoredWithdrawn;
            await vi.waitFor(() => expect(unavailable).toEqual([method, method]));
        } finally {
            localBroadcast.mockRestore();
            remoteBroadcast.mockRestore();
        }
    });

    it.each(['local', 'remote'] as const)('wakes a held single-client read once on %s registration through the real forwarding path', async placement => {
        const cluster = await startCluster();
        startedClusters.push(cluster);
        await waitForCondition(async () => await cluster.ioA.sockets.adapter.serverCount() === 2);
        const listener = await connectClient(placement === 'local' ? cluster.portA : cluster.portB);
        startedClients.push(listener);
        const method = 'agent.availabilityPush';
        const room = buildRpcMethodRoom({ userId: USER_ID, method });
        const fetch = cluster.ioA.sockets.adapter.fetchSockets.bind(cluster.ioA.sockets.adapter);
        let censusCalls = 0;
        let firstCensus!: () => void;
        const first = new Promise<void>(resolve => { firstCensus = resolve; });
        const spy = vi.spyOn(cluster.ioA.sockets.adapter, 'fetchSockets').mockImplementation(async options => {
            if (options.rooms.has(room)) censusCalls++;
            const result = await fetch(options);
            if (options.rooms.has(room)) firstCensus();
            return result;
        });
        const cancel = new AbortController();
        const pending = forwardRpcCall({ io: cluster.ioA, targetUserId: USER_ID, method, callParams: { probe: 'arrival' },
            answeringClient: { requireSingle: true },
            callerLifetime: { signal: cancel.signal, isCurrent: async () => true },
        });
        try {
            await first;
            await new Promise<void>(resolve => setTimeout(resolve, 100));
            expect(censusCalls).toBe(1);
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => respond(request.params));
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            await expect(pending).resolves.toMatchObject({ ok: true, result: { probe: 'arrival' } });
            expect(censusCalls).toBe(2);
        } finally {
            cancel.abort();
            await pending;
            spy.mockRestore();
        }
    });

    it('returns a typed uniqueness timeout without dispatch when an unrelated Redis peer is silent', async () => {
        const cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 });
        const [source, target, unrelated] = cluster.nodes;
        registerTestRpcHandlers(source.io);
        registerTestRpcHandlers(target.io);
        const caller = await connectClient(source.port);
        const listener = await connectClient(target.port);
        const held = holdRedisAdapterDiscoveryRequests(unrelated!.io);
        let executions = 0;
        try {
            const method = 'agent.uniqueDecision';
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (_request, respond) => {
                executions++;
                respond({ decided: true });
            });
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            const call = () => forwardRpcCall({ io: source.io, targetUserId: USER_ID, callerSocketId: caller.id,
                method, callParams: {}, answeringClient: { requireSingle: true } });
            const response = await call();
            expect(response).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                failureCause: { phase: 'rpc.discovery.global_uniqueness', errorClass: 'Error', errorCode: 'ETIMEDOUT', httpStatus: null } });
            if (response.ok) throw new Error('Expected the census to refuse dispatch');
            expect(createRpcCallError(response)).toMatchObject({ failureCause: expect.objectContaining({ errorCode: 'ETIMEDOUT' }) });
            expect(executions).toBe(0);
            held.release();
            expect(await call())
                .toMatchObject({ ok: true, result: { decided: true }, answeringClientId: listener.id });
            expect(executions).toBe(1);
        } finally {
            held.release();
            caller.disconnect();
            listener.disconnect();
            await cluster.close();
        }
    });

    it('waits the unchanged census window for a silent peer and removes closed peer subscriptions from membership', async () => {
        const cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 });
        const [source, healthy, silent] = cluster.nodes;
        const held = holdRedisAdapterDiscoveryRequests(silent!.io);
        try {
            const startedAt = Date.now();
            const discovery = discoverRpcTargets({ io: source.io, userId: USER_ID,
                method: 'agent.singleRead', answeringClient: { requireSingle: true }, fetchTimeoutMs: 150,
            });
            await held.received;
            expect(await discovery).toMatchObject({ targets: [], failureCause: { errorCode: 'ETIMEDOUT' } });
            const elapsedMs = Date.now() - startedAt;
            expect(elapsedMs).toBeGreaterThanOrEqual(150);
            expect(await source.io.sockets.adapter.serverCount()).toBe(3);
            await silent!.io.close();
            await waitForCondition(async () => await healthy.io.sockets.adapter.serverCount() === 2);
            expect(await source.io.sockets.adapter.serverCount()).toBe(2);
            // The root is not membership: adapter-owned subscriber duplicates remain
            // live until the adapter itself closes, as they would on process exit.
            healthy.owner.closeRedisSocketClusterClient();
            expect(await source.io.sockets.adapter.serverCount()).toBe(2);
            await healthy.io.close();
            await waitForCondition(async () => await source.io.sockets.adapter.serverCount() === 1);
            console.info('RPC_CENSUS_SILENT_PEER', JSON.stringify({ fetchWindowMs: 150, elapsedMs,
                gracefulMembership: 2, rootOnlyDisconnectMembership: 2, closedAdapterMembership: 1 }));
        } finally {
            held.release();
            await cluster.close();
        }
    });

    it('admits one current-version RPC target before an unrelated census peer answers', async () => {
        const cluster = await startRedisAdapterRecoveryCluster({ nodeCount: 3 });
        const [nodeA, nodeB, unrelated] = cluster.nodes;
        registerTestRpcHandlers(nodeA.io);
        registerTestRpcHandlers(nodeB.io);
        const caller = await connectClient(nodeA.port);
        const listener = await connectClient(nodeB.port);
        const held = holdRedisAdapterDiscoveryRequests(unrelated!.io);
        let targetHeld: ReturnType<typeof holdRedisAdapterDiscoveryRequests> | undefined;
        let executions = 0;
        try {
            const method = 'agent.currentRead';
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (_request, respond) => {
                executions++;
                respond({ source: 'target' });
            });
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            targetHeld = holdRedisAdapterDiscoveryRequests(nodeB.io);
            const calling = emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} });
            await Promise.all([held.received, targetHeld.received]);
            targetHeld.release();
            const response = await calling;
            expect(held.count).toBeGreaterThan(0);
            expect(response).toEqual({ ok: true, result: { source: 'target' } });
            expect(executions).toBe(1);
        } finally {
            held.release();
            targetHeld?.release();
            caller.disconnect();
            listener.disconnect();
            await cluster.close();
        }
    });

    it('keeps a registered cross-node RPC callable through a Redis stream-reader timeout', async () => {
        const cluster = await startRedisAdapterRecoveryCluster();
        const [source, target] = cluster.nodes;
        registerTestRpcHandlers(source.io);
        registerTestRpcHandlers(target.io);
        const caller = await connectClient(source.port);
        const listener = await connectClient(target.port);
        try {
            const method = 'agent.readerRecovery';
            const listenerId = listener.id;
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => respond(request.params));
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            const call = async (phase: string) => {
                expect(await emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: { phase } }))
                    .toEqual({ ok: true, result: { phase } });
            };
            await call('before');

            const readerName = target.owner.buildSocketClusterRedisConnectionName({ kind: 'adapter-duplicate', diagnosticOrdinal: 1 });
            const reader = target.adapterConnections.get(readerName);
            if (!reader) throw new Error('Expected the adapter stream reader');
            if (reader.status !== 'ready') await new Promise<void>(resolve => reader.once('ready', () => resolve()));
            const timeout = new Promise<Error>(resolve => reader.once('error', resolve));
            const reconnected = new Promise<void>(resolve => reader.once('ready', () => resolve()));
            // Stall only the real blocking XREAD connection and let ioredis detect it.
            reader.stream.pause();
            await call('stalled');
            expect((await timeout).message).toContain("Socket timeout. Expecting data");
            await reconnected;
            await call('on-ready');
            expect(listener.id).toBe(listenerId);
        } finally {
            caller.disconnect();
            listener.disconnect();
            await cluster.close();
        }
    });

    it.each(["restart", "silent partition"] as const)("recovers remote RPC discovery, calls and no-target after Redis %s", async (failure) => {
        const cluster = await startRedisAdapterRecoveryCluster();
        const [nodeA, nodeB] = cluster.nodes;
        registerTestRpcHandlers(nodeA.io);
        registerTestRpcHandlers(nodeB.io);
        const caller = await connectClient(nodeA.port);
        const listener = await connectClient(nodeB.port);
        try {
            const callerId = caller.id;
            const listenerId = listener.id;
            const method = "agent.recovery";
            const room = buildRpcMethodRoom({ userId: USER_ID, method });
            listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => respond(request.params));
            const registered = waitForEvent(listener, SOCKET_RPC_EVENTS.REGISTERED);
            listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
            await registered;
            const assertCall = async (phase: string) => {
                expect((await nodeA.io.in(room).fetchSockets()).map((socket) => socket.id)).toEqual([listenerId]);
                expect(await emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: { phase } }))
                    .toEqual({ ok: true, result: { phase } });
            };
            await assertCall("before");
            await cluster.recover(failure);
            expect(caller.id).toBe(callerId);
            expect(listener.id).toBe(listenerId);
            await assertCall("after");
            listener.disconnect();
            await waitForCondition(async () => (await nodeA.io.in(room).fetchSockets()).length === 0);
            expect(await emitWithAck(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }))
                .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
        } finally {
            caller.disconnect();
            listener.disconnect();
            await cluster.close();
        }
    }, 60_000);

    it("routes room-based RPC calls across redis-adapter-backed server instances", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);

        const caller = await connectClient(cluster.portA);
        const listener = await connectClient(cluster.portB);
        startedClients.push(caller, listener);

        const method = "agent.run";
        listener.on(SOCKET_RPC_EVENTS.REQUEST, (request, respond) => {
            respond({
                ok: true,
                responder: "server-b",
                method: (request as { method: string }).method,
                params: (request as { params: unknown }).params,
            });
        });

        const registered = waitForEvent<{ method: string }>(listener, SOCKET_RPC_EVENTS.REGISTERED);
        listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        await expect(registered).resolves.toEqual({ method });

        const response = await emitWithAck<{ ok: boolean; result?: unknown }>(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            {
                method,
                params: { source: "caller-a" },
            },
        );

        expect(response).toEqual({
            ok: true,
            result: {
                ok: true,
                responder: "server-b",
                method,
                params: { source: "caller-a" },
            },
        });
    });

    it("returns METHOD_NOT_AVAILABLE once the remote listener disconnects and leaves no stale room target", async () => {
        const cluster = await startCluster();
        startedClusters.push(cluster);

        const caller = await connectClient(cluster.portA);
        const listener = await connectClient(cluster.portB);
        startedClients.push(caller, listener);

        const method = "agent.run";
        const room = buildRpcMethodRoom({ userId: USER_ID, method });

        listener.on(SOCKET_RPC_EVENTS.REQUEST, (_request, respond) => {
            respond({ ok: true, responder: "server-b" });
        });

        const registered = waitForEvent<{ method: string }>(listener, SOCKET_RPC_EVENTS.REGISTERED);
        listener.emit(SOCKET_RPC_EVENTS.REGISTER, { method });
        await expect(registered).resolves.toEqual({ method });

        listener.disconnect();

        await waitForCondition(async () => {
            const [targetsA, targetsB] = await Promise.all([
                cluster.ioA.in(room).fetchSockets(),
                cluster.ioB.in(room).fetchSockets(),
            ]);
            return targetsA.length === 0 && targetsB.length === 0;
        });

        const response = await emitWithAck<{ ok: boolean; error?: string; errorCode?: string }>(
            caller,
            SOCKET_RPC_EVENTS.CALL,
            {
                method,
                params: { source: "caller-a" },
            },
        );

        expect(response).toEqual({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

});
