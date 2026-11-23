import { getRedisClient } from "@/storage/redis/redis";
import { log } from "@/utils/logging/log";

export type RpcRedisRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

const DEL_IF_SOCKET_ID_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
// Refreshes this socket's mapping, and restores it when it is missing: a forward that fails or
// times out deletes the mapping (rpcHandler), and so does expiry after missed refreshes, while the
// socket can still be connected. Sockets register each method once per connection, so without the
// restore the method stays unreachable from every other instance until the socket reconnects.
// A mapping another socket owns is left alone. Returns 0 (other owner), 1 (refreshed), 2 (restored).
const REFRESH_OR_RESTORE_SCRIPT =
    "local owner = redis.call('HGET', KEYS[1], 'socketId') if owner and owner ~= ARGV[1] then return 0 end redis.call('HSET', KEYS[1], 'socketId', ARGV[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3]) redis.call('EXPIRE', KEYS[1], ARGV[4]) if owner then return 1 end return 2";

export function createRpcRedisRegistryCoordinator(params: {
    config: RpcRedisRegistryConfig;
    userId: string;
    socketId: string;
    ownedMethods: Set<string>;
}) {
    const { config, userId, socketId, ownedMethods } = params;
    const redisRegistryTtlSeconds = config.enabled ? (config.ttlSeconds ?? 120) : 0;
    const redisRegistryInstanceId = config.enabled ? config.instanceId : null;
    let refreshTimer: NodeJS.Timeout | null = null;

    function startRefreshLoopIfNeeded(): void {
        if (!config.enabled) return;
        if (refreshTimer) return;
        if (ownedMethods.size === 0) return;

        const redis = getRedisClient();
        const intervalMs = Math.max(1000, Math.floor((redisRegistryTtlSeconds * 1000) / 2));
        const instanceId = redisRegistryInstanceId!;
        refreshTimer = setInterval(() => {
            if (ownedMethods.size === 0) return;
            const now = Date.now().toString();
            const ttl = redisRegistryTtlSeconds.toString();
            const methods = [...ownedMethods];
            // Best-effort refresh; a failed eval is retried on the next tick (restore covers expiry).
            void Promise.all(
                methods.map((method) =>
                    redis
                        .eval(REFRESH_OR_RESTORE_SCRIPT, 1, `rpc:${userId}:${method}`, socketId, now, instanceId, ttl)
                        .catch(() => null),
                ),
            ).then((results) => {
                const restored = methods.filter((_, index) => results[index] === 2);
                if (restored.length > 0) {
                    log(
                        { module: "websocket", level: "warn" },
                        `Restored ${restored.length} missing RPC route(s) for socket ${socketId} (user ${userId}): ${restored.join(", ")}`,
                    );
                }
            });
        }, intervalMs);
        refreshTimer.unref?.();
    }

    async function stopRefreshLoopIfIdle(): Promise<void> {
        if (ownedMethods.size > 0) return;
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    async function registerMethod(method: string): Promise<void> {
        if (!config.enabled) return;
        const redis = getRedisClient();
        const key = `rpc:${userId}:${method}`;
        const now = Date.now().toString();

        await redis
            .multi()
            .hset(key, 'instanceId', redisRegistryInstanceId!, 'socketId', socketId, 'updatedAt', now)
            .expire(key, redisRegistryTtlSeconds)
            .exec();
    }

    async function removeSocketRegistration(userIdToUse: string, method: string, socketIdToUse: string): Promise<void> {
        if (!config.enabled) return;
        const redis = getRedisClient();
        const key = `rpc:${userIdToUse}:${method}`;
        await redis.eval(DEL_IF_SOCKET_ID_SCRIPT, 1, key, socketIdToUse);
    }

    async function lookupSocketId(userIdToUse: string, method: string): Promise<string | null> {
        if (!config.enabled) return null;
        const redis = getRedisClient();
        const key = `rpc:${userIdToUse}:${method}`;
        const [resolvedSocketId] = await redis.hmget(key, 'socketId');
        if (typeof resolvedSocketId === 'string' && resolvedSocketId.length > 0) return resolvedSocketId;
        return null;
    }

    async function cleanupMethodsForSocket(userIdToUse: string, methods: string[], socketIdToUse: string): Promise<void> {
        if (!config.enabled || methods.length === 0) return;
        const redis = getRedisClient();
        await Promise.all(
            methods.map(async (method) => {
                const key = `rpc:${userIdToUse}:${method}`;
                await redis.eval(DEL_IF_SOCKET_ID_SCRIPT, 1, key, socketIdToUse);
            }),
        );
    }

    return {
        enabled: config.enabled,
        startRefreshLoopIfNeeded,
        stopRefreshLoopIfIdle,
        registerMethod,
        removeSocketRegistration,
        lookupSocketId,
        cleanupMethodsForSocket,
    };
}
