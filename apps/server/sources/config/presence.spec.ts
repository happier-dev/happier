import { describe, expect, it } from "vitest";

import {
    DEFAULT_PRESENCE_REDIS_WORKER_DB_WRITE_CONCURRENCY,
    DEFAULT_PRESENCE_REDIS_WORKER_FLUSH_INTERVAL_MS,
    DEFAULT_PRESENCE_REDIS_WORKER_READ_BLOCK_MS,
    DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
    DEFAULT_PRESENCE_REDIS_WORKER_RECLAIM_IDLE_MS,
    DEFAULT_PRESENCE_STREAM_MAX_LEN,
    readPresenceRedisWorkerConfigFromEnv,
    readPresenceStreamConfigFromEnv,
} from "./presence";

describe("config/presence", () => {
    it("uses the canonical presence stream defaults", () => {
        expect(readPresenceStreamConfigFromEnv({})).toEqual({
            streamMaxLen: DEFAULT_PRESENCE_STREAM_MAX_LEN,
        });
        expect(readPresenceRedisWorkerConfigFromEnv({})).toEqual({
            dbWriteConcurrency: DEFAULT_PRESENCE_REDIS_WORKER_DB_WRITE_CONCURRENCY,
            flushIntervalMs: DEFAULT_PRESENCE_REDIS_WORKER_FLUSH_INTERVAL_MS,
            readBlockMs: DEFAULT_PRESENCE_REDIS_WORKER_READ_BLOCK_MS,
            readCount: DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
            reclaimIdleMs: DEFAULT_PRESENCE_REDIS_WORKER_RECLAIM_IDLE_MS,
        });
    });

    it("parses presence stream and worker tuning from env", () => {
        expect(
            readPresenceStreamConfigFromEnv({
                HAPPIER_PRESENCE_STREAM_MAXLEN: "4321",
            }),
        ).toEqual({
            streamMaxLen: 4321,
        });
        expect(
            readPresenceRedisWorkerConfigFromEnv({
                HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: "7",
                HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: "123",
                HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: "456",
                HAPPIER_PRESENCE_WORKER_READ_COUNT: "789",
                HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: "999",
            }),
        ).toEqual({
            dbWriteConcurrency: 7,
            flushIntervalMs: 123,
            readBlockMs: 456,
            readCount: 789,
            reclaimIdleMs: 999,
        });
    });

    it("supports legacy maxlen env aliases and disables trimming at 0", () => {
        expect(
            readPresenceStreamConfigFromEnv({
                HAPPY_PRESENCE_STREAM_MAXLEN: "0",
            }),
        ).toEqual({
            streamMaxLen: null,
        });
    });
});
