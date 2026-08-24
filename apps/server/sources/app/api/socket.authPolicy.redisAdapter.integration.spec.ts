import Fastify from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";

import { auth } from "@/app/auth/auth";
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

vi.mock("@/storage/redis/redis", () => ({
    // Separate production replicas own separate process-local clients. This
    // in-process harness preserves that topology with two real Redis clients;
    // it does not replace the Redis Streams adapter or its transport.
    getRedisClient: () => redisRuntime.activeClient,
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
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
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
            const token = await auth.createToken(account.id);
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
});
