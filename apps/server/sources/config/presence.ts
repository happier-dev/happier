import { parseIntEnv } from "./env";

type EnvLike = Record<string, string | undefined>;

export const DEFAULT_PRESENCE_STREAM_MAX_LEN = 100_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT = 200;

function parsePresenceStreamMaxLen(raw: string | undefined): number | null {
    if (typeof raw !== "string" || !raw.trim()) {
        return DEFAULT_PRESENCE_STREAM_MAX_LEN;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_PRESENCE_STREAM_MAX_LEN;
    }
    if (parsed === 0) {
        return null;
    }
    return Math.floor(parsed);
}

export function readPresenceStreamConfigFromEnv(env: EnvLike): Readonly<{
    streamMaxLen: number | null;
}> {
    return {
        streamMaxLen: parsePresenceStreamMaxLen(
            env.HAPPIER_PRESENCE_STREAM_MAXLEN ?? env.HAPPY_PRESENCE_STREAM_MAXLEN,
        ),
    };
}

type PresenceRedisWorkerConfig = Readonly<{
    readCount: number;
}>;

export function readPresenceRedisWorkerConfigFromEnv(
    env: EnvLike,
    overrides: Partial<PresenceRedisWorkerConfig> = {},
): PresenceRedisWorkerConfig {
    return {
        readCount: overrides.readCount ?? parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_READ_COUNT ?? env.HAPPY_PRESENCE_WORKER_READ_COUNT,
            DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
            { min: 1 },
        ),
    };
}
