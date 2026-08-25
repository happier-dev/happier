import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";

import {
    createPeerTcpTunnelRelayAuthorizationSigningInputV2,
    PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
    type PeerTcpTunnelRelayEnvelope,
} from "@happier-dev/protocol";
import { createAdapter } from "@socket.io/redis-streams-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import tweetnacl from "tweetnacl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";
import { resolveRedisAdapterValidationRedisUrl } from "../../../../../../../scripts/resolveRedisAdapterValidationRedisUrl";

import { createPeerTcpTunnelRelayCoordinator } from "./relayCoordinator";
import type { PeerTcpTunnelRelayCoordinator } from "./relayCoordinator";

const ACCOUNT_ID = "relay-cluster-account";
const MACHINE_ID = "relay-cluster-machine";
const SOCKET_PATH = "/v1/updates";
const relayKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const relayAuthorizationTrustRoots = [{
    keyId: "relay-cluster-key",
    publicKeyBase64Url: Buffer.from(relayKeyPair.publicKey).toString("base64url"),
}] as const;

type RedisMemoryInstance = Awaited<
    ReturnType<typeof resolveRedisAdapterValidationRedisUrl>
>["redisMemory"];

type StartedCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    redisA: Redis;
    redisB: Redis;
    redisMemory: RedisMemoryInstance;
    coordinatorA: PeerTcpTunnelRelayCoordinator;
    coordinatorB: PeerTcpTunnelRelayCoordinator;
    portA: number;
    portB: number;
    partitionRedisA(): void;
    healRedisA(): Promise<void>;
    close(): Promise<void>;
}>;

type RedisPartitionProxy = Readonly<{
    redisUrl: string;
    partition(): void;
    heal(): void;
    close(): Promise<void>;
}>;

type ProductRedisModule = typeof import("@/storage/redis/redis");

type RestartableProductCluster = Readonly<{
    ioA: Server;
    ioB: Server;
    redisA: Redis;
    redisB: Redis;
    coordinatorA: PeerTcpTunnelRelayCoordinator;
    coordinatorB: PeerTcpTunnelRelayCoordinator;
    portA: number;
    portB: number;
    restartRedis(): Promise<void>;
    waitForGrantReservationBeforeAdapterRecovery(grantId: string): Promise<void>;
    waitForAdapterRecovery(): Promise<void>;
    close(): Promise<void>;
}>;

async function listen(server: http.Server | net.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address && typeof address === "object") return address.port;
    throw new Error("Failed to determine relay cluster test port");
}

async function closeServer(server: http.Server | net.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startRedisPartitionProxy(redisUrl: string): Promise<RedisPartitionProxy> {
    const upstreamUrl = new URL(redisUrl);
    const upstreamHost = upstreamUrl.hostname;
    const upstreamPort = Number(upstreamUrl.port || "6379");
    const sockets = new Set<net.Socket>();
    let partitioned = false;
    const server = net.createServer((client) => {
        if (partitioned) {
            client.destroy();
            return;
        }
        const upstream = net.createConnection({
            host: upstreamHost,
            port: upstreamPort,
        });
        sockets.add(client);
        sockets.add(upstream);
        const destroyPair = (): void => {
            sockets.delete(client);
            sockets.delete(upstream);
            client.destroy();
            upstream.destroy();
        };
        client.once("error", destroyPair);
        upstream.once("error", destroyPair);
        client.once("close", destroyPair);
        upstream.once("close", destroyPair);
        client.pipe(upstream);
        upstream.pipe(client);
    });
    const proxyPort = await listen(server);
    const proxyUrl = new URL(redisUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(proxyPort);
    return {
        redisUrl: proxyUrl.toString(),
        partition: () => {
            partitioned = true;
            for (const socket of [...sockets]) socket.destroy();
        },
        heal: () => {
            partitioned = false;
        },
        close: async () => {
            for (const socket of [...sockets]) socket.destroy();
            await closeServer(server);
        },
    };
}

type RegisterRelayModule = typeof import("./registerRelay");

async function loadIsolatedRegisterRelayModule(): Promise<RegisterRelayModule> {
    vi.resetModules();
    return await import("./registerRelay.js");
}

function registerRelayServer(
    io: Server,
    redis: Redis,
    registerRelay: RegisterRelayModule,
    relayCaps: Readonly<{
        maxIdleMs?: number;
        maxDurationMs?: number;
    }> = {},
): PeerTcpTunnelRelayCoordinator {
    const coordinator = createPeerTcpTunnelRelayCoordinator({
        io,
        config: { mode: "redis", redis },
    });
    io.on("connection", (socket) => {
        const clientType = socket.handshake.auth.clientType === "machine-scoped"
            ? "machine-scoped"
            : "user-scoped";
        const machineId = clientType === "machine-scoped" ? MACHINE_ID : undefined;
        socket.data.userId = ACCOUNT_ID;
        socket.data.clientType = clientType;
        if (machineId) socket.data.machineId = machineId;
        void socket.join(getSocketRooms({
            userId: ACCOUNT_ID,
            clientType,
            ...(machineId ? { machineId } : {}),
        }));
        registerRelay.registerPeerTcpTunnelRelaySocketHandler(ACCOUNT_ID, socket, {
            io,
            serverRoutedEnabled: true,
            allowedPorts: [3000],
            relayAuthorizationTrustRoots,
            coordinator,
            ...relayCaps,
        });
    });
    return coordinator;
}

async function startCluster(relayCaps: Readonly<{
    maxIdleMs?: number;
    maxDurationMs?: number;
}> = {}): Promise<StartedCluster> {
    const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
        env: process.env,
    });
    const redisAProxy = await startRedisPartitionProxy(redisUrl);
    const redisA = new Redis(redisAProxy.redisUrl);
    const redisB = new Redis(redisUrl);
    redisA.on("error", () => {
        // Expected while the integration harness severs this replica's Redis path.
    });
    const httpA = http.createServer();
    const httpB = http.createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB),
    });
    const registerRelayA = await loadIsolatedRegisterRelayModule();
    const registerRelayB = await loadIsolatedRegisterRelayModule();
    const coordinatorA = registerRelayServer(ioA, redisA, registerRelayA, relayCaps);
    const coordinatorB = registerRelayServer(ioB, redisB, registerRelayB, relayCaps);
    const portA = await listen(httpA);
    const portB = await listen(httpB);
    return {
        ioA,
        ioB,
        redisA,
        redisB,
        redisMemory,
        coordinatorA,
        coordinatorB,
        portA,
        portB,
        partitionRedisA: () => redisAProxy.partition(),
        healRedisA: async () => {
            redisAProxy.heal();
            await waitForCondition(() => redisA.status === "ready");
        },
        close: async () => {
            await ioA.close();
            await coordinatorA.close();
            await ioB.close();
            await coordinatorB.close();
            await closeServer(httpA);
            await closeServer(httpB);
            if (redisA.status === "ready") {
                await redisA.quit();
            } else {
                redisA.disconnect(false);
            }
            await redisB.quit();
            await redisAProxy.close();
            await redisMemory?.stop();
        },
    };
}

async function startRestartableProductCluster(): Promise<RestartableProductCluster> {
    const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({
        env: {} as NodeJS.ProcessEnv,
    });
    if (!resolvedRedis.redisMemory) {
        throw new Error("Redis restart integration requires an embedded Redis instance");
    }
    const { redisUrl, redisMemory } = resolvedRedis;
    const originalRedisUrl = process.env.REDIS_URL;

    const loadProductRedisModule = async (): Promise<ProductRedisModule> => {
        process.env.REDIS_URL = redisUrl;
        vi.resetModules();
        return await import("@/storage/redis/redis");
    };
    const redisModuleA = await loadProductRedisModule();
    const redisA = redisModuleA.getRedisSocketClusterClient();
    const redisModuleB = await loadProductRedisModule();
    const redisB = redisModuleB.getRedisSocketClusterClient();
    if (originalRedisUrl === undefined) {
        delete process.env.REDIS_URL;
    } else {
        process.env.REDIS_URL = originalRedisUrl;
    }

    const httpA = http.createServer();
    const httpB = http.createServer();
    const ioA = new Server(httpA, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisA),
    });
    const ioB = new Server(httpB, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        serveClient: false,
        adapter: createAdapter(redisB),
    });
    const registerRelayA = await loadIsolatedRegisterRelayModule();
    const registerRelayB = await loadIsolatedRegisterRelayModule();
    const coordinatorA = registerRelayServer(ioA, redisA, registerRelayA);
    const coordinatorB = registerRelayServer(ioB, redisB, registerRelayB);
    const portA = await listen(httpA);
    const portB = await listen(httpB);

    const waitForRedisReady = async (redis: Redis): Promise<void> => {
        await waitForCondition(() => redis.status === "ready", 15_000);
    };

    return {
        ioA,
        ioB,
        redisA,
        redisB,
        coordinatorA,
        coordinatorB,
        portA,
        portB,
        restartRedis: async () => {
            await redisMemory.stop();
            await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
            await redisMemory.start();
            if (redisA.status === "ready") {
                throw new Error("Redis adapter recovered before the restart probe could exercise admission isolation");
            }
        },
        waitForGrantReservationBeforeAdapterRecovery: async (grantId) => {
            const verifier = new Redis(redisUrl, {
                enableOfflineQueue: false,
                lazyConnect: true,
                maxRetriesPerRequest: 0,
            });
            const grantDigest = createHash("sha256").update(grantId, "utf8").digest("hex");
            const grantKey = `peer-tunnel-relay-grant:v1:${grantDigest}`;
            try {
                await verifier.connect();
                const deadline = Date.now() + 4_000;
                while (Date.now() < deadline) {
                    if (redisA.status === "ready") {
                        throw new Error("Adapter recovered before the dedicated admission client reserved the grant");
                    }
                    if (await verifier.exists(grantKey) === 1) return;
                    await new Promise<void>((resolve) => setTimeout(resolve, 20));
                }
                throw new Error("Dedicated admission client did not reserve the grant before adapter recovery");
            } finally {
                if (verifier.status === "ready") {
                    await verifier.quit();
                } else {
                    verifier.disconnect(false);
                }
            }
        },
        waitForAdapterRecovery: async () => {
            await Promise.all([
                waitForRedisReady(redisA),
                waitForRedisReady(redisB),
            ]);
        },
        close: async () => {
            await ioA.close();
            await coordinatorA.close();
            await ioB.close();
            await coordinatorB.close();
            if (httpA.listening) await closeServer(httpA);
            if (httpB.listening) await closeServer(httpB);
            redisModuleA.closeRedisSocketClusterClient();
            redisModuleB.closeRedisSocketClusterClient();
            await redisMemory.stop();
        },
    };
}

async function connectClient(port: number, clientType: "user-scoped" | "machine-scoped"): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
        path: SOCKET_PATH,
        transports: ["websocket"],
        timeout: 5_000,
        auth: { clientType },
    });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out connecting relay cluster client")), 6_000);
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for relay cluster condition");
}

function createOpenEnvelope(input: Readonly<{
    tunnelId: string;
    grantId: string;
    relaySocketId: string;
    issuedAt?: number;
    expiresAt?: number;
}>): PeerTcpTunnelRelayEnvelope {
    const now = input.issuedAt ?? Date.now();
    const destination = { host: "127.0.0.1", port: 3000 } as const;
    const payload = {
        v: 2,
        grantId: input.grantId,
        accountId: ACCOUNT_ID,
        targetMachineId: MACHINE_ID,
        flowKind: "voice_media",
        applicationKind: "speech_transcription",
        applicationAttemptId: `attempt_${input.tunnelId}`,
        applicationAuthorityDigest: `sha256:${"ab".repeat(32)}`,
        routeKind: "server_relay",
        tunnelId: input.tunnelId,
        relaySocketId: input.relaySocketId,
        destination,
        capProfileId: "interactive",
        maxFrameBytes: 64 * 1024,
        maxIdleMs: 30_000,
        maxDurationMs: 300_000,
        maxTotalBytes: 64 * 1024 * 1024,
        iat: now,
        exp: input.expiresAt ?? now + 300_000,
        aud: "happier-tcp-tunnel-relay-authorization",
    } as const;
    return {
        v: 1,
        scopeUserId: ACCOUNT_ID,
        sender: { kind: "user", socketId: input.relaySocketId },
        recipient: { kind: "machine", machineId: MACHINE_ID },
        frame: {
            v: 1,
            kind: "open",
            open: {
                v: 1,
                kind: "open",
                tunnelId: input.tunnelId,
                targetMachineId: MACHINE_ID,
                routeKind: "server_relay",
                destination,
                relayAuthorization: {
                    payload,
                    signature: {
                        keyId: "relay-cluster-key",
                        alg: "Ed25519",
                        valueBase64Url: Buffer.from(tweetnacl.sign.detached(
                            new TextEncoder().encode(
                                createPeerTcpTunnelRelayAuthorizationSigningInputV2(payload),
                            ),
                            relayKeyPair.secretKey,
                        )).toString("base64url"),
                    },
                },
            },
        },
    };
}

function createMachineDataEnvelope(input: Readonly<{
    tunnelId: string;
    userSocketId: string;
    payload: string;
}>): PeerTcpTunnelRelayEnvelope {
    return {
        v: 1,
        scopeUserId: ACCOUNT_ID,
        sender: { kind: "machine", machineId: MACHINE_ID },
        recipient: { kind: "user", socketId: input.userSocketId },
        frame: {
            v: 1,
            kind: "data",
            tunnelId: input.tunnelId,
            direction: "daemon_to_client",
            sequence: 0,
            payloadBase64: Buffer.from(input.payload).toString("base64"),
        },
    };
}

function createUserDataEnvelope(input: Readonly<{
    tunnelId: string;
    payload: string;
}>): PeerTcpTunnelRelayEnvelope {
    return {
        v: 1,
        scopeUserId: ACCOUNT_ID,
        sender: { kind: "user" },
        recipient: { kind: "machine", machineId: MACHINE_ID },
        frame: {
            v: 1,
            kind: "data",
            tunnelId: input.tunnelId,
            direction: "client_to_daemon",
            sequence: 0,
            payloadBase64: Buffer.from(input.payload).toString("base64"),
        },
    };
}

function createMachineTerminalEnvelope(input: Readonly<{
    tunnelId: string;
    userSocketId: string;
    kind: "close" | "abort";
}>): PeerTcpTunnelRelayEnvelope {
    return {
        v: 1,
        scopeUserId: ACCOUNT_ID,
        sender: { kind: "machine", machineId: MACHINE_ID },
        recipient: { kind: "user", socketId: input.userSocketId },
        frame: input.kind === "close"
            ? {
                v: 1,
                kind: "close",
                tunnelId: input.tunnelId,
                halfClose: false,
                reasonCode: "machine_closed",
            }
            : {
                v: 1,
                kind: "abort",
                tunnelId: input.tunnelId,
                reasonCode: "machine_aborted",
            },
    };
}

describe("peer tunnel relay Redis adapter integration", () => {
    const clusters: Array<Readonly<{ close(): Promise<void> }>> = [];
    const clients: ClientSocket[] = [];

    afterEach(async () => {
        while (clients.length > 0) clients.pop()?.disconnect();
        while (clusters.length > 0) await clusters.pop()?.close();
    });

    it("fails closed before OPEN when the owner replica loses Redis transport and preserves one global winner after recovery", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const userA = await connectClient(cluster.portA, "user-scoped");
        const userB = await connectClient(cluster.portB, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(userA, userB, machine);

        const userAFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const userBFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        userA.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userAFrames.push(value));
        userB.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userBFrames.push(value));
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));

        cluster.partitionRedisA();
        expect(userA.connected).toBe(true);
        expect(userB.connected).toBe(true);
        expect(machine.connected).toBe(true);

        const grantId = "partition-before-open-global-grant";
        const unavailableTunnelId = "partition-before-open-unavailable";
        const unavailableOpen = createOpenEnvelope({
            tunnelId: unavailableTunnelId,
            grantId,
            relaySocketId: userA.id!,
        });
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, unavailableOpen);

        await waitForCondition(() => userAFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === unavailableTunnelId
            && frame.frame.reasonCode === "route_unavailable",
        ));
        expect(machineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === unavailableTunnelId,
        )).toHaveLength(0);

        await cluster.healRedisA();
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, unavailableOpen);
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === unavailableTunnelId,
        ));
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, unavailableOpen);
        userB.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: "partition-before-open-duplicate",
            grantId,
            relaySocketId: userB.id!,
        }));
        await waitForCondition(() => userBFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === "partition-before-open-duplicate"
            && frame.frame.reasonCode === "relay_authorization_invalid",
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(userAFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === unavailableTunnelId,
        ).map((frame) => frame.v === 1 && frame.frame.kind === "abort"
            ? frame.frame.reasonCode
            : "unexpected")).toEqual([
            "route_unavailable",
            "tunnel_id_already_open",
        ]);
        expect(machineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === unavailableTunnelId,
        )).toHaveLength(1);
        expect(userBFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === "partition-before-open-duplicate"
            && frame.frame.reasonCode === "relay_authorization_invalid",
        )).toHaveLength(1);
    });

    it("terminalizes an admitted cross-replica tunnel once during Redis transport partition without reroute or resurrection", async () => {
        const cluster = await startCluster({
            maxIdleMs: 250,
            maxDurationMs: 2_000,
        });
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(user, machine);

        const userFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        user.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userFrames.push(value));
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));

        const tunnelId = "partition-after-attachment";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId,
            grantId: "partition-after-attachment-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === tunnelId,
        ));

        cluster.partitionRedisA();
        expect(user.connected).toBe(true);
        expect(machine.connected).toBe(true);
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId,
            payload: "must-not-cross-partition",
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(machineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === tunnelId,
        )).toHaveLength(0);

        await waitForCondition(() => userFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_cap_exceeded",
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        expect(userFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_cap_exceeded",
        )).toHaveLength(1);

        await cluster.healRedisA();
        await waitForCondition(() => cluster.coordinatorB.routeMachineEnvelope({
            tunnelKey: `${ACCOUNT_ID}:machine:${MACHINE_ID}:user:${tunnelId}`,
            machineSocketId: machine.id!,
            envelope: createMachineDataEnvelope({
                tunnelId,
                userSocketId: user.id!,
                payload: "release-probe",
            }),
        }) === "rejected");
        machine.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineDataEnvelope({
            tunnelId,
            userSocketId: user.id!,
            payload: "must-not-resurrect-after-heal",
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        expect(userFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === tunnelId,
        )).toHaveLength(0);
        expect(userFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_cap_exceeded",
        )).toHaveLength(1);

        const freshTunnelId = "partition-after-attachment-fresh";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: freshTunnelId,
            grantId: "partition-after-attachment-fresh-grant",
            relaySocketId: user.id!,
        }));
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId: freshTunnelId,
            payload: "fresh-after-heal",
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === freshTunnelId,
        ));
    });

    it("routes a fresh cross-replica OPEN after Redis restarts while client sockets stay connected", async () => {
        const cluster = await startRestartableProductCluster();
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(user, machine);

        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const userFrames: PeerTcpTunnelRelayEnvelope[] = [];
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));
        user.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userFrames.push(value));

        const beforeRestartTunnelId = "redis-restart-before";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: beforeRestartTunnelId,
            grantId: "redis-restart-before-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === beforeRestartTunnelId,
        ));

        await cluster.restartRedis();
        expect(user.connected).toBe(true);
        expect(machine.connected).toBe(true);

        const expiredTunnelId = "redis-restart-expired";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: expiredTunnelId,
            grantId: "redis-restart-expired-grant",
            relaySocketId: user.id!,
            issuedAt: Date.now() - 2_000,
            expiresAt: Date.now() - 1_000,
        }));
        await waitForCondition(() => userFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === expiredTunnelId
            && frame.frame.reasonCode === "relay_authorization_invalid",
        ));

        const afterRestartTunnelId = "redis-restart-after";
        const afterRestartGrantId = "redis-restart-after-grant";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: afterRestartTunnelId,
            grantId: afterRestartGrantId,
            relaySocketId: user.id!,
        }));
        await cluster.waitForGrantReservationBeforeAdapterRecovery(afterRestartGrantId);
        await cluster.waitForAdapterRecovery();
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === afterRestartTunnelId,
        ), 30_000);

        expect(machineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === afterRestartTunnelId,
        )).toHaveLength(1);
        expect(userFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === expiredTunnelId
            && frame.frame.reasonCode === "relay_authorization_invalid",
        )).toHaveLength(1);
    }, 120_000);

    it("keeps admission, machine frames, and recipient disconnect settlement on the user replica", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const userA = await connectClient(cluster.portA, "user-scoped");
        const userB = await connectClient(cluster.portB, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(userA, userB, machine);

        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const userAFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const userBFrames: PeerTcpTunnelRelayEnvelope[] = [];
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));
        userA.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userAFrames.push(value));
        userB.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userBFrames.push(value));

        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: "duplicate-a",
            grantId: "one-global-grant",
            relaySocketId: userA.id!,
        }));
        userB.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: "duplicate-b",
            grantId: "one-global-grant",
            relaySocketId: userB.id!,
        }));

        await waitForCondition(() => {
            const opens = machineFrames.filter((frame) => frame.v === 1 && frame.frame.kind === "open").length;
            const rejected = [...userAFrames, ...userBFrames].filter((frame) =>
                frame.v === 1
                && frame.frame.kind === "abort"
                && frame.frame.reasonCode === "relay_authorization_invalid",
            ).length;
            return opens + rejected >= 2;
        });
        expect(machineFrames.filter((frame) => frame.v === 1 && frame.frame.kind === "open")).toHaveLength(1);
        expect([...userAFrames, ...userBFrames].filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.reasonCode === "relay_authorization_invalid",
        )).toHaveLength(1);

        const immediateTunnelId = "immediate-open-data";
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: immediateTunnelId,
            grantId: "immediate-open-data-grant",
            relaySocketId: userA.id!,
        }));
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId: immediateTunnelId,
            payload: "queued-behind-attachment",
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "data" && frame.frame.tunnelId === immediateTunnelId,
        ));
        const immediateKinds = machineFrames
            .filter((frame) =>
                frame.v === 1
                && (frame.frame.kind === "open"
                    ? frame.frame.open.tunnelId === immediateTunnelId
                    : frame.frame.tunnelId === immediateTunnelId),
            )
            .map((frame) => frame.v === 1 ? frame.frame.kind : "binary");
        expect(immediateKinds).toEqual(["open", "data"]);

        const exactSocketTunnelId = "exact-machine-socket";
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: exactSocketTunnelId,
            grantId: "exact-machine-socket-grant",
            relaySocketId: userA.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === exactSocketTunnelId,
        ));
        const replacementMachine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(replacementMachine);
        const replacementMachineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        replacementMachine.on(
            PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            (value) => replacementMachineFrames.push(value),
        );
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId: exactSocketTunnelId,
            payload: "exact-recipient-only",
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === exactSocketTunnelId,
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(replacementMachineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === exactSocketTunnelId,
        )).toHaveLength(0);

        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId: exactSocketTunnelId,
            payload: "x".repeat(70 * 1024),
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === exactSocketTunnelId
            && frame.frame.reasonCode === "relay_cap_exceeded",
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(replacementMachineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === exactSocketTunnelId,
        )).toHaveLength(0);
        replacementMachine.disconnect();

        const frameTunnelId = "machine-frame";
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: frameTunnelId,
            grantId: "machine-frame-grant",
            relaySocketId: userA.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "open" && frame.frame.open.tunnelId === frameTunnelId,
        ));
        machine.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineDataEnvelope({
            tunnelId: frameTunnelId,
            userSocketId: userA.id!,
            payload: "remote-machine-frame",
        }));
        await waitForCondition(() => userAFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === frameTunnelId,
        ));

        const disconnectTunnelId = "recipient-disconnect-before-frame";
        userA.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: disconnectTunnelId,
            grantId: "recipient-disconnect-grant",
            relaySocketId: userA.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === disconnectTunnelId,
        ));
        machine.disconnect();
        await waitForCondition(() => userAFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === disconnectTunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        ));
        expect(userAFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === disconnectTunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        )).toHaveLength(1);
    });

    it("continues same-replica exact machine ingress once and rejects replacement terminal injection", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portA, "machine-scoped");
        clients.push(user, machine);

        const userFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        user.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userFrames.push(value));
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));

        const tunnelId = "same-replica-exact";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId,
            grantId: "same-replica-exact-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "open" && frame.frame.open.tunnelId === tunnelId,
        ));

        machine.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineDataEnvelope({
            tunnelId,
            userSocketId: user.id!,
            payload: "same-replica-once",
        }));
        await waitForCondition(() => userFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "data" && frame.frame.tunnelId === tunnelId,
        ));
        expect(userFrames.filter((frame) =>
            frame.v === 1 && frame.frame.kind === "data" && frame.frame.tunnelId === tunnelId,
        )).toHaveLength(1);

        const replacement = await connectClient(cluster.portA, "machine-scoped");
        clients.push(replacement);
        replacement.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineDataEnvelope({
            tunnelId,
            userSocketId: user.id!,
            payload: "replacement-data",
        }));
        replacement.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineTerminalEnvelope({
            tunnelId,
            userSocketId: user.id!,
            kind: "close",
        }));
        replacement.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineTerminalEnvelope({
            tunnelId,
            userSocketId: user.id!,
            kind: "abort",
        }));
        await new Promise<void>((resolve) => setTimeout(resolve, 150));

        expect(userFrames.filter((frame) => {
            if (frame.v !== 1 || frame.frame.kind === "open") return false;
            return frame.frame.tunnelId === tunnelId;
        })).toEqual([
            expect.objectContaining({
                frame: expect.objectContaining({
                    kind: "data",
                    tunnelId,
                    payloadBase64: Buffer.from("same-replica-once").toString("base64"),
                }),
            }),
        ]);

        machine.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createMachineTerminalEnvelope({
            tunnelId,
            userSocketId: user.id!,
            kind: "close",
        }));
        await waitForCondition(() => userFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "close" && frame.frame.tunnelId === tunnelId,
        ));
        expect(userFrames.filter((frame) =>
            frame.v === 1 && frame.frame.kind === "close" && frame.frame.tunnelId === tunnelId,
        )).toHaveLength(1);

        replacement.disconnect();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        const disconnectTunnelId = "same-replica-owner-disconnect";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: disconnectTunnelId,
            grantId: "same-replica-owner-disconnect-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === disconnectTunnelId,
        ));
        const disconnectReplacement = await connectClient(cluster.portA, "machine-scoped");
        clients.push(disconnectReplacement);
        const disconnectReplacementFrames: PeerTcpTunnelRelayEnvelope[] = [];
        disconnectReplacement.on(
            PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
            (value) => disconnectReplacementFrames.push(value),
        );

        user.disconnect();
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === disconnectTunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(disconnectReplacementFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === disconnectTunnelId,
        )).toHaveLength(0);
    });

    it("awaits remote attachment cleanup before the owner coordinator closes", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(user, machine);

        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));
        const tunnelId = "owner-shutdown";
        const open = createOpenEnvelope({
            tunnelId,
            grantId: "owner-shutdown-grant",
            relaySocketId: user.id!,
        });
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, open);
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "open" && frame.frame.open.tunnelId === tunnelId,
        ));

        await cluster.coordinatorA.close();

        expect(cluster.coordinatorB.routeMachineEnvelope({
            tunnelKey: `${ACCOUNT_ID}:machine:${MACHINE_ID}:user:${tunnelId}`,
            machineSocketId: machine.id!,
            envelope: createMachineDataEnvelope({
                tunnelId,
                userSocketId: user.id!,
                payload: "must-not-route-after-owner-close",
            }),
        })).toBe("rejected");
    });

    it("terminalizes a remote attachment once when its owner replica shuts down gracefully", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(user, machine);

        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));

        const tunnelId = "owner-replica-shutdown";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId,
            grantId: "owner-replica-shutdown-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === tunnelId,
        ));

        // Mirror the production owner-replica shutdown lifecycle.
        await cluster.ioA.close();
        await cluster.coordinatorA.close();

        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        ));
        expect(cluster.coordinatorB.routeMachineEnvelope({
            tunnelKey: `${ACCOUNT_ID}:machine:${MACHINE_ID}:user:${tunnelId}`,
            machineSocketId: machine.id!,
            envelope: createMachineDataEnvelope({
                tunnelId,
                userSocketId: user.id!,
                payload: "must-not-reroute-after-owner-shutdown",
            }),
        })).toBe("rejected");

        const survivingUser = await connectClient(cluster.portB, "user-scoped");
        clients.push(survivingUser);
        const survivingTunnelId = "surviving-replica-after-owner-shutdown";
        survivingUser.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId: survivingTunnelId,
            grantId: "surviving-replica-after-owner-shutdown-grant",
            relaySocketId: survivingUser.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "open"
            && frame.frame.open.tunnelId === survivingTunnelId,
        ));
        survivingUser.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createUserDataEnvelope({
            tunnelId: survivingTunnelId,
            payload: "surviving-replica-remains-usable",
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "data"
            && frame.frame.tunnelId === survivingTunnelId,
        ));
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(machineFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        )).toHaveLength(1);
    });

    it("notifies the remote owner exactly once when the machine replica shuts down gracefully", async () => {
        const cluster = await startCluster();
        clusters.push(cluster);
        const user = await connectClient(cluster.portA, "user-scoped");
        const machine = await connectClient(cluster.portB, "machine-scoped");
        clients.push(user, machine);

        const userFrames: PeerTcpTunnelRelayEnvelope[] = [];
        const machineFrames: PeerTcpTunnelRelayEnvelope[] = [];
        user.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => userFrames.push(value));
        machine.on(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, (value) => machineFrames.push(value));

        const tunnelId = "machine-replica-shutdown";
        user.emit(PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT, createOpenEnvelope({
            tunnelId,
            grantId: "machine-replica-shutdown-grant",
            relaySocketId: user.id!,
        }));
        await waitForCondition(() => machineFrames.some((frame) =>
            frame.v === 1 && frame.frame.kind === "open" && frame.frame.open.tunnelId === tunnelId,
        ));

        await cluster.ioB.close();
        await cluster.coordinatorB.close();

        await waitForCondition(() => userFrames.some((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        ));
        expect(userFrames.filter((frame) =>
            frame.v === 1
            && frame.frame.kind === "abort"
            && frame.frame.tunnelId === tunnelId
            && frame.frame.reasonCode === "relay_socket_disconnected",
        )).toHaveLength(1);
    });
});
