import { getRedisClient } from "@/storage/redis/redis";
import { warn } from "@/utils/logging/log";

export type RpcRedisRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

const REGISTER_SCRIPT = [
    "redis.call('HSET', KEYS[1], 'instanceId', ARGV[1], 'socketId', ARGV[2], 'updatedAt', ARGV[3])",
    "redis.call('EXPIRE', KEYS[1], ARGV[4])",
].join(" ");

const DEL_IF_SOCKET_ID_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

// Only REGISTER selects an owner. Refresh extends that registration without resurrecting a
// missing route or replacing a socket that registered more recently.
const REFRESH_IF_OWNER_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') ~= ARGV[1] then return 0 end redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2]) redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1";

function rpcRouteKey(userId: string, method: string): string {
    return `rpc:${userId}:${method}`;
}

// A REGISTER can commit before the connection drops. Replaying it could replace a newer owner.
function getRpcRegistryRedis() {
    return getRedisClient("fail-on-disconnect");
}

export function createRpcRedisRegistryCoordinator(params: {
    config: RpcRedisRegistryConfig;
    userId: string;
    socketId: string;
}) {
    const { config, userId, socketId } = params;
    const ownedMethods = new Set<string>();
    let refreshTimer: NodeJS.Timeout | null = null;

    function startRefresh(redis: ReturnType<typeof getRedisClient>, ttlSeconds: number): void {
        if (refreshTimer) return;
        const intervalMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 2));
        const ttl = ttlSeconds.toString();
        refreshTimer = setInterval(() => {
            const now = Date.now().toString();
            const refreshes = Array.from(ownedMethods, method =>
                redis.eval(REFRESH_IF_OWNER_SCRIPT, 1, rpcRouteKey(userId, method), socketId, now, ttl),
            );
            void Promise.allSettled(refreshes).then(results => {
                const failure = results.find(result => result.status === "rejected");
                if (failure) {
                    warn({ module: "websocket", socketId, error: failure.reason },
                        "Failed to refresh Redis RPC registrations");
                }
            });
        }, intervalMs);
        refreshTimer.unref?.();
    }

    function stopRefreshIfIdle(): void {
        if (ownedMethods.size > 0 || !refreshTimer) return;
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    async function registerMethod(method: string): Promise<void> {
        if (!config.enabled) return;
        const redis = getRpcRegistryRedis();
        const ttlSeconds = config.ttlSeconds ?? 120;
        ownedMethods.add(method);
        startRefresh(redis, ttlSeconds);
        // Queue the write immediately. A subsequent withdrawal on this Redis connection will
        // run after it even if its acknowledgement is still pending.
        await redis.eval(REGISTER_SCRIPT, 1, rpcRouteKey(userId, method),
            config.instanceId, socketId, Date.now().toString(), ttlSeconds.toString());
    }

    async function unregisterMethod(method: string): Promise<void> {
        if (!config.enabled) return;
        // Stop refreshing immediately. A repeated withdrawal can still retry the owner-checked deletion.
        ownedMethods.delete(method);
        stopRefreshIfIdle();
        await getRpcRegistryRedis().eval(DEL_IF_SOCKET_ID_SCRIPT, 1, rpcRouteKey(userId, method), socketId);
    }

    async function unregisterAll(): Promise<void> {
        await Promise.all([...ownedMethods].map(unregisterMethod));
    }

    async function lookupSocketId(targetUserId: string, method: string): Promise<string | null> {
        if (!config.enabled) return null;
        const [socketId] = await getRpcRegistryRedis().hmget(rpcRouteKey(targetUserId, method), "socketId");
        return typeof socketId === "string" && socketId.trim().length > 0 ? socketId : null;
    }

    return {
        enabled: config.enabled,
        registerMethod,
        unregisterMethod,
        unregisterAll,
        lookupSocketId,
    };
}
