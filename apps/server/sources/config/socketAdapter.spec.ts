import { describe, expect, it } from "vitest";

import {
    DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
    DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
    readRedisStreamsAdapterOptionsFromEnv,
    readSocketAdapterRuntimeConfigFromEnv,
} from "./socketAdapter";

describe("config/socketAdapter", () => {
    it("uses the tuned redis-streams adapter defaults", () => {
        expect(readRedisStreamsAdapterOptionsFromEnv({})).toEqual({
            maxLen: DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
            readCount: DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
        });
    });

    it("parses redis-streams adapter tuning from env", () => {
        expect(
            readRedisStreamsAdapterOptionsFromEnv({
                HAPPIER_SOCKET_ADAPTER_MAXLEN: "12345",
                HAPPIER_SOCKET_ADAPTER_READ_COUNT: "321",
            }),
        ).toEqual({
            maxLen: 12345,
            readCount: 321,
        });
    });

    it("supports legacy env aliases and falls back on invalid values", () => {
        expect(
            readRedisStreamsAdapterOptionsFromEnv({
                HAPPY_SOCKET_ADAPTER_MAXLEN: "-1",
                HAPPY_SOCKET_ADAPTER_READ_COUNT: "not-a-number",
            }),
        ).toEqual({
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
                maxLen: 999,
                readCount: 88,
            },
        });
    });
});
