import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnvReset } from "./testkit/env";
import type { Fastify as AppFastify } from "./types";
import { startSocket } from "./socket";
import { REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS } from "@/config/socketAdapter";

const {
    closeRedisSocketClusterClient,
    onShutdown,
} = vi.hoisted(() => ({
    closeRedisSocketClusterClient: vi.fn(),
    onShutdown: vi.fn(),
}));
const serverCtor = vi.fn();
vi.mock("socket.io", () => ({
    Server: function ServerMock(this: any, ...args: any[]) {
        return serverCtor(...args);
    },
}));

vi.mock("@/utils/process/shutdown", () => ({
    onShutdown,
}));

const createAdapter = vi.fn((_client: any, opts?: any) => ({ name: "adapter", opts }));
vi.mock("@socket.io/redis-streams-adapter", () => ({
    createAdapter: (arg: any, opts?: any) => createAdapter(arg, opts),
}));

const relayAdmissionRedis = {
    disconnect: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    set: vi.fn(),
};
const adapterRedisClient = {
    name: "redis-adapter-facing",
    duplicate: vi.fn(),
};
const getAdapterRedisClient = vi.fn(() => adapterRedisClient);
const createRelayAdmissionRedisClient = vi.fn(() => relayAdmissionRedis);
vi.mock("@/storage/redis/redis", () => ({
    closeRedisSocketClusterClient,
    createRedisSocketClusterRelayAdmissionClient: () => createRelayAdmissionRedisClient(),
    getRedisSocketClusterAdapterClient: () => getAdapterRedisClient(),
}));

const FIXED_ADAPTER_OPTIONS = {
    streamName: "socket.io",
    streamCount: 1,
    channelPrefix: "socket.io",
    useShardedPubSub: false,
    blockTimeInMs: REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS,
    onlyPlaintext: false,
} as const;

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
        serverCtor.mockReturnValue({
            on: vi.fn(),
            off: vi.fn(),
            close: vi.fn(),
            to: vi.fn(),
            use: vi.fn(),
        });
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

        // The adapter receives the adapter-facing wrapper (whose `duplicate()`
        // builds independently instrumented connections), while peer/tunnel
        // coordination gets its own fail-closed connection from the same
        // canonical Redis factory.
        expect(createAdapter).toHaveBeenCalledWith(adapterRedisClient, {
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: 200000,
            readCount: 2000,
        });
        expect(getAdapterRedisClient).toHaveBeenCalledOnce();
        expect(createRelayAdmissionRedisClient).toHaveBeenCalledOnce();
        expect(serverCtor).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                adapter: {
                    name: "adapter",
                    opts: {
                        ...FIXED_ADAPTER_OPTIONS,
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
            adapterRedisClient,
            expect.objectContaining({
                maxLen: 200000,
                readCount: 2000,
            }),
        );
        const options = serverCtor.mock.calls[0]?.[1];
        expect(options?.adapter).toEqual({
            name: "adapter",
            opts: {
                ...FIXED_ADAPTER_OPTIONS,
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
        expect(getAdapterRedisClient).not.toHaveBeenCalled();
        expect(createRelayAdmissionRedisClient).not.toHaveBeenCalled();
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
        expect(getAdapterRedisClient).not.toHaveBeenCalled();
        expect(createRelayAdmissionRedisClient).not.toHaveBeenCalled();
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
            adapterRedisClient,
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

        expect(createAdapter).toHaveBeenCalledWith(adapterRedisClient, {
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: 54321,
            readCount: 222,
        });
    });

    it("disconnects the dedicated redis client during socket shutdown", async () => {
        resetSocketAdapterEnv({
            HAPPY_SERVER_FLAVOR: "full",
            HAPPIER_SOCKET_ADAPTER: "redis-streams",
            REDIS_URL: "redis://localhost:6379",
        });
        startSocket(createFastifyLikeApp());
        const shutdown = onShutdown.mock.calls.find(([name]) => name === "api:socket")?.[1];

        expect(shutdown).toEqual(expect.any(Function));
        await shutdown();

        expect(relayAdmissionRedis.disconnect).toHaveBeenCalledWith(false);
        expect(relayAdmissionRedis.disconnect).toHaveBeenCalledTimes(1);
        expect(closeRedisSocketClusterClient).toHaveBeenCalledTimes(1);
    });
});
