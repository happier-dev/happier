/** Fixed for every root/adapter connection; relay admission has its own timeout. */
export const REDIS_SOCKET_STALL_TIMEOUT_MS = 5_000;

/** Let an old ioredis socket timer expire before reconnecting a closed transport. */
export const REDIS_SOCKET_STALE_TIMER_GRACE_MS = 50;

/**
 * ioredis 5.9.2 RedisOptions.blockingTimeoutGrace defaults to 100 ms: the
 * response allowance beyond a finite blocking command's server-side timeout.
 * Reserve that allowance inside our socket deadline without enabling another
 * command timer. Keep the existing stale-timer scheduling grace as well.
 */
export const REDIS_SOCKET_BLOCK_RESPONSE_GRACE_MS = 100;
