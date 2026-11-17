import { describe, expect, it } from "vitest";

import {
    DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
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
            readCount: DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
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
                HAPPIER_PRESENCE_WORKER_READ_COUNT: "789",
            }),
        ).toEqual({
            readCount: 789,
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
