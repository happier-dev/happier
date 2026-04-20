import type { RedisStreamsAdapterOptions } from "@socket.io/redis-streams-adapter";

import { getSocketAdapterFromEnv, isRedisStreamsEnabled, type SocketAdapter } from "./backends";
import { parseIntEnv } from "./env";

export const DEFAULT_REDIS_STREAMS_ADAPTER_MAX_LEN = 200_000;
export const DEFAULT_REDIS_STREAMS_ADAPTER_READ_COUNT = 2_000;

type EnvLike = Record<string, string | undefined>;

export function readRedisStreamsAdapterOptionsFromEnv(
    env: EnvLike,
): Pick<RedisStreamsAdapterOptions, "maxLen" | "readCount"> {
    return {
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
    };
}

export function readSocketAdapterRuntimeConfigFromEnv(env: EnvLike, fallback: SocketAdapter): Readonly<{
    adapter: SocketAdapter;
    redisStreamsEnabled: boolean;
    redisStreamsOptions: Pick<RedisStreamsAdapterOptions, "maxLen" | "readCount">;
}> {
    const adapter = getSocketAdapterFromEnv(env as NodeJS.ProcessEnv, fallback);
    return {
        adapter,
        redisStreamsEnabled: isRedisStreamsEnabled(env as NodeJS.ProcessEnv, adapter),
        redisStreamsOptions: readRedisStreamsAdapterOptionsFromEnv(env),
    };
}
