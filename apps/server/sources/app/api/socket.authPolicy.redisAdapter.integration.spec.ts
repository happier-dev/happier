import Fastify from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import { ClusterAdapter, MessageType, type ClusterMessage } from "socket.io-adapter";
import type { Server } from "socket.io";

import { auth } from "@/app/auth/auth";
import { RedisStreamsRoomEmitter } from "@/app/events/createRedisStreamsRoomEmitter";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, type CredentialQualifiedSessionDeliveryV1 } from "@/app/events/socketRoomEmitter";
import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { emitSessionDeletedUpdate } from "@/app/session/delete/emitSessionDeletedUpdate";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

const redisRuntime = vi.hoisted(() => ({
    activeClient: null as unknown,
}));

const shutdownRuntime = vi.hoisted(() => ({
    callbacks: [] as Array<() => Promise<void>>,
}));

vi.mock("@/storage/redis/redis", async (importOriginal) => ({
    ...await importOriginal<typeof import("@/storage/redis/redis")>(),
    // Separate production replicas own separate process-local clients. This
    // in-process harness preserves that topology with two real Redis clients;
    // it does not replace the Redis Streams adapter or its transport.
    getRedisClient: () => redisRuntime.activeClient,
    getRedisSocketClusterAdapterClient: () => redisRuntime.activeClient,
    getRedisSocketClusterClient: () => redisRuntime.activeClient,
    closeRedisSocketClusterClient: () => {},
}));

vi.mock("@/utils/process/shutdown", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/process/shutdown")>();
    return {
        ...actual,
        onShutdown: (_name: string, callback: () => Promise<void>) => {
            // startSocket owns its Socket.IO close through this lifecycle,
            // which a plain Fastify close deliberately does not invoke.
            shutdownRuntime.callbacks.push(callback);
            return () => {
                const index = shutdownRuntime.callbacks.indexOf(callback);
                if (index >= 0) shutdownRuntime.callbacks.splice(index, 1);
            };
        },
    };
});

type RedisMemoryInstance = Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

type StartedReplica = Readonly<{
    app: AppFastify;
    port: number;
    stopSocket: () => Promise<void>;
}>;

async function startReplica(params: Readonly<{
    instanceId: string;
    redis: Redis;
}>): Promise<StartedReplica> {
    redisRuntime.activeClient = params.redis;
    process.env.HAPPIER_INSTANCE_ID = params.instanceId;

    const app = Fastify({ logger: false }) as unknown as AppFastify;
    const priorShutdownCallbacks = shutdownRuntime.callbacks.length;
    startSocket(app);
    const stopSocket = shutdownRuntime.callbacks.at(priorShutdownCallbacks);
    if (!stopSocket) {
        throw new Error("Socket replica did not register its shutdown callback");
    }
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) {
        await app.close();
        throw new Error("Failed to bind Socket.IO replica");
    }
    return { app, port, stopSocket };
}

async function connectClient(params: Readonly<{
    port: number;
    auth: Record<string, string>;
}>): Promise<ReturnType<typeof ioClient>> {
    const socket = ioClient(`http://127.0.0.1:${params.port}`, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        auth: params.auth,
    });
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out connecting Socket.IO replica client"));
        }, 6_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("connect", onConnect);
            socket.off("connect_error", onConnectError);
        };
        const onConnect = () => {
            cleanup();
            resolve();
        };
        const onConnectError = (error: unknown) => {
            cleanup();
            reject(error);
        };
        socket.on("connect", onConnect);
        socket.on("connect_error", onConnectError);
    });
    return socket;
}

async function waitForDisconnect(socket: ReturnType<typeof ioClient>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for remote replica socket revocation"));
        }, 6_000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.off("disconnect", onDisconnect);
        };
        const onDisconnect = () => {
            cleanup();
            resolve();
        };
        socket.on("disconnect", onDisconnect);
    });
}

async function waitFor(
    predicate: () => boolean,
    description: string,
    timeoutMs = 6_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function expectUnchangedFor(values: readonly unknown[], durationMs = 350): Promise<void> {
    const initialLength = values.length;
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    expect(values).toHaveLength(initialLength);
}

describe("startSocket account revocation with the configured Redis adapter", () => {
    let harness: LightSqliteHarness;
    let redisMemory: RedisMemoryInstance = null;
    const replicas: StartedReplica[] = [];
    const redisClients: Redis[] = [];
    const clients: Array<ReturnType<typeof ioClient>> = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-socket-redis-auth-policy-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        vi.restoreAllMocks();
        while (clients.length > 0) {
            clients.pop()?.disconnect();
        }
        while (replicas.length > 0) {
            const replica = replicas.pop();
            if (!replica) continue;
            await replica.stopSocket();
            await replica.app.close();
        }
        while (redisClients.length > 0) {
            await redisClients.pop()?.quit();
        }
        if (redisMemory) {
            await redisMemory.stop();
            redisMemory = null;
        }
        redisRuntime.activeClient = null;
        eventRouter.clearIo();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.team.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("disconnects user, session, and machine sockets from a different configured replica", async () => {
        const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({ env: process.env });
        redisMemory = resolvedRedis.redisMemory;
        harness.resetEnv({
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: resolvedRedis.redisUrl,
            HAPPY_SERVER_FLAVOR: "full",
        });

        const redisA = new Redis(resolvedRedis.redisUrl);
        const redisB = new Redis(resolvedRedis.redisUrl);
        redisClients.push(redisA, redisB);
        const replicaA = await startReplica({ instanceId: "auth-policy-replica-a", redis: redisA });
        const replicaB = await startReplica({ instanceId: "auth-policy-replica-b", redis: redisB });
        replicas.push(replicaA, replicaB);

        const admissions = [
            {
                name: "user",
                configure: async (_accountId: string): Promise<Record<string, string>> => ({}),
            },
            {
                name: "session",
                configure: async (accountId: string): Promise<Record<string, string>> => {
                    const sessionId = `s-redis-revocation-${Date.now()}`;
                    await db.session.create({
                        data: {
                            id: sessionId,
                            tag: `t-redis-revocation-${Date.now()}`,
                            accountId,
                            encryptionMode: "e2ee",
                            metadata: "{}",
                        },
                    });
                    return { clientType: "session-scoped", sessionId };
                },
            },
            {
                name: "machine",
                configure: async (accountId: string): Promise<Record<string, string>> => {
                    const machineId = `m-redis-revocation-${Date.now()}`;
                    await db.machine.create({
                        data: {
                            id: machineId,
                            accountId,
                            metadata: "metadata",
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                            active: false,
                        },
                    });
                    return { clientType: "machine-scoped", machineId };
                },
            },
        ] as const;

        for (const admission of admissions) {
            const account = await db.account.create({
                data: { publicKey: `pk-redis-revocation-${admission.name}-${Date.now()}` },
                select: { id: true },
            });
            const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
            const socketAuth = await admission.configure(account.id);
            const socket = await connectClient({
                port: replicaB.port,
                auth: { token, ...socketAuth },
            });
            clients.push(socket);
            expect(socket.connected, admission.name).toBe(true);

            const disconnected = waitForDisconnect(socket);
            await auth.signOutEverywhere(account.id);
            replicaA.app.disconnectAccountSockets(account.id);

            await disconnected;
            expect(socket.connected, admission.name).toBe(false);
        }
    }, 45_000);

    it.each(["worker", "api"] as const)("qualifies local and remote Session recipients from %s despite a silent unrelated peer", async (publisher) => {
        const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({ env: process.env });
        redisMemory = resolvedRedis.redisMemory;
        harness.resetEnv({
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: resolvedRedis.redisUrl,
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        });

        const redisA = new Redis(resolvedRedis.redisUrl);
        const redisB = new Redis(resolvedRedis.redisUrl);
        const redisWorker = new Redis(resolvedRedis.redisUrl);
        const redisSilent = new Redis(resolvedRedis.redisUrl);
        redisClients.push(redisA, redisB, redisWorker, redisSilent);
        const silentReplica = await startReplica({ instanceId: "protected-fanout-silent", redis: redisSilent });
        const replicaB = await startReplica({ instanceId: "protected-fanout-replica-b", redis: redisB });
        // The shared in-process router publishes from the last configured API replica.
        const replicaA = await startReplica({ instanceId: "protected-fanout-replica-a", redis: redisA });
        replicas.push(silentReplica, replicaB, replicaA);
        const ioA = replicaA.app.machineDaemonPresence as Server;
        const ioB = replicaB.app.machineDaemonPresence as Server;
        const ioSilent = silentReplica.app.machineDaemonPresence as Server;
        await vi.waitFor(async () => expect(await ioA.of("/").adapter.serverCount()).toBe(3));
        const silentAdapter = ioSilent.of("/").adapter;
        if (!(silentAdapter instanceof ClusterAdapter)) throw new Error("Expected ClusterAdapter");
        // Hold the external transport hook: the unrelated peer stays counted, but
        // answers neither census requests nor server-side delivery packets.
        const silentReceiver = silentAdapter as unknown as { onMessage(message: ClusterMessage, offset?: string): void };
        const silentOnMessage = silentReceiver.onMessage.bind(silentReceiver);
        vi.spyOn(silentReceiver, "onMessage").mockImplementation((message, offset) => {
            if (message.type === MessageType.FETCH_SOCKETS || message.type === MessageType.SERVER_SIDE_EMIT) return;
            silentOnMessage(message, offset);
        });

        const owner = await db.account.create({ data: { publicKey: `pk-owner-${crypto.randomUUID()}` } });
        const actor = await db.account.create({ data: { publicKey: `pk-actor-${crypto.randomUUID()}` } });
        const directActor = await db.account.create({ data: { publicKey: `pk-direct-${crypto.randomUUID()}` } });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: `session-${crypto.randomUUID()}`,
            encryptionMode: "e2ee",
            metadata: "{}",
        } });
        const team = await db.team.create({ data: {
            name: `Team ${crypto.randomUUID()}`,
            authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id,
            accountId: actor.id,
            role: "member",
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(),
        } });
        await db.sessionShare.create({ data: {
            sessionId: session.id,
            sharedByUserId: owner.id,
            sharedWithUserId: directActor.id,
            accessLevel: "view",
        } });

        const qualifiedToken = await auth.createToken(actor.id, undefined, {
            kind: "account",
            authority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        });
        const unqualifiedToken = await auth.createToken(actor.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const directToken = await auth.createToken(directActor.id, undefined, {
            kind: "account",
            authority: "present_user",
        });
        const qualified = await connectClient({ port: replicaB.port, auth: { token: qualifiedToken } });
        const localQualified = await connectClient({ port: replicaA.port, auth: { token: qualifiedToken } });
        const sender = await connectClient({ port: replicaA.port, auth: { token: qualifiedToken } });
        const unqualified = await connectClient({ port: replicaB.port, auth: { token: unqualifiedToken } });
        const localUnqualified = await connectClient({ port: replicaA.port, auth: { token: unqualifiedToken } });
        const direct = await connectClient({ port: replicaB.port, auth: { token: directToken } });
        clients.push(qualified, localQualified, sender, unqualified, localUnqualified, direct);

        const qualifiedUpdates: unknown[] = [];
        const unqualifiedUpdates: unknown[] = [];
        const directUpdates: unknown[] = [];
        const localUpdates: unknown[] = [];
        const senderUpdates: unknown[] = [];
        const localUnqualifiedUpdates: unknown[] = [];
        qualified.on("update", (value) => qualifiedUpdates.push(value));
        unqualified.on("update", (value) => unqualifiedUpdates.push(value));
        direct.on("update", (value) => directUpdates.push(value));
        localQualified.on("update", value => localUpdates.push(value));
        sender.on("update", value => senderUpdates.push(value));
        localUnqualified.on("update", value => localUnqualifiedUpdates.push(value));

        const workerEmitter = new RedisStreamsRoomEmitter(redisWorker, {
            maxLen: 2_000,
            streamName: "socket.io",
        });
        if (publisher === "worker") eventRouter.setIo(workerEmitter);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        const protectedPayload = { body: { t: "update-session", id: session.id, phase: "initial" } };
        const senderSocket = ioA.sockets.sockets.get(sender.id!);
        if (!senderSocket) throw new Error("Missing admitted sender socket");
        const senderConnection: ClientConnection = { connectionType: "user-scoped", userId: actor.id, socket: senderSocket };
        await eventRouter.emitUpdate({
            userId: actor.id,
            payload: protectedPayload as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
            skipSenderConnection: senderConnection,
        });
        await eventRouter.emitUpdate({
            userId: directActor.id,
            payload: protectedPayload as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        await waitFor(() => qualifiedUpdates.length === 1 && localUpdates.length === 1
            && directUpdates.length === 1, "local, remote and direct delivery");
        await expectUnchangedFor(unqualifiedUpdates);
        expect(qualifiedUpdates).toEqual([protectedPayload]);
        expect(directUpdates).toEqual([protectedPayload]);
        expect(unqualifiedUpdates).toEqual([]);
        expect(localUnqualifiedUpdates).toEqual([]);
        expect(senderUpdates).toEqual([]);
        expect(localUpdates).toEqual([protectedPayload]);

        if (publisher === "api") {
            const adapter = ioB.of("/").adapter;
            const receiver = adapter as unknown as { onMessage(message: ClusterMessage, offset?: string): void };
            const onMessage = receiver.onMessage.bind(receiver);
            let held: (() => void) | undefined;
            const transport = vi.spyOn(receiver, "onMessage").mockImplementation((message, offset) => {
                if (message.type === MessageType.SERVER_SIDE_EMIT
                    && message.data.packet[0] === CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT) {
                    held = () => onMessage(message, offset);
                    return;
                }
                onMessage(message, offset);
            });
            await eventRouter.emitUpdate({ userId: actor.id, payload: {
                body: { t: "update-session", id: session.id, phase: "in-flight-revocation" },
            } as never, recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
                skipSenderConnection: senderConnection });
            await waitFor(() => held !== undefined && localUpdates.length === 2, "held remote delivery and entitled local delivery");
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            transport.mockRestore();
            held!();
            await expectUnchangedFor(qualifiedUpdates);
            expect(qualifiedUpdates).toEqual([protectedPayload]);
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
        }

        await workerEmitter.serverSideEmit(CREDENTIAL_QUALIFIED_SESSION_DELIVERY_EVENT, {
            v: 1,
            accountId: actor.id,
            sessionId: session.id,
            eventName: "update",
            payload: { body: { t: "update-session", phase: "forged" } },
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        } as unknown as CredentialQualifiedSessionDeliveryV1);
        await expectUnchangedFor(qualifiedUpdates);

        await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
        await eventRouter.emitUpdate({
            userId: actor.id,
            payload: { body: { t: "update-session", phase: "revoked" } } as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        await expectUnchangedFor(qualifiedUpdates);

        await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "0";
        await eventRouter.emitUpdate({
            userId: actor.id,
            payload: { body: { t: "update-session", phase: "disabled" } } as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        await expectUnchangedFor(qualifiedUpdates);

        process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
        await db.session.delete({ where: { id: session.id } });
        const unqualifiedCountBeforeDelete = unqualifiedUpdates.length;
        await eventRouter.emitUpdate({
            userId: actor.id,
            payload: { body: { t: "new-message", sid: session.id, msg: {} } } as never,
            recipientFilter: { type: "all-interested-in-session", sessionId: session.id },
        });
        await expectUnchangedFor(qualifiedUpdates);
        await expectUnchangedFor(unqualifiedUpdates);

        await emitSessionDeletedUpdate({
            sessionId: session.id,
            accountId: actor.id,
            cursor: 99,
        });
        await waitFor(
            () => qualifiedUpdates.length === 2 && unqualifiedUpdates.length === unqualifiedCountBeforeDelete + 1,
            "typed post-delete Account hint",
        );
        await expectUnchangedFor(qualifiedUpdates);
        expect(qualifiedUpdates[1]).toMatchObject({ body: { t: "delete-session", sid: session.id } });
        expect(unqualifiedUpdates.at(-1)).toMatchObject({ body: { t: "delete-session", sid: session.id } });
    }, 60_000);
});
