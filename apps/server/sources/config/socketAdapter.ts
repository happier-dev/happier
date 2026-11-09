import type { RedisStreamsAdapterOptions } from "@socket.io/redis-streams-adapter";

import { getSocketAdapterFromEnv, isRedisStreamsEnabled, type SocketAdapter } from "./backends";
import { parseIntEnv } from "./env";
import {
    REDIS_SOCKET_BLOCK_RESPONSE_GRACE_MS,
    REDIS_SOCKET_STALL_TIMEOUT_MS,
    REDIS_SOCKET_STALE_TIMER_GRACE_MS,
} from "./socketClusterRedis";

export const DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN = 200_000;
export const DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT = 2_000;

/**
 * A healthy blocking read must return before the dedicated client's silent
 * stall deadline, including its blocking-response and timer scheduling grace.
 * Adapter 0.3.1 immediately consumes arriving entries, so longer idle blocks
 * reduce empty returns without delaying broadcasts. The old 100-ms block
 * allowed up to 600 empty returns/minute/replica; this derives at most 13.
 */
export const REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS = REDIS_SOCKET_STALL_TIMEOUT_MS
    - REDIS_SOCKET_BLOCK_RESPONSE_GRACE_MS
    - REDIS_SOCKET_STALE_TIMER_GRACE_MS;

/** Unscoped deployments retain the upstream/current shared names. */
export const REDIS_STREAMS_ADAPTER_STREAM_NAME = "socket.io";
export const REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX = "socket.io";

/** Happier serves one Socket.IO namespace; extra streams add connections only. */
export const REDIS_STREAMS_ADAPTER_STREAM_COUNT = 1;

/**
 * The complete adapter configuration Happier constructs. Every value is fixed
 * except the optional cluster scope and the `maxLen`/`readCount` tunables, so
 * there is exactly one option projection and no socket-local literals.
 */
export type RedisStreamsAdapterRuntimeOptions = Required<Pick<
    RedisStreamsAdapterOptions,
    | "streamName"
    | "streamCount"
    | "channelPrefix"
    | "useShardedPubSub"
    | "maxLen"
    | "readCount"
    | "blockTimeInMs"
    | "onlyPlaintext"
>>;

type EnvLike = Record<string, string | undefined>;

export function readRedisStreamsAdapterOptionsFromEnv(
    env: EnvLike,
): RedisStreamsAdapterRuntimeOptions {
    const scope = env.HAPPIER_SOCKET_ADAPTER_SCOPE?.trim();
    const suffix = scope ? `:${scope}` : '';
    return {
        streamName: `${REDIS_STREAMS_ADAPTER_STREAM_NAME}${suffix}`,
        streamCount: REDIS_STREAMS_ADAPTER_STREAM_COUNT,
        channelPrefix: `${REDIS_STREAMS_ADAPTER_CHANNEL_PREFIX}${suffix}`,
        // Sharded Pub/Sub would require Redis 7 shard-channel commands and ACL
        // surface with no current consumer.
        useShardedPubSub: false,
        maxLen: parseIntEnv(
            env.HAPPIER_SOCKET_ADAPTER_MAXLEN ?? env.HAPPY_SOCKET_ADAPTER_MAXLEN,
            DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN,
            { min: 1 },
        ),
        readCount: parseIntEnv(
            env.HAPPIER_SOCKET_ADAPTER_READ_COUNT ?? env.HAPPY_SOCKET_ADAPTER_READ_COUNT,
            DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT,
            { min: 1 },
        ),
        blockTimeInMs: REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS,
        // The RPC/tunnel/event/transfer corridor can carry Buffer, ArrayBuffer,
        // and typed-array payloads, so binary detection must stay on.
        onlyPlaintext: false,
    };
}

export function readSocketAdapterRuntimeConfigFromEnv(env: EnvLike, fallback: SocketAdapter): Readonly<{
    adapter: SocketAdapter;
    redisStreamsEnabled: boolean;
    redisStreamsOptions: RedisStreamsAdapterRuntimeOptions;
}> {
    const adapter = getSocketAdapterFromEnv(env as NodeJS.ProcessEnv, fallback);
    return {
        adapter,
        redisStreamsEnabled: isRedisStreamsEnabled(env as NodeJS.ProcessEnv, adapter),
        redisStreamsOptions: readRedisStreamsAdapterOptionsFromEnv(env),
    };
}
