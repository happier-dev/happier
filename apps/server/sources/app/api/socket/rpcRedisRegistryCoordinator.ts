import { getRedisClient } from "@/storage/redis/redis";
import { log } from "@/utils/logging/log";

export type RpcRedisRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

const DEL_IF_SOCKET_ID_SCRIPT =
    "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
// Writes this socket's mapping for a method and returns when it registered, on the Redis clock in
// microseconds, so sockets on different instances can tell which registration is newer.
// registeredBy names the socket the time belongs to: an older server's plain HSET can hand the
// mapping to another socket and leave this time behind.
const REGISTER_SCRIPT = [
    "local t = redis.call('TIME')",
    "local at = t[1] .. string.format('%06d', t[2])",
    "redis.call('HSET', KEYS[1], 'instanceId', ARGV[1], 'socketId', ARGV[2], 'updatedAt', ARGV[3], 'registeredAt', at, 'registeredBy', ARGV[2])",
    "redis.call('EXPIRE', KEYS[1], ARGV[4])",
    "return at",
].join(" ");
// Refreshes this socket's mapping, and restores it when it is missing: a forward that fails or
// times out deletes the mapping (rpcHandler), and so does expiry after missed refreshes, while the
// socket can still be connected. Sockets register each method once per connection, so without the
// restore the method stays unreachable from every other instance until the socket reconnects.
// The newest registration owns the route: a mapping registered after ours is left alone (0, and
// this socket stops claiming the method); one registered before ours means an older socket restored
// first, so it is taken back (2). A mapping without a registration time of its own owner (written by
// an older server, during a rolling update) has no known order: it is left alone but this socket
// keeps its claim (3).
// Returns 0 (superseded), 1 (refreshed), 2 (restored), 3 (owner of unknown age).
const REFRESH_OR_RESTORE_SCRIPT = [
    "local owner = redis.call('HGET', KEYS[1], 'socketId')",
    "if owner == ARGV[1] then",
    "redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3])",
    "redis.call('EXPIRE', KEYS[1], ARGV[4])",
    "return 1",
    "end",
    "if owner then",
    "local ownerAt = tonumber(redis.call('HGET', KEYS[1], 'registeredAt'))",
    "if not ownerAt or redis.call('HGET', KEYS[1], 'registeredBy') ~= owner then return 3 end",
    "if ownerAt >= tonumber(ARGV[5]) then return 0 end",
    "end",
    "redis.call('HSET', KEYS[1], 'socketId', ARGV[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3], 'registeredAt', ARGV[5], 'registeredBy', ARGV[1])",
    "redis.call('EXPIRE', KEYS[1], ARGV[4])",
    "return 2",
].join(" ");

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
    // When this socket registered each method it owns (REGISTER_SCRIPT's Redis-clock value).
    const registeredAtByMethod = new Map<string, string>();
    // Registrations still waiting on Redis, per method. A refresh neither evaluates nor drops a
    // method while one is pending: its outcome would judge the previous registration.
    const pendingRegistrations = new Map<string, number>();

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
            const claims = [...ownedMethods].flatMap((method) => {
                if (pendingRegistrations.has(method)) return [];
                const registeredAt = registeredAtByMethod.get(method);
                return registeredAt ? [{ method, registeredAt }] : [];
            });
            void Promise.all(
                claims.map(({ method, registeredAt }) =>
                    redis
                        .eval(REFRESH_OR_RESTORE_SCRIPT, 1, `rpc:${userId}:${method}`, socketId, now, instanceId, ttl, registeredAt)
                        .then(
                            (result) => ({ method, registeredAt, result, error: null }),
                            (error: unknown) => ({ method, registeredAt, result: null, error }),
                        ),
                ),
            ).then((outcomes) => {
                const restored: string[] = [];
                const failed: string[] = [];
                let firstError: unknown = null;
                for (const outcome of outcomes) {
                    if (outcome.error !== null) {
                        failed.push(outcome.method);
                        firstError ??= outcome.error;
                    } else if (outcome.result === 2) {
                        restored.push(outcome.method);
                    } else if (
                        outcome.result === 0
                        && !pendingRegistrations.has(outcome.method)
                        && registeredAtByMethod.get(outcome.method) === outcome.registeredAt
                    ) {
                        // A newer registration owns the method: this socket stops refreshing or restoring it.
                        ownedMethods.delete(outcome.method);
                        registeredAtByMethod.delete(outcome.method);
                    }
                }
                if (ownedMethods.size === 0) void stopRefreshLoopIfIdle();
                if (restored.length > 0) {
                    log(
                        { module: "websocket", level: "warn" },
                        `Restored ${restored.length} missing RPC route(s) for socket ${socketId} (user ${userId}): ${restored.join(", ")}`,
                    );
                }
                if (failed.length > 0) {
                    // Retried on the next tick; restore covers any expiry in between.
                    log(
                        { module: "websocket", level: "warn" },
                        `Failed to refresh ${failed.length} RPC route(s) for socket ${socketId} (user ${userId}): ${failed.join(", ")}: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
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

        pendingRegistrations.set(method, (pendingRegistrations.get(method) ?? 0) + 1);
        try {
            const registeredAt = await redis.eval(
                REGISTER_SCRIPT,
                1,
                key,
                redisRegistryInstanceId!,
                socketId,
                now,
                redisRegistryTtlSeconds.toString(),
            );
            registeredAtByMethod.set(method, String(registeredAt));
        } finally {
            const remaining = (pendingRegistrations.get(method) ?? 1) - 1;
            if (remaining > 0) pendingRegistrations.set(method, remaining);
            else pendingRegistrations.delete(method);
        }
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
