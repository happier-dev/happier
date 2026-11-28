import { randomUUID } from "node:crypto";
import type { Socket as TcpSocket } from "node:net";

import { RPC_ERROR_CODES, RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server, Socket } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getRedisClient } from "@/storage/redis/redis";
import { resolveRedisAdapterValidationRedisUrl } from "../../../../scripts/resolveRedisAdapterValidationRedisUrl";
import { createFakeSocket, getSocketHandler, triggerSocketHandler } from "../testkit/socketHarness";
import { rpcHandler } from "./rpcHandler";

const findMachine = vi.hoisted(() => vi.fn());
vi.mock("@/storage/db", () => ({ db: { machine: { findFirst: findMachine } } }));

const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logging/log", () => ({ log: vi.fn(), warn: warnMock }));

const machine = { revokedAt: null, replacedByMachineId: null };
const refreshIntervalMs = 60_000;

describe("Redis-backed RPC registration lifecycle", () => {
    let userId: string;
    let redis: ReturnType<typeof getRedisClient> | undefined;
    let redisMemory: Awaited<ReturnType<typeof resolveRedisAdapterValidationRedisUrl>>["redisMemory"];

    beforeAll(async () => {
        const redisTarget = await resolveRedisAdapterValidationRedisUrl({ env: process.env });
        redisMemory = redisTarget.redisMemory;
        vi.stubEnv("REDIS_URL", redisTarget.redisUrl);
        redis = getRedisClient();
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        findMachine.mockReset().mockResolvedValue(machine);
        warnMock.mockReset();
        userId = `rpc-route-${randomUUID()}`;
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        const redis = getRedisClient();
        const keys = await redis.keys(`rpc:${userId}:*`);
        if (keys.length > 0) await redis.del(...keys);
    });

    afterAll(async () => {
        try {
            await Promise.all([redis?.quit(), getRedisClient("fail-on-disconnect").quit()]);
        } finally {
            vi.unstubAllEnvs();
            await redisMemory?.stop();
        }
    });

    const routeKey = (method: string) => `rpc:${userId}:${method}`;

    async function runRefreshTick() {
        vi.advanceTimersByTime(refreshIntervalMs);
        await getRedisClient("fail-on-disconnect").ping();
    }

    function attach(
        socket: ReturnType<typeof createFakeSocket>,
        io: Server,
        instanceId: string,
        listeners = new Map<string, Socket>(),
    ) {
        rpcHandler(userId, socket as unknown as Socket, listeners, new Map([[userId, listeners]]), {
            io,
            redisRegistry: { enabled: true, instanceId },
        });
        return socket;
    }

    function machineSocket() {
        return createFakeSocket({ id: "machine-socket", data: { clientType: "machine-scoped", machineId: "machine-1" } });
    }

    async function call(socket: ReturnType<typeof createFakeSocket>, method: string) {
        const reply = vi.fn();
        await getSocketHandler(socket, SOCKET_RPC_EVENTS.CALL)({ method }, reply);
        return reply.mock.lastCall?.[0];
    }

    it.each(["missing target", "empty acknowledgement", "failed acknowledgement"] as const)(
        "keeps the live route after a forwarding failure (%s)",
        async failure => {
            const method = `machine-1:${RPC_METHODS.SPAWN_HAPPY_SESSION}`;
            const target = attach(machineSocket(), {} as Server, "target-node");
            const fetchSockets = vi.fn().mockResolvedValue([target]);
            const emitWithAck = vi.fn().mockResolvedValue(["recovered"]);
            if (failure === "missing target") fetchSockets.mockResolvedValueOnce([]);
            if (failure === "empty acknowledgement") emitWithAck.mockResolvedValueOnce([]);
            if (failure === "failed acknowledgement") emitWithAck.mockRejectedValueOnce(new Error("adapter timed out"));
            const caller = attach(createFakeSocket({ id: "caller" }), {
                in: () => ({ fetchSockets }),
                timeout: () => ({ to: () => ({ emitWithAck }) }),
            } as unknown as Server, "caller-node");

            await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(await getRedisClient().hget(routeKey(method), "socketId")).toBe(target.id);
            expect(await call(caller, method)).toMatchObject({ ok: false });
            expect(await getRedisClient().hget(routeKey(method), "socketId")).toBe(target.id);
            expect(await call(caller, method)).toEqual({ ok: true, result: "recovered" });
            await triggerSocketHandler(target, "disconnect");
        },
    );

    it("waits for a replacement when the registered remote socket is unreachable", async () => {
        const method = `machine-1:${RPC_METHODS.SPAWN_HAPPY_SESSION}`;
        const previous = attach(machineSocket(), {} as Server, "previous-node");
        const replacement = attach(createFakeSocket({
            id: "replacement", data: { clientType: "machine-scoped", machineId: "machine-1" },
        }), {} as Server, "replacement-node");
        let signalMissing!: () => void;
        const previousWasMissing = new Promise<void>(resolve => { signalMissing = resolve; });
        const inRoom = vi.fn((id: string) => ({
            fetchSockets: async () => {
                if (id === replacement.id) return [replacement];
                signalMissing();
                return [];
            },
        }));
        const to = vi.fn(() => ({ emitWithAck: async () => ["replacement"] }));
        const caller = attach(createFakeSocket({ id: "caller" }), {
            in: inRoom,
            timeout: () => ({ to }),
        } as unknown as Server, "caller-node");

        try {
            await triggerSocketHandler(previous, SOCKET_RPC_EVENTS.REGISTER, { method });
            const response = call(caller, method);
            await previousWasMissing;
            await triggerSocketHandler(replacement, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(await response).toEqual({ ok: true, result: "replacement" });
            expect(inRoom.mock.calls).toEqual([[previous.id], [replacement.id]]);
            expect(to.mock.calls).toEqual([[replacement.id]]);
        } finally {
            await triggerSocketHandler(previous, "disconnect");
            await triggerSocketHandler(replacement, "disconnect");
        }
    });

    it("waits for a replacement for an ordinary scoped method before forwarding", async () => {
        const method = "scope:example";
        const previous = attach(createFakeSocket({ id: "previous" }), {} as Server, "previous-node");
        const replacement = attach(createFakeSocket({ id: "replacement" }), {} as Server, "replacement-node");
        const to = vi.fn((id: string) => ({
            emitWithAck: async () => id === replacement.id ? ["replacement"] : [],
        }));
        const caller = attach(createFakeSocket({ id: "caller" }), {
            timeout: () => ({ to }),
        } as unknown as Server, "caller-node");

        try {
            await triggerSocketHandler(previous, SOCKET_RPC_EVENTS.REGISTER, { method });
            const lookup = vi.spyOn(getRedisClient("fail-on-disconnect"), "hmget");
            const response = call(caller, method);
            await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith(routeKey(method), "socketId"));
            const firstRead = lookup.mock.results[0].value;
            expect(await firstRead).toEqual([previous.id]);
            await triggerSocketHandler(replacement, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(await response).toEqual({ ok: true, result: "replacement" });
            expect(to.mock.calls).toEqual([[replacement.id]]);
        } finally {
            await triggerSocketHandler(previous, "disconnect");
            await triggerSocketHandler(replacement, "disconnect");
        }
    });

    it("does not replay an unacknowledged registration over a newer owner", async () => {
        const method = "example";
        const target = attach(createFakeSocket({ id: "first" }), {} as Server, "first-node");
        const registry = getRedisClient("fail-on-disconnect");
        const observer = getRedisClient();
        const key = routeKey(method);
        await registry.ping();
        // Hold replies at the TCP boundary without withholding the write from Redis.
        const stream = (registry as unknown as { connector: { stream: TcpSocket } }).connector.stream;
        stream.pause();
        try {
            const registration = triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
            await vi.waitFor(async () => expect(await observer.hget(key, "socketId")).toBe(target.id));
            await observer.hset(key, "instanceId", "second-node", "socketId", "second");
            stream.destroy();

            await registration;
            await registry.ping();
            expect(await observer.hget(key, "socketId")).toBe("second");
        } finally {
            stream.destroy();
            await triggerSocketHandler(target, "disconnect");
        }
    });

    it("retries owner withdrawal when the first deletion failed", async () => {
        const method = "example";
        const target = attach(createFakeSocket({ id: "target" }), {} as Server, "target-node");
        const redis = getRedisClient();
        const key = routeKey(method);
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
        const fields = await redis.hgetall(key);
        await redis.set(key, "wrong-type");
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        expect(target.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, expect.objectContaining({ type: "unregister" }));

        await redis.del(key);
        await redis.hset(key, fields);
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        expect(await redis.exists(key)).toBe(0);
    });

    it.each(["unregister", "disconnect"] as const)(
        "does not publish a route after %s during registration admission",
        async withdrawal => {
            const method = "machine-1:example";
            const target = attach(machineSocket(), {} as Server, "target-node");
            let finishAdmission!: (value: typeof machine) => void;
            findMachine.mockImplementationOnce(() => new Promise<typeof machine>(resolve => { finishAdmission = resolve; }));

            const registration = triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(findMachine).toHaveBeenCalled();
            if (withdrawal === "unregister") {
                await triggerSocketHandler(target, SOCKET_RPC_EVENTS.UNREGISTER, { method });
            } else {
                target.connected = false;
                await triggerSocketHandler(target, "disconnect");
            }
            finishAdmission(machine);
            await registration;
            expect(await getRedisClient().exists(routeKey(method))).toBe(0);
            expect(target.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
            await triggerSocketHandler(target, "disconnect");
        },
    );

    it("routes a local caller and a remote caller to the same registered socket after takeover", async () => {
        const method = "some-method";
        const listenersA = new Map<string, Socket>();
        const listenersB = new Map<string, Socket>();
        const listenersC = new Map<string, Socket>();
        const old = createFakeSocket({
            id: "socket-old",
            timeout: () => ({ emitWithAck: async () => "old" }),
        });
        const current = createFakeSocket({ id: "socket-current" });
        const localCaller = createFakeSocket({ id: "local-caller" });
        const remoteCaller = createFakeSocket({ id: "remote-caller" });
        const io = {
            timeout: () => ({
                to: (id: string) => ({ emitWithAck: async () => [id === current.id ? "current" : "old"] }),
            }),
        } as unknown as Server;
        const attach = (socket: ReturnType<typeof createFakeSocket>, listeners: Map<string, Socket>, instanceId: string) =>
            rpcHandler(userId, socket as unknown as Socket, listeners, new Map([[userId, listeners]]), {
                io,
                redisRegistry: { enabled: true, instanceId },
            });
        attach(old, listenersA, "node-a");
        attach(localCaller, listenersA, "node-a");
        attach(current, listenersB, "node-b");
        attach(remoteCaller, listenersC, "node-c");
        await triggerSocketHandler(old, SOCKET_RPC_EVENTS.REGISTER, { method });
        await triggerSocketHandler(current, SOCKET_RPC_EVENTS.REGISTER, { method });
        await runRefreshTick();
        const localReply = vi.fn();
        const remoteReply = vi.fn();
        try {
            await getSocketHandler(remoteCaller, SOCKET_RPC_EVENTS.CALL)({ method }, remoteReply);
            await getSocketHandler(localCaller, SOCKET_RPC_EVENTS.CALL)({ method }, localReply);
            expect(remoteReply).toHaveBeenCalledWith({ ok: true, result: "current" });
            expect(localReply).toHaveBeenCalledWith({ ok: true, result: "current" });
        } finally {
            await triggerSocketHandler(old, "disconnect");
            await triggerSocketHandler(current, "disconnect");
        }
    });

    it("keeps the current route through superseded cleanup and removes it on owner withdrawal", async () => {
        const method = "example";
        const older = attach(createFakeSocket({ id: "older" }), {} as Server, "first-node");
        const current = attach(createFakeSocket({ id: "current" }), {} as Server, "second-node");
        const redis = getRedisClient();

        await triggerSocketHandler(older, SOCKET_RPC_EVENTS.REGISTER, { method });
        await triggerSocketHandler(current, SOCKET_RPC_EVENTS.REGISTER, { method });
        await triggerSocketHandler(older, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await runRefreshTick();

        expect(await redis.hget(routeKey(method), "socketId")).toBe(current.id);
        await triggerSocketHandler(current, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await runRefreshTick();
        expect(await redis.exists(routeKey(method))).toBe(0);
    });

    it("never refreshes a route it no longer owns or recreates a missing route", async () => {
        const method = "example";
        const target = attach(createFakeSocket({ id: "older" }), {} as Server, "first-node");
        const redis = getRedisClient();
        const key = routeKey(method);
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
        await redis.hset(key, "socketId", "current", "instanceId", "second-node", "updatedAt", "unchanged");
        await runRefreshTick();
        expect(await redis.hmget(key, "socketId", "instanceId", "updatedAt")).toEqual(["current", "second-node", "unchanged"]);

        await redis.del(key);
        await runRefreshTick();
        expect(await redis.exists(key)).toBe(0);
        await triggerSocketHandler(target, "disconnect");
    });

    it("reports a rejected refresh and keeps refreshing when Redis recovers", async () => {
        const method = "example";
        const target = attach(createFakeSocket({ id: "target" }), {} as Server, "target-node");
        const redis = getRedisClient();
        const key = routeKey(method);
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
        const fields = await redis.hgetall(key);
        await redis.set(key, "wrong-type");
        await runRefreshTick();
        await vi.waitFor(() => expect(warnMock).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Failed to refresh")));

        await redis.del(key);
        await redis.hset(key, { ...fields, updatedAt: "before-refresh" });
        await runRefreshTick();
        expect(await redis.hget(key, "updatedAt")).not.toBe("before-refresh");
        await triggerSocketHandler(target, "disconnect");
    });

    it("does not forward through a local registration when the Redis route is absent", async () => {
        const method = "example";
        const listeners = new Map<string, Socket>();
        const target = attach(
            createFakeSocket({ id: "target", timeout: () => ({ emitWithAck: async () => "unreachable" }) }),
            {} as Server, "local-node", listeners,
        );
        const caller = attach(createFakeSocket({ id: "caller" }), {} as Server, "local-node", listeners);
        await triggerSocketHandler(target, SOCKET_RPC_EVENTS.REGISTER, { method });
        await getRedisClient().del(routeKey(method));
        expect(await call(caller, method)).toMatchObject({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        await triggerSocketHandler(target, "disconnect");
    });
});
