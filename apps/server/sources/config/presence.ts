import { parseIntEnv } from "./env";
import { readServerConfig } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

type EnvLike = Record<string, string | undefined>;

export const DEFAULT_PRESENCE_STREAM_MAX_LEN = 100_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_FLUSH_INTERVAL_MS = 5_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_READ_BLOCK_MS = 5_000;
export const DEFAULT_PRESENCE_REDIS_WORKER_READ_COUNT = 200;
export const DEFAULT_PRESENCE_REDIS_WORKER_RECLAIM_IDLE_MS = 5_000;
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

type PresenceRedisWorkerConfig = Readonly<{
    dbWriteConcurrency: number;
    flushIntervalMs: number;
    readBlockMs: number;
    readCount: number;
    reclaimIdleMs: number;
}>;

export function readPresenceRedisWorkerConfigFromEnv(
    env: EnvLike,
    overrides: Partial<PresenceRedisWorkerConfig> = {},
): PresenceRedisWorkerConfig {
    const configured = {
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
    // server-v0.2.17 enqueues strictly after 30 s; its 20 s daemon cadence
    // therefore yields observations every 40 s. Reserve that producer window,
    // then divide the remaining deadline budget between pending idle age,
    // reclaim sweep, blocking read, and SQL completion. Reclaims flush at once.
    const recoverySliceMs = Math.max(1, Math.floor((
        readServerConfig(env, SERVER_CONFIG.HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS) - 40_000
    ) / 4));
    return {
        dbWriteConcurrency: overrides.dbWriteConcurrency ?? configured.dbWriteConcurrency,
        readCount: overrides.readCount ?? configured.readCount,
        flushIntervalMs: Math.min(overrides.flushIntervalMs ?? configured.flushIntervalMs, recoverySliceMs),
        readBlockMs: Math.min(overrides.readBlockMs ?? configured.readBlockMs, recoverySliceMs),
        reclaimIdleMs: Math.min(overrides.reclaimIdleMs ?? configured.reclaimIdleMs, recoverySliceMs),
    };
}
