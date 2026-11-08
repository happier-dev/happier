import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Redis } from "ioredis";
import { Server } from 'socket.io';
import { io as ioClient } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { eventRouter } from "@/app/events/connectionEventRouter";
import { createMachinePresenceDeadlineOwner, createSessionPresenceDeadlineOwner, resolvePresenceTimeoutConfig, runPresenceTimeoutTick, startLocalMachinePresenceTimeout, stopLocalMachinePresenceTimeout } from "@/app/presence/timeout";
import { registerPresenceDeadlineNotifications } from '@/app/presence/presenceDeadlineNotification';
import { publishPresenceDeadline } from '@/app/presence/presenceRedisQueue';
import { persistMachinePresence } from '@/app/presence/persistMachinePresence';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { auth } from '@/app/auth/auth';
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
    // in-process harness preserves that topology with two real Redis clients.
    getRedisClient: () => redisRuntime.activeClient,
    getRedisSocketClusterAdapterClient: () => redisRuntime.activeClient,
    getRedisSocketClusterClient: () => redisRuntime.activeClient,
    createRedisSocketClusterRelayAdmissionClient: () => redisRuntime.activeClient,
    closeRedisSocketClusterClient: () => {},
}));

vi.mock("@/utils/process/shutdown", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/utils/process/shutdown")>();
    return {
        ...actual,
        onShutdown: (_name: string, callback: () => Promise<void>) => {
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
    io: Server;
    port: number;
    stopSocket: () => Promise<void>;
}>;

async function startReplica(params: Readonly<{ instanceId: string; redis: Redis }>): Promise<StartedReplica> {
    redisRuntime.activeClient = params.redis;
    process.env.HAPPIER_INSTANCE_ID = params.instanceId;

    const app = Fastify({ logger: false }) as unknown as AppFastify;
    const priorShutdownCallbacks = shutdownRuntime.callbacks.length;
    // Observe the actual network boundary without replacing the router's logic.
    const configuredTransport = vi.spyOn(eventRouter, 'setIo');
    startSocket(app);
    const io = configuredTransport.mock.calls.at(-1)?.[0];
    configuredTransport.mockRestore();
    if (!(io instanceof Server)) throw new Error('Expected the real Socket.IO transport');
    const stopSocket = shutdownRuntime.callbacks.at(priorShutdownCallbacks);
    if (!stopSocket) throw new Error("Socket replica did not register its shutdown callback");
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) {
        await app.close();
        throw new Error("Failed to bind Socket.IO replica");
    }
    return { app, io, port, stopSocket };
}

function createClient(params: Readonly<{
    port: number;
    auth: Readonly<Record<string, unknown>>;
}>): ReturnType<typeof ioClient> {
    return ioClient(`http://127.0.0.1:${params.port}`, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        autoConnect: false,
        auth: { ...params.auth },
    });
}

function waitForConnection(socket: ReturnType<typeof ioClient>): Promise<"connected" | "rejected"> {
    return new Promise((resolve) => {
        socket.once("connect", () => resolve("connected"));
        socket.once("connect_error", () => resolve("rejected"));
        socket.connect();
    });
}

function waitForDisconnect(socket: ReturnType<typeof ioClient>, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} stayed connected after Runner revocation`)), 8_000);
        socket.once("disconnect", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

describe("ephemeral Runner revocation with the configured Redis adapter", () => {
    let harness: LightSqliteHarness;
    let redisMemory: RedisMemoryInstance = null;
    const replicas: StartedReplica[] = [];
    const redisClients: Redis[] = [];
    const clients: Array<ReturnType<typeof ioClient>> = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-socket-redis-",
            initAuth: true,
            env: {
                HANDY_MASTER_SECRET: "runner-socket-redis-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        await stopLocalMachinePresenceTimeout();
        while (clients.length > 0) clients.pop()?.close();
        while (replicas.length > 0) {
            const replica = replicas.pop();
            if (!replica) continue;
            await replica.stopSocket();
            await replica.app.close();
        }
        // Socket.IO may already have closed its real adapter root client.
        // These test-owned connections have no remaining work after io.close.
        while (redisClients.length > 0) redisClients.pop()?.disconnect();
        if (redisMemory) {
            await redisMemory.stop();
            redisMemory = null;
        }
        redisRuntime.activeClient = null;
        eventRouter.clearIo();
        harness.resetEnv();
        await db.ephemeralRunnerActivation.deleteMany();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it('enrolls newly active Machine and Session deadlines on another replica and expires after producer loss', async () => {
        const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({ env: {} });
        redisMemory = resolvedRedis.redisMemory;
        harness.resetEnv({ SERVER_ROLE: 'api', HAPPIER_SOCKET_ADAPTER: 'redis-streams', REDIS_URL: resolvedRedis.redisUrl });
        const redisA = new Redis(resolvedRedis.redisUrl);
        const redisB = new Redis(resolvedRedis.redisUrl);
        redisClients.push(redisA, redisB);
        const replicaA = await startReplica({ instanceId: 'deadline-a', redis: redisA });
        const replicaB = await startReplica({ instanceId: 'deadline-b', redis: redisB });
        replicas.push(replicaA, replicaB);
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}', active: false } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', active: false } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const reader = createClient({ port: replicaA.port, auth: { token, clientType: 'user-scoped' } });
        clients.push(reader);
        expect(await waitForConnection(reader)).toBe('connected');
        const packets: Array<{ type: string; id: string; active: boolean; activeAt: number }> = [];
        reader.on('ephemeral', value => {
            if (value.type === 'machine-activity' || value.type === 'activity') packets.push(value);
        });
        const machines = createMachinePresenceDeadlineOwner();
        const sessions = createSessionPresenceDeadlineOwner();
        // Each replica has independent process-local owners. The extra real
        // owners represent B here; the socket harness shares module singletons.
        await machines.start();
        await sessions.start();
        const received: string[] = [];
        const release = registerPresenceDeadlineNotifications(replicaB.io, observation => {
            received.push(observation.id);
            if (observation.kind === 'machine') machines.schedule({ accountId: observation.accountId,
                machineId: observation.id, lastActiveAt: new Date(observation.activeAt) });
            else sessions.schedule(new Date(observation.activeAt));
        });
        const base = Date.now();
        const timeoutConfig = resolvePresenceTimeoutConfig();
        const contentAt = new Date('2025-01-01T00:00:00.000Z');
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(base);
        try {
            await persistMachinePresence(db, { accountId: account.id, machineId: machine.id, timestamp: base });
            const producer = await startLocalMachinePresenceTimeout();
            await db.session.update({ where: { id: session.id }, data: { active: true, lastActiveAt: new Date(base), updatedAt: contentAt } });
            eventRouter.setIo(replicaA.io);
            await publishPresenceDeadline({ kind: 'machine', accountId: account.id, id: machine.id, activeAt: base });
            await publishPresenceDeadline({ kind: 'session', accountId: account.id, id: session.id, activeAt: base });
            await vi.waitFor(() => expect(received.sort()).toEqual([machine.id, session.id].sort()));
            await producer.stop(); // Producer's real local deadline owner is gone.
            await vi.advanceTimersByTimeAsync(base + 20_000 - Date.now());
            await persistMachinePresence(db, { accountId: account.id, machineId: machine.id, timestamp: Date.now() });
            await vi.advanceTimersByTimeAsync(40_000);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(timeoutConfig.machineTimeoutMs - 40_000 - 1);
            expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await vi.waitFor(async () => expect((await db.machine.findUniqueOrThrow({ where: { id: machine.id } })).active).toBe(false));
            await vi.advanceTimersByTimeAsync(Math.max(0, base + timeoutConfig.sessionTimeoutMs - Date.now()));
            await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: session.id },
                select: { active: true, updatedAt: true } })).toEqual({ active: false, updatedAt: contentAt }));
            await vi.waitFor(() => expect(packets.filter(value => value.active === false)).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'machine-activity', id: machine.id, activeAt: base + 20_000 }),
                expect.objectContaining({ type: 'activity', id: session.id, activeAt: base }),
            ])));
            expect(packets.filter(value => value.active === false)).toHaveLength(2);
        } finally {
            release();
            await Promise.all([machines.stop(), sessions.stop(), stopLocalMachinePresenceTimeout()]);
            vi.useRealTimers();
        }
    });

    it("preserves Runner access after presence expiry and disconnects exact sockets across replicas on terminal revocation", async () => {
        const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({ env: process.env });
        redisMemory = resolvedRedis.redisMemory;
        harness.resetEnv({
            HANDY_MASTER_SECRET: "runner-socket-redis-secret",
            AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: resolvedRedis.redisUrl,
            HAPPY_SERVER_FLAVOR: "full",
        });

        const expiredPresenceAt = new Date(Date.now() - 30 * 60 * 1000);
        const fixture = await createMaterializedEphemeralRunnerFixture({
            sessionActive: true,
            sessionLastActiveAt: expiredPresenceAt,
        });
        // An ordinary persistent Machine on the same Account proves the revoke
        // targets the exact Machine room rather than the Account fanout.
        const siblingMachineId = `sibling-machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: siblingMachineId, accountId: fixture.accountId, metadata: "{}" },
        });

        const redisA = new Redis(resolvedRedis.redisUrl);
        const redisB = new Redis(resolvedRedis.redisUrl);
        redisClients.push(redisA, redisB);
        // Replica B starts last, so the terminal owner publishes through B while the
        // Runner sockets stay admitted on A: the disconnect must cross the adapter.
        const replicaA = await startReplica({ instanceId: "runner-revocation-replica-a", redis: redisA });
        const replicaB = await startReplica({ instanceId: "runner-revocation-replica-b", redis: redisB });
        replicas.push(replicaA, replicaB);

        const runnerSession = createClient({
            port: replicaA.port,
            auth: {
                token: fixture.token,
                clientType: "session-scoped",
                sessionId: fixture.sessionId,
                machineId: fixture.machineId,
            },
        });
        const runnerMachine = createClient({
            port: replicaA.port,
            auth: {
                token: fixture.token,
                clientType: "machine-scoped",
                machineId: fixture.machineId,
                runtimeId: fixture.activationId,
                startupSource: "ephemeral-runner",
                installationId: fixture.installationId,
                installationPublicKey: fixture.installationPublicKey,
                installationProof: fixture.installationProof,
            },
        });
        const creator = createClient({
            port: replicaA.port,
            auth: { token: fixture.accountToken, clientType: "user-scoped" },
        });
        const siblingMachine = createClient({
            port: replicaA.port,
            auth: {
                token: fixture.accountToken,
                clientType: "machine-scoped",
                machineId: siblingMachineId,
            },
        });
        // The creator's own Session socket carries no Machine binding, so it is a
        // participant of the shared Session rather than a member of the exact
        // Session+Machine room the revoke disconnects.
        const humanSession = createClient({
            port: replicaB.port,
            auth: {
                token: fixture.accountToken,
                clientType: "session-scoped",
                sessionId: fixture.sessionId,
            },
        });
        clients.push(runnerSession, runnerMachine, creator, siblingMachine, humanSession);
        await expect(Promise.all([
            waitForConnection(runnerSession),
            waitForConnection(runnerMachine),
            waitForConnection(creator),
            waitForConnection(siblingMachine),
            waitForConnection(humanSession),
        ])).resolves.toEqual(["connected", "connected", "connected", "connected", "connected"]);

        // Transport loss before the terminal transition is not revocation:
        // the same bearer is still admitted on reconnect.
        runnerSession.close();
        const runnerSessionAfterTransientLoss = createClient({
            port: replicaA.port,
            auth: {
                token: fixture.token,
                clientType: "session-scoped",
                sessionId: fixture.sessionId,
                machineId: fixture.machineId,
            },
        });
        clients.push(runnerSessionAfterTransientLoss);
        await expect(waitForConnection(runnerSessionAfterTransientLoss)).resolves.toBe("connected");

        await runPresenceTimeoutTick({
            sessionTimeoutMs: 60_000,
            machineTimeoutMs: 60_000,
            tickMs: 60_000,
        });
        expect((await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } })).active).toBe(false);
        expect((await db.machine.findUniqueOrThrow({ where: { id: fixture.machineId } })).revokedAt).toBeNull();
        expect(await db.accessKey.count({
            where: { accountId: fixture.accountId, machineId: fixture.machineId },
        })).toBe(1);
        expect(runnerSessionAfterTransientLoss.connected).toBe(true);
        expect(runnerMachine.connected).toBe(true);

        // Presence loss is recoverable. Explicit terminal cleanup revokes the
        // binding; these open-ended sockets close and later admissions fail.
        const publisher = createSessionPublisherPresence();
        const terminal = await publisher.captureMachineSessionTerminal({ binding: {
            accountId: fixture.accountId, sessionId: fixture.sessionId, machineId: fixture.machineId,
        } });
        expect(terminal.status).toBe("captured");
        if (terminal.status !== "captured") throw new Error("Expected the exact Runner terminal binding");
        const disconnected = Promise.all([
            waitForDisconnect(runnerSessionAfterTransientLoss, "Runner Session socket"),
            waitForDisconnect(runnerMachine, "Runner Machine socket"),
        ]);
        await expect(publisher.finalizeMachineSessionTerminal({ target: terminal.target }))
            .resolves.toEqual({ status: "already_inactive" });
        await disconnected;

        expect(creator.connected).toBe(true);
        expect(siblingMachine.connected).toBe(true);
        expect(humanSession.connected).toBe(true);
        await expect(db.machine.findUniqueOrThrow({
            where: { id: fixture.machineId },
            select: { active: true, revokedAt: true },
        })).resolves.toEqual({ active: false, revokedAt: expect.any(Date) });
        expect(await db.accessKey.count({
            where: { accountId: fixture.accountId, machineId: fixture.machineId },
        })).toBe(0);

        const sessionReconnect = createClient({
            port: replicaA.port,
            auth: {
                token: fixture.token,
                clientType: "session-scoped",
                sessionId: fixture.sessionId,
                machineId: fixture.machineId,
            },
        });
        const machineReconnect = createClient({
            port: replicaB.port,
            auth: {
                token: fixture.token,
                clientType: "machine-scoped",
                machineId: fixture.machineId,
                runtimeId: fixture.activationId,
                startupSource: "ephemeral-runner",
                installationId: fixture.installationId,
                installationPublicKey: fixture.installationPublicKey,
                installationProof: fixture.installationProof,
            },
        });
        clients.push(sessionReconnect, machineReconnect);
        await expect(Promise.all([
            waitForConnection(sessionReconnect),
            waitForConnection(machineReconnect),
        ])).resolves.toEqual(["rejected", "rejected"]);
    }, 60_000);
});
