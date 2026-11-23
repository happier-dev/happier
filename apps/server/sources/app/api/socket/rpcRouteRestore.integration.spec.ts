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

    it("leaves a mapping that another socket owns", async () => {
        const ownedByA = new Set(["machine-1:stop-session"]);
        const ownedByB = new Set(["machine-1:stop-session"]);
        const a = createCoordinator("socket-a", ownedByA);
        const b = createCoordinator("socket-b", ownedByB);
        await a.registerMethod("machine-1:stop-session");
        a.startRefreshLoopIfNeeded();
        // The daemon reconnected on another instance while the old socket lingers.
        await b.registerMethod("machine-1:stop-session");
        b.startRefreshLoopIfNeeded();

        await runRefreshTick();

        expect(await a.lookupSocketId(userId, "machine-1:stop-session")).toBe("socket-b");
        expect(logMock).not.toHaveBeenCalled();

        ownedByA.clear();
        ownedByB.clear();
        await a.stopRefreshLoopIfIdle();
        await b.stopRefreshLoopIfIdle();
    });

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
