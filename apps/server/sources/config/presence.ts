import { parseIntEnv } from "./env";

type EnvLike = Record<string, string | undefined>;

export const DEFAULT_PRESENCE_STREAM_MAX_LEN = 100_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_READ_BLOCK_MS = 5_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT = 200;
export const DEFAULT_PRESENCE_REDIS_WORKER_RECLAIM_IDLE_MS = 60_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_DB_WRITE_CONCURRENCY = 1;

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

export function readPresenceRedisWorkerConfigFromEnv(env: EnvLike): Readonly<{
    dbWriteConcurrency: number;
    flushIntervalMs: number;
    readBlockMs: number;
    readCount: number;
    reclaimIdleMs: number;
}> {
    return {
        dbWriteConcurrency: parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY ??
                env.HAPPY_PRESENCE_WORKER_DB_WRITE_CONCURRENCY,
            DEFAULT_PRESENCE_REDIS_WORKER_DB_WRITE_CONCURRENCY,
            { min: 1 },
        ),
        flushIntervalMs: parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS ?? env.HAPPY_PRESENCE_WORKER_FLUSH_INTERVAL_MS,
            DEFAULT_PRESENCE_REDIS_WORKER_FLUSH_INTERVAL_MS,
            { min: 1 },
        ),
        readBlockMs: parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS ?? env.HAPPY_PRESENCE_WORKER_READ_BLOCK_MS,
            DEFAULT_PRESENCE_REDIS_WORKER_READ_BLOCK_MS,
            { min: 1 },
        ),
        readCount: parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_READ_COUNT ?? env.HAPPY_PRESENCE_WORKER_READ_COUNT,
            DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT,
            { min: 1 },
        ),
        reclaimIdleMs: parseIntEnv(
            env.HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS ?? env.HAPPY_PRESENCE_WORKER_RECLAIM_IDLE_MS,
            DEFAULT_PRESENCE_REDIS_WORKER_RECLAIM_IDLE_MS,
            { min: 1 },
        ),
    };
}
