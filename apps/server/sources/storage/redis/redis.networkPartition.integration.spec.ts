import { startSilentPartitionProxy } from "@/testkit/redisSilentPartitionProxy";

import type { Server, Socket as SocketIoSocket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";
import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

describe("Redis client silent network partition recovery", () => {
    const cleanup: Array<() => Promise<void>> = [];

    afterEach(async () => {
        delete process.env.REDIS_URL;
        while (cleanup.length > 0) await cleanup.pop()?.();
    });

    it("reconnects and accepts a fresh adapter command after a blocking read loses its TCP path", async () => {
        const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
            env: process.env,
        });
        if (redisMemory) cleanup.push(async () => {
            await redisMemory.stop();
        });
        const proxy = await startSilentPartitionProxy(redisUrl);
        cleanup.push(() => proxy.close());
        process.env.REDIS_URL = proxy.url;

        vi.resetModules();
        const { getRedisSocketClusterClient } = await import("./redis.js");
        const redis = getRedisSocketClusterClient();
        redis.on("error", () => {});
        cleanup.push(async () => {
            redis.disconnect(false);
        });

        await redis.ping();
        const socketClosed = new Promise<void>((resolve) => {
            redis.once("close", resolve);
        });
        const blockingRead = redis
            .xread("BLOCK", 100, "STREAMS", "socket.io-partition-test", "$")
            .catch(() => null);
        await proxy.waitForForwardedCommand("xread");
        proxy.partition();

        await expect(withTimeout(
            socketClosed,
            7_000,
            "Redis adapter socket did not close after its stall timeout",
        )).resolves.toBeUndefined();
        proxy.heal();

        await expect(withTimeout(
            redis.ping(),
            5_000,
            "Redis adapter command did not recover after network heal",
        )).resolves.toBe("PONG");
        await Promise.allSettled([blockingRead]);
    }, 30_000);

    it("does not let a pre-restart stall timer destroy the healthy replacement socket", async () => {
        const resolvedRedis = await resolveRedisAdapterValidationRedisUrl({
            env: {} as NodeJS.ProcessEnv,
        });
        if (!resolvedRedis.redisMemory) {
            throw new Error("Redis restart integration requires an embedded Redis instance");
        }
        const { redisMemory } = resolvedRedis;
        cleanup.push(async () => {
            await redisMemory.stop();
        });
        const redisUrl = resolvedRedis.redisUrl;
        process.env.REDIS_URL = redisUrl;

        vi.resetModules();
        const {
            createRedisSocketClusterRelayAdmissionClient,
            getRedisSocketClusterClient,
        } = await import("./redis.js");
        const { createPeerTcpTunnelRelayCoordinator } = await import(
            "@/app/api/socket/peer/mediation/tunnel/relayCoordinator"
        );
        const redis = getRedisSocketClusterClient();
        const errors: string[] = [];
        let closes = 0;
        redis.on("error", (error) => errors.push(error.message));
        redis.on("close", () => {
            closes += 1;
        });
        cleanup.push(async () => {
            redis.disconnect(false);
        });
        const accountId = "redis-restart-admission-account";
        const machineId = "redis-restart-admission-machine";
        const machineSocketId = "redis-restart-admission-socket";
        const machineSocket = {
            connected: true,
            id: machineSocketId,
            data: {
                userId: accountId,
                clientType: "machine-scoped",
                machineId,
            },
            rooms: new Set(getSocketRooms({
                userId: accountId,
                clientType: "machine-scoped",
                machineId,
            })),
            once: vi.fn(),
            off: vi.fn(),
        } as unknown as SocketIoSocket;
        const io = {
            sockets: {
                sockets: new Map([[machineSocketId, machineSocket]]),
            },
            on: vi.fn(),
            off: vi.fn(),
            in: vi.fn(() => ({
                local: {
                    fetchSockets: vi.fn(async () => [machineSocket]),
                },
            })),
            serverSideEmit: vi.fn(),
            to: vi.fn(() => ({
                emit: vi.fn(),
            })),
        } as unknown as Server;
        const coordinator = createPeerTcpTunnelRelayCoordinator({
            io,
            config: {
                mode: "redis",
                createRelayAdmissionRedis: createRedisSocketClusterRelayAdmissionClient,
            },
        });
        cleanup.push(async () => {
            await coordinator.close();
        });

        await redis.ping();
        let polling = true;
        const adapterPoll = (async () => {
            while (polling) {
                await redis
                    .xread("BLOCK", 100, "STREAMS", "socket.io-restart-test", "$")
                    .catch(() => null);
            }
        })();
        cleanup.push(async () => {
            polling = false;
            await adapterPoll;
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await redisMemory.stop();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await redisMemory.start();
        await withTimeout(
            redis.status === "ready"
                ? Promise.resolve()
                : new Promise<void>((resolve) => redis.once("ready", resolve)),
            10_000,
            "Redis adapter client did not become ready after Redis restart",
        );
        const closesAfterRecovery = closes;

        await expect(coordinator.admit({
            accountId,
            tunnelKey: `${accountId}:machine:${machineId}:user:post-restart`,
            grantId: "redis-restart-admission-grant",
            grantExpiresAt: Date.now() + 30_000,
            machineId,
            nowMs: Date.now(),
            onMachineEnvelope: vi.fn(),
            onMachineDisconnect: vi.fn(),
        })).resolves.toEqual({ status: "attached" });

        await new Promise((resolve) => setTimeout(resolve, 5_500));

        expect(errors).not.toContain(
            "Socket timeout. Expecting data, but didn't receive any in 5000ms.",
        );
        expect(closes).toBe(closesAfterRecovery);
        await expect(redis.xadd("socket.io-restart-test", "*", "nsp", "/")).resolves.toEqual(
            expect.any(String),
        );
        polling = false;
        await adapterPoll;
    }, 45_000);

    it("lets healthy shared-client blocking reads reach their Redis timeout without cycling the socket", async () => {
        const { redisUrl, redisMemory } = await resolveRedisAdapterValidationRedisUrl({
            env: process.env,
        });
        if (redisMemory) cleanup.push(async () => {
            await redisMemory.stop();
        });
        process.env.REDIS_URL = redisUrl;

        vi.resetModules();
        const { getRedisClient } = await import("./redis.js");
        const redis = getRedisClient();
        const errors: string[] = [];
        let closes = 0;
        redis.on("error", (error) => errors.push(error.message));
        redis.on("close", () => {
            closes += 1;
        });
        cleanup.push(async () => {
            redis.disconnect(false);
        });

        const stream = `presence-idle-review:${Date.now()}`;
        await redis.xgroup("CREATE", stream, "review", "$", "MKSTREAM");
        const startedAt = Date.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            redis.xreadgroup(
                "GROUP",
                "review",
                "consumer",
                "COUNT",
                1,
                "BLOCK",
                5_000,
                "STREAMS",
                stream,
                ">",
            ),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Healthy blocking read did not reach its Redis timeout"));
                }, 7_000);
            }),
        ]).finally(() => {
            if (timeout) clearTimeout(timeout);
        });

        expect(result).toBeNull();
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
        expect(errors).toEqual([]);
        expect(closes).toBe(0);
    }, 12_000);
});
