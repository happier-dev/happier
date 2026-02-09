import { getRedisClient } from "@/storage/redis/redis";

export type RpcRedisRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

const DEL_IF_SOCKET_ID_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const REFRESH_IF_OWNER_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') ~= ARGV[1] then return 0 end redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3]) redis.call('EXPIRE', KEYS[1], ARGV[4]) return 1";

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
            for (const method of ownedMethods) {
                const key = `rpc:${userId}:${method}`;
                // Best-effort refresh; failures are tolerated (the entry will expire and calls will fail closed).
                void redis.eval(REFRESH_IF_OWNER_SCRIPT, 1, key, socketId, now, instanceId, ttl);
            }
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
