import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import type { Redis } from "ioredis";

import { SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT } from "@happier-dev/protocol";
import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { getRedisClient } from "@/storage/redis/redis";
import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";

// startSocket only closes its Socket.IO server from the process shutdown hook; capture it so each test
// node can stop its cluster-adapter polling instead of leaking it into the next test.
const socketShutdownHooks: Array<() => Promise<void>> = [];
vi.mock("@/utils/process/shutdown", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/process/shutdown")>()),
    onShutdown: (name: string, callback: () => Promise<void>) => {
        if (name === "api:socket") socketShutdownHooks.push(callback);
        return () => {};
    },
}));

// Two server instances in one test process would otherwise share the process-wide Redis client. The
// streams adapter reads with a blocking XREAD from offset `$`, so one node's XADD queued behind the other
// node's XREAD on the same connection is never observed. Production instances are separate processes
// with separate connections; give each test node its own connection to match.
const adapterRedisClients: Redis[] = [];
vi.mock("@socket.io/redis-streams-adapter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@socket.io/redis-streams-adapter")>();
    return {
        ...actual,
        createAdapter: (client: Redis, options?: Parameters<typeof actual.createAdapter>[1]) => {
            const dedicated = client.duplicate();
            adapterRedisClients.push(dedicated);
            return actual.createAdapter(dedicated, options);
        },
    };
});

type ClientSocket = ReturnType<typeof ioClient>;

async function connect(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("connect_error", reject);
        socket.connect();
    });
}

async function startNode(): Promise<{ url: string; close: () => Promise<void> }> {
    const app = Fastify({ logger: false }) as unknown as AppFastify;
    startSocket(app);
    const closeSocketServer = socketShutdownHooks.pop();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : null;
    if (!port) throw new Error("Failed to bind socket server");
    return {
        url: `http://127.0.0.1:${port}`,
        close: async () => {
            await closeSocketServer?.();
            await app.close();
        },
    };
}

async function seedRunnerSession() {
    const account = await db.account.create({ data: { publicKey: `pk-${Date.now()}` }, select: { id: true } });
    const machineId = `m-kill-${Date.now()}`;
    await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `session-${Date.now()}`,
            metadata: "{}",
            active: false,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 0n,
        },
        select: { id: true },
    });
    await db.accessKey.create({
        data: { accountId: account.id, machineId, sessionId: session.id, data: "encrypted" },
    });
    const token = await auth.createToken(account.id);
    return { sessionId: session.id, machineId, token };
}

function createRunner(url: string, seeded: Awaited<ReturnType<typeof seedRunnerSession>>): ClientSocket {
    return ioClient(url, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        autoConnect: false,
        auth: { token: seeded.token, clientType: "session-scoped", sessionId: seeded.sessionId, machineId: seeded.machineId },
    });
}

function createUi(url: string, token: string): ClientSocket {
    return ioClient(url, {
        path: "/v1/updates",
        transports: ["websocket"],
        reconnection: false,
        autoConnect: false,
        auth: { token },
    });
}

/** Connects the runner, registers its killSession handler, and makes it the session's current publisher. */
async function connectRegisteredRunner(params: Readonly<{
    runner: ClientSocket;
    sessionId: string;
    killMethod: string;
    killResponse: unknown;
}>): Promise<void> {
    const { runner, sessionId, killMethod, killResponse } = params;
    runner.on(SOCKET_RPC_EVENTS.REQUEST, (request: { method?: unknown }, acknowledge: (value: unknown) => void) => {
        if (request.method === killMethod) acknowledge(killResponse);
    });
    await connect(runner);
    await new Promise<void>((resolve) => {
        runner.once(SOCKET_RPC_EVENTS.REGISTERED, () => resolve());
        runner.emit(SOCKET_RPC_EVENTS.REGISTER, { method: killMethod });
    });
    const registered = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_SNAPSHOT_EVENT, {
        sessionId,
        mutationId: "register-runner",
        snapshot: { state: "active", activeCount: 1 },
    });
    expect(registered).toMatchObject({ status: "applied" });
    await expect(db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { active: true },
    })).resolves.toEqual({ active: true });
}

async function waitForDisconnectSettlement(sessionId: string) {
    return await waitFor(async () => {
        const stored = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: { active: true, runtimeActivityState: true },
        });
        return stored.runtimeActivityState === "active" ? null : stored;
    }, "disconnect settlement");
}

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-socket-kill-session-disconnect-",
        initAuth: true,
        initEncrypt: true,
    });
}, 120_000);
afterAll(async () => await harness.close());
beforeEach(() => harness.resetEnv());
afterEach(async () => {
    await db.accessKey.deleteMany();
    await db.session.deleteMany();
    await db.machine.deleteMany();
    await db.account.deleteMany();
});

describe("session-scoped killSession followed by runner disconnect", () => {
    async function runKillThenDisconnect(runnerKillResponse: unknown, closePublisher = false) {
        const seeded = await seedRunnerSession();
        const node = await startNode();
        const runner = createRunner(node.url, seeded);
        const ui = createUi(node.url, seeded.token);
        const sessionUpdates: Array<Record<string, unknown>> = [];
        ui.on("update", (update: { body?: Record<string, unknown> }) => {
            if (update.body?.t === "update-session" && update.body.id === seeded.sessionId) sessionUpdates.push(update.body);
        });
        const killMethod = `${seeded.sessionId}:${RPC_METHODS.KILL_SESSION}`;

        try {
            await connectRegisteredRunner({ runner, sessionId: seeded.sessionId, killMethod, killResponse: runnerKillResponse });

            await connect(ui);
            const killed = await ui.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: killMethod,
                params: "opaque-encrypted-kill-request",
            });
            expect(killed).toEqual({ ok: true, result: runnerKillResponse });
            // An RPC response cannot prove that the runner physically exited.
            await expect(db.session.findUniqueOrThrow({
                where: { id: seeded.sessionId },
                select: { active: true },
            })).resolves.toEqual({ active: true });

            if (closePublisher) {
                const closed = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, {
                    sessionId: seeded.sessionId,
                });
                expect(closed).toMatchObject({ status: "closed", sessionId: seeded.sessionId });
            }

            runner.close();
            // Every disconnect of the current publisher settles Activity away from `active`.
            const settled = await waitForDisconnectSettlement(seeded.sessionId);
            if (closePublisher) {
                await waitFor(async () => (sessionUpdates.some((body) => body.active === false) ? true : null), "inactive update");
            }
            return { settled, sessionUpdates };
        } finally {
            runner.close();
            ui.close();
            await node.close();
        }
    }

    it.each([
        { label: "an opaque encrypted response", response: "opaque-encrypted-response" },
        { label: "an accepted stop request", response: { status: "requested" } },
        { label: "a rejected stop request", response: { error: "Kill failed", errorCode: "RPC_FAILED" } },
    ])("keeps the session active after $label and an ordinary disconnect", async ({ response }) => {
        const { settled, sessionUpdates } = await runKillThenDisconnect(response);

        expect(settled).toEqual({ active: true, runtimeActivityState: "unknown" });
        expect(sessionUpdates.some((body) => body.active === false)).toBe(false);
    }, 30_000);

    it("closes the publisher through the runner's acknowledged clean-close event", async () => {
        const { settled, sessionUpdates } = await runKillThenDisconnect("opaque-encrypted-response", true);

        expect(settled).toEqual({ active: false, runtimeActivityState: "unknown" });
        expect(sessionUpdates.some((body) => body.active === false)).toBe(true);
    }, 30_000);
});

// Cluster validation consumes the lane's Redis service; the normal integration lane does not download
// or compile a Redis binary as part of a timed test hook.
const redisUrl = process.env.REDIS_URL?.trim();

describe.skipIf(!redisUrl)("session-scoped killSession relayed to a runner on another Redis-adapter instance", () => {
    afterAll(async () => {
        await Promise.all(adapterRedisClients.map(async (client) => await client.quit()));
        await getRedisClient().quit();
    });
    beforeEach(() => harness.resetEnv({ HAPPIER_SOCKET_ADAPTER: "redis-streams", REDIS_URL: redisUrl }));

    it("closes the publisher on its owning instance through the runner's acknowledged clean-close event", async () => {
        const seeded = await seedRunnerSession();
        const runnerNode = await startNode();
        const callerNode = await startNode();
        const runner = createRunner(runnerNode.url, seeded);
        const ui = createUi(callerNode.url, seeded.token);
        const killMethod = `${seeded.sessionId}:${RPC_METHODS.KILL_SESSION}`;

        try {
            await connectRegisteredRunner({
                runner,
                sessionId: seeded.sessionId,
                killMethod,
                killResponse: "opaque-encrypted-requested-ack",
            });

            await connect(ui);
            const killed = await ui.timeout(5_000).emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: killMethod,
                params: "opaque-encrypted-kill-request",
            });
            expect(killed).toEqual({ ok: true, result: "opaque-encrypted-requested-ack" });
            const closed = await runner.timeout(5_000).emitWithAck(SESSION_RUNTIME_ACTIVITY_CLOSE_EVENT, {
                sessionId: seeded.sessionId,
            });
            expect(closed).toMatchObject({ status: "closed", sessionId: seeded.sessionId });

            runner.close();
            const settled = await waitForDisconnectSettlement(seeded.sessionId);
            expect(settled.active).toBe(false);
        } finally {
            runner.close();
            ui.close();
            await callerNode.close();
            await runnerNode.close();
        }
    }, 30_000);
});
