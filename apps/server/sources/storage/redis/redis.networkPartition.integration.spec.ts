import { createServer, createConnection, type Socket } from "node:net";

import { RedisMemoryServer } from "redis-memory-server";
import type { Server, Socket as SocketIoSocket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSocketRooms } from "@/app/api/socketRooms";
import { resolveRedisAdapterValidationRedisUrl } from "../../../scripts/resolveRedisAdapterValidationRedisUrl";

type SilentPartitionProxy = Readonly<{
    url: string;
    partition(): void;
    heal(): void;
    waitForForwardedCommand(command: string): Promise<void>;
    close(): Promise<void>;
}>;

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

async function startSilentPartitionProxy(upstreamUrl: string): Promise<SilentPartitionProxy> {
    const upstream = new URL(upstreamUrl);
    const upstreamPort = Number(upstream.port || "6379");
    let partitioned = false;
    const downstreamSockets = new Set<Socket>();
    const upstreamSockets = new Set<Socket>();
    const forwardedCommands = new Set<string>();
    const commandWaiters = new Map<string, Set<() => void>>();

    const markForwardedCommand = (chunk: Buffer): void => {
        const text = chunk.toString("utf8").toLowerCase();
        for (const command of ["xread", "ping"]) {
            if (!text.includes(command)) continue;
            forwardedCommands.add(command);
            for (const resolve of commandWaiters.get(command) ?? []) resolve();
            commandWaiters.delete(command);
        }
    };

    const server = createServer((downstream) => {
        downstreamSockets.add(downstream);
        if (partitioned) {
            downstream.destroy();
            return;
        }
        const redis = createConnection({
            host: upstream.hostname,
            port: upstreamPort,
        });
        upstreamSockets.add(redis);
        downstream.on("data", (chunk: Buffer) => {
            if (partitioned || !redis.writable) return;
            markForwardedCommand(chunk);
            redis.write(chunk);
        });
        redis.on("data", (chunk: Buffer) => {
            if (!partitioned && downstream.writable) downstream.write(chunk);
        });
        downstream.on("close", () => {
            downstreamSockets.delete(downstream);
            redis.destroy();
        });
        redis.on("close", () => {
            upstreamSockets.delete(redis);
            downstream.destroy();
        });
        downstream.on("error", () => {});
        redis.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Silent partition proxy did not expose a TCP port");
    }

    return {
        url: `redis://127.0.0.1:${address.port}`,
        partition: () => {
            partitioned = true;
        },
        heal: () => {
            partitioned = false;
        },
        waitForForwardedCommand: async (command) => {
            const normalized = command.toLowerCase();
            if (forwardedCommands.has(normalized)) return;
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(
                    new Error(`Timed out waiting for ${normalized} through silent partition proxy`),
                ), 2_000);
                const waiter = () => {
                    clearTimeout(timeout);
                    resolve();
                };
                const waiters = commandWaiters.get(normalized) ?? new Set();
                waiters.add(waiter);
                commandWaiters.set(normalized, waiters);
            });
        },
        close: async () => {
            for (const socket of downstreamSockets) socket.destroy();
            for (const socket of upstreamSockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
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
        const redisMemory = await RedisMemoryServer.create();
        cleanup.push(async () => {
            await redisMemory.stop();
        });
        const redisUrl = `redis://${await redisMemory.getIp()}:${await redisMemory.getPort()}`;
        process.env.REDIS_URL = redisUrl;

        vi.resetModules();
        const { getRedisSocketClusterClient } = await import("./redis.js");
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
            config: { mode: "redis", redis },
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
            maxDurationMs: 30_000,
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
