import type { RedisStreamsAdapterOptions } from "@socket.io/redis-streams-adapter";

import { getSocketAdapterFromEnv, isRedisStreamsEnabled, type SocketAdapter } from "./backends";
import { parseIntEnv } from "./env";

export const DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN = 200_000;
export const DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT = 2_000;

/**
 * Adapter 0.2.3 hard-coded a 100 ms ioredis `XREAD BLOCK`; 0.3.1 made it
 * configurable and defaults it to 5_000 ms — exactly the dedicated
 * socket-cluster Redis client's `socketTimeout`. Accepting that default would
 * make a healthy blocking read indistinguishable from the silent-stall the
 * client's retry policy was designed to detect. Raise this only from measured
 * Redis polling evidence plus a proven margin below the stall timeout.
 */
export const REDIS_STREAMS_ADAPTER_BLOCK_TIME_MS = 100;

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
