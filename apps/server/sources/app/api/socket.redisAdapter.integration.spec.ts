import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvReset } from "./testkit/env";
import type { Fastify as AppFastify } from "./types";
import { startSocket } from "./socket";
const serverCtor = vi.fn();
vi.mock("socket.io", () => ({
    Server: function ServerMock(this: any, ...args: any[]) {
        return serverCtor(...args);
    },
}));

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown: vi.fn(),
}));

const createAdapter = vi.fn((_client: any, opts?: any) => ({ name: "adapter", opts }));
vi.mock("@socket.io/redis-streams-adapter", () => ({
    createAdapter: (arg: any, opts?: any) => createAdapter(arg, opts),
}));

const redisClient = { name: "redis" };
const getRedisClient = vi.fn(() => redisClient);
vi.mock("@/storage/redis/redis", () => ({
    getRedisClient: () => getRedisClient(),
}));

function createFastifyLikeApp(): AppFastify {
    return { server: {} } as unknown as AppFastify;
}

describe("startSocket redis adapter config", () => {
    const resetSocketAdapterEnv = createEnvReset();

    beforeEach(() => {
        // NOTE:
        // startSocket reads process.env at call time, so module caching does not affect these tests.
        // Avoid vi.resetModules(): it would re-evaluate modules that register global prom-client metrics.
        vi.clearAllMocks();
        serverCtor.mockReturnValue({ on: vi.fn(), close: vi.fn(), to: vi.fn(), use: vi.fn() });
        resetSocketAdapterEnv();
    });

    afterEach(() => {
        resetSocketAdapterEnv();
    });

    it("enables redis-streams adapter when explicitly configured in full flavor", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).toHaveBeenCalledWith(
            redisClient,
            expect.objectContaining({
                maxLen: 200000,
                readCount: 2000,
            }),
        );
        expect(serverCtor).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                adapter: {
                    name: "adapter",
                    opts: {
                        maxLen: 200000,
                        readCount: 2000,
                    },
                },
            }),
        );
    });

    it("enables adapter in light flavor when explicitly configured", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "light",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).toHaveBeenCalledWith(
            redisClient,
            expect.objectContaining({
                maxLen: 200000,
                readCount: 2000,
            }),
        );
        const options = serverCtor.mock.calls[0]?.[1];
        expect(options?.adapter).toEqual({
            name: "adapter",
            opts: {
                maxLen: 200000,
                readCount: 2000,
            },
        });
    });

    it("keeps memory adapter when redis-streams is requested without REDIS_URL", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: undefined,
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).not.toHaveBeenCalled();
        expect(getRedisClient).not.toHaveBeenCalled();
        expect(serverCtor).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ adapter: expect.anything() }));
    });

    it("keeps memory adapter when explicit adapter token is unsupported", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: "not-a-real-adapter",
            REDIS_URL: "redis://localhost:6379",
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).not.toHaveBeenCalled();
        expect(getRedisClient).not.toHaveBeenCalled();
    });

    it("supports the legacy boolean redis adapter flag when REDIS_URL is present", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: undefined,
            HAPPIER_SOCKET_REDIS_ADAPTER: "1",
            REDIS_URL: "redis://localhost:6379",
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).toHaveBeenCalledWith(
            redisClient,
            expect.objectContaining({
                maxLen: 200000,
                readCount: 2000,
            }),
        );
    });

    it("passes through explicit adapter tuning overrides", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
            HAPPIER_SOCKET_ADAPTER_MAXLEN: "54321",
            HAPPIER_SOCKET_ADAPTER_READ_COUNT: "222",
        });

        startSocket(createFastifyLikeApp());

        expect(createAdapter).toHaveBeenCalledWith(
            redisClient,
            expect.objectContaining({
                maxLen: 54321,
                readCount: 222,
            }),
        );
    });
});
