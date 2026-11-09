import { describe, expect, it } from "vitest";

import {
    DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
    DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
    REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS,
    REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX,
    REDIS_STREAMS_ADAPTER_STREAM_COUNT,
    REDIS_STREAMS_ADAPTER_STREAM_NAME,
    readRedisStreamsAdapterOptionsFromEnv,
    readSocketAdapterRuntimeConfigFromEnv,
} from "./socketAdapter";

const FIXED_ADAPTER_OPTIONS = {
    streamName: REDIS_STREAMS_ADAPTER_STREAM_NAME,
    streamCount: REDIS_STREAMS_ADAPTER_STREAM_COUNT,
    channelPrefix: REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX,
    useShardedPubSub: false,
    blockTimeInMs: REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS,
    onlyPlaintext: false,
} as const;

describe("config/socketAdapter", () => {
    it("scopes both stream broadcasts and Pub/Sub census to the selected stack", () => {
        const scoped = readRedisStreamsAdapterOptionsFromEnv({ HAPPIER_SOCKET_ADAPTER_SCOPE: " hstack:agent-qa-test " });
        expect(scoped.streamName).toBe("socket.io:hstack:agent-qa-test");
        expect(scoped.channelPrefix).toBe("socket.io:hstack:agent-qa-test");
        expect(readRedisStreamsAdapterOptionsFromEnv({ HAPPIER_SOCKET_ADAPTER_SCOPE: " " }))
            .toEqual(readRedisStreamsAdapterOptionsFromEnv({}));
    });

    it("uses the tuned redis-streams adapter defaults", () => {
        expect(readRedisStreamsAdapterOptionsFromEnv({})).toEqual({
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
            readCount: DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
        });
    });

    it("reserves the blocking-response and stale-timer grace below the fixed socket stall timeout", () => {
        // 5 seconds is both the configured and minimum supported timeout for
        // adapter connections (relay admission uses a separate client).
        // ioredis 5.9.2 allows 100 ms beyond a finite blocking timeout; the
        // socket retry owner also reserves 50 ms for stale timer delivery.
        const blockTimeInMs = readRedisStreamsAdapterOptionsFromEnv({}).blockTimeInMs;
        expect(blockTimeInMs).toBe(5_000 - 100 - 50);
        expect(REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS).toBe(blockTimeInMs);
    });

    it("allows at most thirteen idle empty returns per replica per minute", () => {
        expect(Math.ceil(60_000 / readRedisStreamsAdapterOptionsFromEnv({}).blockTimeInMs))
            .toBeLessThanOrEqual(13);
    });

    it("parses redis-streams adapter tuning from env", () => {
        expect(
            readRedisStreamsAdapterOptionsFromEnv({
                HAPPIER_SOCKET_ADAPTER_MAXLEN: "12345",
                HAPPIER_SOCKET_ADAPTER_READ_COUNT: "321",
            }),
        ).toEqual({
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: 12345,
            readCount: 321,
        });
    });

    it("exposes no env override for the fixed 0.3.1 topology options", () => {
        expect(
            readRedisStreamsAdapterOptionsFromEnv({
                HAPPIER_SOCKET_ADAPTER_BLOCK_TIME_MS: "5000",
                HAPPIER_SOCKET_ADAPTER_STREAM_COUNT: "4",
                HAPPIER_SOCKET_ADAPTER_SHARDED_PUBSUB: "1",
                HAPPIER_SOCKET_ADAPTER_ONLY_PLAINTEXT: "1",
                HAPPIER_SOCKET_ADAPTER_STREAM_NAME: "other-stream",
                HAPPIER_SOCKET_ADAPTER_CHANNEL_PREFIX: "other-prefix",
            }),
        ).toEqual({
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
            readCount: DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
        });
    });

    it("supports legacy env aliases and falls back on invalid values", () => {
        expect(
            readRedisStreamsAdapterOptionsFromEnv({
                HAPPY_SOCKET_ADAPTER_MAXLEN: "-1",
                HAPPY_SOCKET_ADAPTER_READ_COUNT: "not-a-number",
            }),
        ).toEqual({
            ...FIXED_ADAPTER_OPTIONS,
            maxLen: DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
            readCount: DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
        });
    });

    it("returns the resolved adapter mode and redis-streams runtime config together", () => {
        expect(
            readSocketAdapterRuntimeConfigFromEnv(
                {
                    HAPPIER_SOCKET_ADAPTER: "redis-streams",
                    REDIS_URL: "redis://localhost:6379",
                    HAPPIER_SOCKET_ADAPTER_MAXLEN: "999",
                    HAPPIER_SOCKET_ADAPTER_READ_COUNT: "88",
                },
                "memory",
            ),
        ).toEqual({
            adapter: "redis-streams",
            redisStreamsEnabled: true,
            redisStreamsOptions: {
                ...FIXED_ADAPTER_OPTIONS,
                maxLen: 999,
                readCount: 88,
            },
        });
    });
});
