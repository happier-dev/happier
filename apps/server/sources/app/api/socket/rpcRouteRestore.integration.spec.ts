import { randomUUID } from "node:crypto";

import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import type { Server, Socket } from "socket.io";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRedisClient } from "@/storage/redis/redis";

import { createFakeSocket, triggerSocketHandler } from "../testkit/socketHarness";
import { rpcHandler } from "./rpcHandler";
import { createRpcRedisRegistryCoordinator } from "./rpcRedisRegistryCoordinator";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logging/log", () => ({ log: logMock }));

// The Lua scripts are the contract under test, so these run against a real Redis. The cluster
// validation lane provides one through REDIS_URL; without it the suite is skipped.
const redisUrl = process.env.REDIS_URL?.trim();

// Default registry TTL is 120s, so each socket refreshes its mappings every 60s.
const REFRESH_INTERVAL_MS = 60_000;

describe.skipIf(!redisUrl)("RPC route restore across instances", () => {
    let userId = "";

    beforeEach(() => {
        vi.stubEnv("REDIS_URL", redisUrl ?? "");
        // Only the refresh loop's interval is faked; ioredis keeps its real timers.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        logMock.mockReset();
        userId = `rpc-route-restore-${randomUUID()}`;
    });

    afterEach(async () => {
        vi.useRealTimers();
        const redis = getRedisClient();
        const keys = await redis.keys(`rpc:${userId}:*`);
        if (keys.length > 0) await redis.del(...keys);
        vi.unstubAllEnvs();
    });

    afterAll(async () => {
        if (redisUrl) await getRedisClient().quit();
    });

    // Fires every pending refresh, then waits for its evals: commands on the shared client run in order.
    async function runRefreshTick(): Promise<void> {
        vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
        await getRedisClient().ping();
    }

    function createCoordinator(socketId: string, ownedMethods: Set<string>) {
        return createRpcRedisRegistryCoordinator({
            config: { enabled: true, instanceId: `instance-${socketId}` },
            userId,
            socketId,
            ownedMethods,
        });
    }

    it("restores a connected socket's mapping after a failed forward deleted it", async () => {
        const ownedMethods = new Set(["machine-1:spawn-happy-session"]);
        const coordinator = createCoordinator("socket-a", ownedMethods);
        await coordinator.registerMethod("machine-1:spawn-happy-session");
        coordinator.startRefreshLoopIfNeeded();

        // What rpcHandler does when a forwarded call fails or fetchSockets misses the target.
        await coordinator.removeSocketRegistration(userId, "machine-1:spawn-happy-session", "socket-a");
        expect(await coordinator.lookupSocketId(userId, "machine-1:spawn-happy-session")).toBeNull();

        await runRefreshTick();

        expect(await coordinator.lookupSocketId(userId, "machine-1:spawn-happy-session")).toBe("socket-a");
        await vi.waitFor(() =>
            expect(logMock).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("machine-1:spawn-happy-session")),
        );

        ownedMethods.clear();
        await coordinator.stopRefreshLoopIfIdle();
    });

    it("gives a deleted route back to the newer of two connected sockets", async () => {
        const method = "machine-1:spawn-happy-session";
        const ownedByOlder = new Set([method]);
        const ownedByNewer = new Set([method]);
        const older = createCoordinator("socket-old", ownedByOlder);
        const newer = createCoordinator("socket-new", ownedByNewer);
        await older.registerMethod(method);
        older.startRefreshLoopIfNeeded();
        // The daemon reconnected (here or on another instance) while its old socket lingers.
        await newer.registerMethod(method);
        newer.startRefreshLoopIfNeeded();

        // A forward to the newer socket fails before the older one has refreshed; the older
        // socket's refresh runs first in the next tick.
        await newer.removeSocketRegistration(userId, method, "socket-new");
        await runRefreshTick();
        expect(await newer.lookupSocketId(userId, method)).toBe("socket-new");

        // Once the older socket has seen the newer registration it stops claiming the method.
        await runRefreshTick();
        await newer.removeSocketRegistration(userId, method, "socket-new");
        await runRefreshTick();
        expect(await newer.lookupSocketId(userId, method)).toBe("socket-new");

        ownedByOlder.clear();
        ownedByNewer.clear();
        await older.stopRefreshLoopIfIdle();
        await newer.stopRefreshLoopIfIdle();
    });

    it("leaves a mapping an older server wrote without a registration time, and restores once it is gone", async () => {
        const method = "machine-1:stop-session";
        const ownedMethods = new Set([method]);
        const coordinator = createCoordinator("socket-a", ownedMethods);
        await coordinator.registerMethod(method);
        coordinator.startRefreshLoopIfNeeded();
        const key = `rpc:${userId}:${method}`;
        await getRedisClient().del(key);
        await getRedisClient().hset(key, "socketId", "socket-legacy", "instanceId", "instance-legacy", "updatedAt", "1");
        await getRedisClient().expire(key, 120);

        await runRefreshTick();

        expect(await coordinator.lookupSocketId(userId, method)).toBe("socket-legacy");

        // Without a registration time the order is unknown, so the socket keeps its claim and
        // restores the route once the older server's mapping is gone.
        await getRedisClient().del(key);
        await runRefreshTick();

        expect(await coordinator.lookupSocketId(userId, method)).toBe("socket-a");

        ownedMethods.clear();
        await coordinator.stopRefreshLoopIfIdle();
    });

    it("keeps its claim when an older server hands the mapping to another socket", async () => {
        const method = "machine-1:stop-session";
        const ownedMethods = new Set([method]);
        const coordinator = createCoordinator("socket-a", ownedMethods);
        await coordinator.registerMethod(method);
        coordinator.startRefreshLoopIfNeeded();
        const key = `rpc:${userId}:${method}`;
        // An older server registers its socket with a plain HSET, which leaves our registeredAt.
        await getRedisClient().hset(key, "socketId", "socket-legacy", "instanceId", "instance-legacy", "updatedAt", "1");

        await runRefreshTick();
        expect(await coordinator.lookupSocketId(userId, method)).toBe("socket-legacy");

        await getRedisClient().del(key);
        await runRefreshTick();
        expect(await coordinator.lookupSocketId(userId, method)).toBe("socket-a");

        ownedMethods.clear();
        await coordinator.stopRefreshLoopIfIdle();
    });

    it("reports a refresh that Redis rejects", async () => {
        const method = "machine-1:spawn-happy-session";
        const ownedMethods = new Set([method]);
        const coordinator = createCoordinator("socket-a", ownedMethods);
        await coordinator.registerMethod(method);
        coordinator.startRefreshLoopIfNeeded();
        // A key of the wrong type makes every hash command on it fail.
        await getRedisClient().set(`rpc:${userId}:${method}`, "not-a-hash");

        await runRefreshTick();

        await vi.waitFor(() =>
            expect(logMock).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }), expect.stringContaining(method)),
        );

        ownedMethods.clear();
        await coordinator.stopRefreshLoopIfIdle();
    });

    it("restores nothing for a socket that unregistered a method another socket had taken over", async () => {
        const method = "machine-1:spawn-happy-session";
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([[userId, userRpcListeners]]);
        const ctx = { io: {} as Server, redisRegistry: { enabled: true as const, instanceId: "instance-1" } };
        const first = createFakeSocket({ id: "socket-1", emit: vi.fn() });
        const second = createFakeSocket({ id: "socket-2", emit: vi.fn() });
        rpcHandler(userId, first as unknown as Socket, userRpcListeners, allRpcListeners, ctx);
        rpcHandler(userId, second as unknown as Socket, userRpcListeners, allRpcListeners, ctx);

        await triggerSocketHandler(first, SOCKET_RPC_EVENTS.REGISTER, { method });
        await triggerSocketHandler(second, SOCKET_RPC_EVENTS.REGISTER, { method });
        await triggerSocketHandler(first, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await triggerSocketHandler(second, SOCKET_RPC_EVENTS.UNREGISTER, { method });
        await getRedisClient().ping();

        await runRefreshTick();

        expect(await createCoordinator("observer", new Set()).lookupSocketId(userId, method)).toBeNull();

        await triggerSocketHandler(first, "disconnect");
        await triggerSocketHandler(second, "disconnect");
    });

    for (const release of ["unregisters", "disconnects"] as const) {
        it(`removes the route it restored when it ${release} after the socket that took over left first`, async () => {
            const method = "machine-1:spawn-happy-session";
            const userRpcListeners = new Map<string, Socket>();
            const allRpcListeners = new Map<string, Map<string, Socket>>([[userId, userRpcListeners]]);
            const ctx = { io: {} as Server, redisRegistry: { enabled: true as const, instanceId: "instance-1" } };
            const first = createFakeSocket({ id: "socket-1", emit: vi.fn() });
            const second = createFakeSocket({ id: "socket-2", emit: vi.fn() });
            rpcHandler(userId, first as unknown as Socket, userRpcListeners, allRpcListeners, ctx);
            rpcHandler(userId, second as unknown as Socket, userRpcListeners, allRpcListeners, ctx);
            const observer = createCoordinator("observer", new Set());

            await triggerSocketHandler(first, SOCKET_RPC_EVENTS.REGISTER, { method });
            await triggerSocketHandler(second, SOCKET_RPC_EVENTS.REGISTER, { method });
            await triggerSocketHandler(second, SOCKET_RPC_EVENTS.UNREGISTER, { method });
            // The first socket still serves the method, so its refresh brings the route back.
            await runRefreshTick();
            expect(await observer.lookupSocketId(userId, method)).toBe("socket-1");

            if (release === "unregisters") {
                await triggerSocketHandler(first, SOCKET_RPC_EVENTS.UNREGISTER, { method });
            } else {
                await triggerSocketHandler(first, "disconnect");
            }
            await getRedisClient().ping();

            expect(await observer.lookupSocketId(userId, method)).toBeNull();

            if (release === "unregisters") await triggerSocketHandler(first, "disconnect");
            await triggerSocketHandler(second, "disconnect");
        });
    }

    it("restores nothing for a socket that disconnected after another socket took its methods over", async () => {
        const userRpcListeners = new Map<string, Socket>();
        const allRpcListeners = new Map<string, Map<string, Socket>>([[userId, userRpcListeners]]);
        const ctx = { io: {} as Server, redisRegistry: { enabled: true as const, instanceId: "instance-1" } };
        const first = createFakeSocket({ id: "socket-1", emit: vi.fn() });
        const second = createFakeSocket({ id: "socket-2", emit: vi.fn() });
        rpcHandler(userId, first as unknown as Socket, userRpcListeners, allRpcListeners, ctx);
        rpcHandler(userId, second as unknown as Socket, userRpcListeners, allRpcListeners, ctx);

        await triggerSocketHandler(first, SOCKET_RPC_EVENTS.REGISTER, { method: "machine-1:spawn-happy-session" });
        await triggerSocketHandler(second, SOCKET_RPC_EVENTS.REGISTER, { method: "machine-1:spawn-happy-session" });
        await triggerSocketHandler(first, "disconnect");
        await triggerSocketHandler(second, "disconnect");
        await getRedisClient().ping();

        await runRefreshTick();

        const coordinator = createCoordinator("observer", new Set());
        expect(await coordinator.lookupSocketId(userId, "machine-1:spawn-happy-session")).toBeNull();
    });
});
