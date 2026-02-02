import { eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";
import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { db } from "@/storage/db";
import { canApprovePermissions } from "@/app/share/accessControl";
import { getRedisClient } from "@/storage/redis";

type RpcRedisRegistryConfig =
    | { enabled: false }
    | { enabled: true; instanceId: string; ttlSeconds?: number };

export function rpcHandler(
    userId: string,
    socket: Socket,
    userRpcListeners: Map<string, Socket>,
    allRpcListeners: Map<string, Map<string, Socket>>,
    ctx: { io: Server; redisRegistry: RpcRedisRegistryConfig },
) {
    
    const redisRegistryTtlSeconds =
        ctx.redisRegistry.enabled ? (ctx.redisRegistry.ttlSeconds ?? 120) : 0;
    const redisRegistryInstanceId = ctx.redisRegistry.enabled ? ctx.redisRegistry.instanceId : null;
    const ownedMethods = new Set<string>();
    let refreshTimer: NodeJS.Timeout | null = null;

    const delIfSocketIdScript =
        "if redis.call('HGET', KEYS[1], 'socketId') == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
    const refreshIfOwnerScript =
        "if redis.call('HGET', KEYS[1], 'socketId') ~= ARGV[1] then return 0 end redis.call('HSET', KEYS[1], 'updatedAt', ARGV[2], 'instanceId', ARGV[3]) redis.call('EXPIRE', KEYS[1], ARGV[4]) return 1";

    function startRefreshLoopIfNeeded(): void {
        if (!ctx.redisRegistry.enabled) return;
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
                void redis.eval(refreshIfOwnerScript, 1, key, socket.id, now, instanceId, ttl);
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

    async function registerInRedis(method: string): Promise<void> {
        if (!ctx.redisRegistry.enabled) return;
        const redis = getRedisClient();
        const key = `rpc:${userId}:${method}`;
        const now = Date.now().toString();

        await redis
            .multi()
            .hset(key, 'instanceId', redisRegistryInstanceId!, 'socketId', socket.id, 'updatedAt', now)
            .expire(key, redisRegistryTtlSeconds)
            .exec();
    }

    async function unregisterInRedis(userIdToUse: string, method: string, socketIdToUse: string): Promise<void> {
        if (!ctx.redisRegistry.enabled) return;
        const redis = getRedisClient();
        const key = `rpc:${userIdToUse}:${method}`;
        await redis.eval(delIfSocketIdScript, 1, key, socketIdToUse);
    }

    async function lookupSocketIdInRedis(userIdToUse: string, method: string): Promise<string | null> {
        if (!ctx.redisRegistry.enabled) return null;
        const redis = getRedisClient();
        const key = `rpc:${userIdToUse}:${method}`;
        const [socketId] = await redis.hmget(key, 'socketId');
        if (typeof socketId === 'string' && socketId.length > 0) return socketId;
        return null;
    }

    // RPC register - Register this socket as a listener for an RPC method
    socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Invalid method name' });
                return;
            }

            // Check if method was already registered
            const previousSocket = userRpcListeners.get(method);
            if (previousSocket && previousSocket !== socket) {
                // log({ module: 'websocket-rpc' }, `RPC method ${method} re-registered: ${previousSocket.id} -> ${socket.id}`);
            }

            // Register this socket as the listener for this method
            userRpcListeners.set(method, socket);
            ownedMethods.add(method);
            await registerInRedis(method);
            startRefreshLoopIfNeeded();

            socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
            // log({ module: 'websocket-rpc' }, `RPC method registered: ${method} on socket ${socket.id} (user: ${userId})`);
            // log({ module: 'websocket-rpc' }, `Active RPC methods for user ${userId}: ${Array.from(rpcListeners.keys()).join(', ')}`);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Internal error' });
        }
    });

    // RPC unregister - Remove this socket as a listener for an RPC method
    socket.on(SOCKET_RPC_EVENTS.UNREGISTER, async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'unregister', error: 'Invalid method name' });
                return;
            }

            if (userRpcListeners.get(method) === socket) {
                userRpcListeners.delete(method);
                ownedMethods.delete(method);
                await unregisterInRedis(userId, method, socket.id);
                await stopRefreshLoopIfIdle();
                // log({ module: 'websocket-rpc' }, `RPC method unregistered: ${method} from socket ${socket.id} (user: ${userId})`);

                if (userRpcListeners.size === 0) {
                    allRpcListeners.delete(userId);
                    // log({ module: 'websocket-rpc' }, `All RPC methods unregistered for user ${userId}`);
                } else {
                    // log({ module: 'websocket-rpc' }, `Remaining RPC methods for user ${userId}: ${Array.from(rpcListeners.keys()).join(', ')}`);
                }
            } else {
                // log({ module: 'websocket-rpc' }, `RPC unregister ignored: ${method} not registered on socket ${socket.id}`);
            }

            socket.emit(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'unregister', error: 'Internal error' });
        }
    });

    // RPC call - Call an RPC method on another socket of the same user
    socket.on(SOCKET_RPC_EVENTS.CALL, async (data: any, callback: (response: any) => void) => {
        try {
            const { method, params: callParams } = data;

            if (!method || typeof method !== 'string') {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: method is required'
                    });
                }
                return;
            }

            // Delegated permission approvals (cross-user forwarding) are allowed ONLY for `${sessionId}:permission`.
            // All other RPC methods are restricted to "same-user" forwarding.
            let targetUserId = userId;
            let targetSocket: Socket | undefined = undefined;
            if (typeof method === 'string') {
                const lastColon = method.lastIndexOf(':');
                const suffix = lastColon >= 0 ? method.slice(lastColon + 1) : '';
                if (suffix === 'permission') {
                    const sessionId = lastColon >= 0 ? method.slice(0, lastColon) : '';
                    if (sessionId && sessionId !== 'permission') {
                        const session = await db.session.findUnique({
                            where: { id: sessionId },
                            select: { accountId: true },
                        });
                        const ownerId = session?.accountId;
                        if (ownerId && ownerId !== userId) {
                            const allowed = await canApprovePermissions(userId, sessionId);
                            if (!allowed) {
                                if (callback) {
                                    callback({
                                        ok: false,
                                        error: 'Forbidden',
                                    });
                                }
                                return;
                            }
                            targetUserId = ownerId;
                            const ownerListeners = allRpcListeners.get(ownerId);
                            targetSocket = ownerListeners?.get(method);
                            if (targetSocket) {
                                log({ module: 'websocket-rpc' }, `Delegated permission RPC: ${userId} -> ${ownerId} (${sessionId})`);
                            }
                        }
                    }
                }
            }

            // Log RPC call initiation
            const startTime = Date.now();
            // log({ module: 'websocket-rpc' }, `RPC call initiated: ${socket.id} -> ${method} (target: ${targetSocket.id})`);

            try {
                if (ctx.redisRegistry.enabled) {
                    const redis = getRedisClient();
                    const socketId = await lookupSocketIdInRedis(targetUserId, method);
                    if (!socketId) {
                        if (callback) {
                            callback({
                                ok: false,
                                error: 'RPC method not available',
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                    if (socketId === socket.id) {
                        if (callback) {
                            callback({
                                ok: false,
                                error: 'Cannot call RPC on the same socket',
                            });
                        }
                        return;
                    }

                    const responses = await ctx.io.timeout(30000).to(socketId).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                        method,
                        params: callParams,
                    });
                    if (Array.isArray(responses) && responses.length === 0) {
                        // The socketId mapping exists in Redis, but no socket acknowledged the call.
                        // Treat this as "method unavailable" and eagerly cleanup the stale mapping.
                        try {
                            const key = `rpc:${targetUserId}:${method}`;
                            await redis.eval(delIfSocketIdScript, 1, key, socketId);
                        } catch {
                            // best-effort cleanup only
                        }
                        if (callback) {
                            callback({
                                ok: false,
                                error: 'RPC method not available',
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                    const response = Array.isArray(responses) ? responses[0] : responses;

                    const duration = Date.now() - startTime;
                    // log({ module: 'websocket-rpc' }, `RPC call succeeded: ${method} (${duration}ms)`);

                    if (callback) {
                        callback({
                            ok: true,
                            result: response,
                        });
                    }
                    return;
                }

                if (!targetSocket) {
                    targetSocket = userRpcListeners.get(method);
                }
                if (!targetSocket || !targetSocket.connected) {
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'RPC method not available',
                            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                        });
                    }
                    return;
                }
                if (targetSocket === socket) {
                    if (callback) {
                        callback({
                            ok: false,
                            error: 'Cannot call RPC on the same socket',
                        });
                    }
                    return;
                }

                // Forward the RPC request to the target socket using emitWithAck (single-process path).
                const response = await targetSocket.timeout(30000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, { method, params: callParams });

                const duration = Date.now() - startTime;
                // log({ module: 'websocket-rpc' }, `RPC call succeeded: ${method} (${duration}ms)`);

                if (callback) {
                    callback({
                        ok: true,
                        result: response,
                    });
                }

            } catch (error) {
                const duration = Date.now() - startTime;
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                // log({ module: 'websocket-rpc' }, `RPC call failed: ${method} - ${errorMsg} (${duration}ms)`);

                // Timeout or error occurred
                if (ctx.redisRegistry.enabled) {
                    try {
                        const redis = getRedisClient();
                        const socketId = await lookupSocketIdInRedis(targetUserId, method);
                        if (socketId) {
                            const key = `rpc:${targetUserId}:${method}`;
                            await redis.eval(delIfSocketIdScript, 1, key, socketId);
                        }
                    } catch {
                        // best-effort cleanup only
                    }
                }
                if (callback) {
                    callback({
                        ok: false,
                        error: errorMsg
                    });
                }
            }
        } catch (error) {
            // log({ module: 'websocket', level: 'error' }, `Error in rpc-call: ${error}`);
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });

    socket.on('disconnect', () => {

        const methodsToRemove: string[] = [];
        for (const [method, registeredSocket] of userRpcListeners.entries()) {
            if (registeredSocket === socket) {
                methodsToRemove.push(method);
            }
        }

        if (methodsToRemove.length > 0) {
            // log({ module: 'websocket-rpc' }, `Cleaning up RPC methods on disconnect for socket ${socket.id}: ${methodsToRemove.join(', ')}`);
            methodsToRemove.forEach(method => userRpcListeners.delete(method));
            ownedMethods.clear();
            if (ctx.redisRegistry.enabled) {
                const redis = getRedisClient();
                void Promise.all(
                    methodsToRemove.map(async (method) => {
                        const key = `rpc:${userId}:${method}`;
                        await redis.eval(delIfSocketIdScript, 1, key, socket.id);
                    }),
                );
            }
        }

        if (userRpcListeners.size === 0) {
            allRpcListeners.delete(userId);
            // log({ module: 'websocket-rpc' }, `All RPC listeners removed for user ${userId}`);
        }

        void stopRefreshLoopIfIdle();
    });
}
