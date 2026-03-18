import { log } from "@/utils/logging/log";
import { Server, Socket } from "socket.io";
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
import { resolveRpcMethodAvailabilityGraceMs, resolveRpcMethodAvailabilityPollMs } from "./rpcMethodAvailabilityGrace";
import { createRpcRedisRegistryCoordinator, type RpcRedisRegistryConfig } from "./rpcRedisRegistryCoordinator";
import { resolveRpcCallTarget } from "./resolveRpcCallTarget";
import { canRegisterSessionScopedRpcMethod } from "./sessionScopedBinding";

async function waitForRpcTargetAvailability(params: Readonly<{
    method: string;
    initialTargetSocket: Socket | null;
    initialTargetSocketId?: string | null;
    lookupTargetSocket: () => Socket | null;
    lookupRedisSocketId?: () => Promise<string | null>;
}>): Promise<Readonly<{ targetSocket: Socket | null; targetSocketId: string | null }>> {
    const graceMs = resolveRpcMethodAvailabilityGraceMs(params.method);
    const pollMs = resolveRpcMethodAvailabilityPollMs();
    const deadline = Date.now() + graceMs;

    const initialTargetSocketId =
        typeof params.initialTargetSocketId === 'string' && params.initialTargetSocketId.trim().length > 0
            ? params.initialTargetSocketId
            : null;
    let targetSocketId = initialTargetSocketId ?? (params.lookupRedisSocketId ? await params.lookupRedisSocketId() : null);
    let targetSocket =
        params.initialTargetSocket && params.initialTargetSocket.connected
            ? params.initialTargetSocket
            : params.lookupTargetSocket();

    while (
        (!targetSocket || !targetSocket.connected)
        && graceMs > 0
        && Date.now() < deadline
        && (!params.lookupRedisSocketId || !targetSocketId || targetSocketId === initialTargetSocketId)
    ) {
        const remainingMs = deadline - Date.now();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
        targetSocketId = params.lookupRedisSocketId ? await params.lookupRedisSocketId() : null;
        targetSocket = params.lookupTargetSocket() ?? targetSocket ?? null;
    }

    return {
        targetSocket: targetSocket && targetSocket.connected ? targetSocket : null,
        targetSocketId,
    };
}

function ensureUserRpcListenerMapRegistered(
    allRpcListeners: Map<string, Map<string, Socket>>,
    userId: string,
    userRpcListeners: Map<string, Socket>,
) {
    if (allRpcListeners.get(userId) !== userRpcListeners) {
        allRpcListeners.set(userId, userRpcListeners);
    }
}

function pruneUserRpcListenerMapIfEmpty(
    allRpcListeners: Map<string, Map<string, Socket>>,
    userId: string,
    userRpcListeners: Map<string, Socket>,
) {
    if (userRpcListeners.size === 0 && allRpcListeners.get(userId) === userRpcListeners) {
        allRpcListeners.delete(userId);
    }
}

export function rpcHandler(
    userId: string,
    socket: Socket,
    userRpcListeners: Map<string, Socket>,
    allRpcListeners: Map<string, Map<string, Socket>>,
    ctx: { io: Server; redisRegistry: RpcRedisRegistryConfig },
) {
    const ownedMethods = new Set<string>();
    const redisRegistry = createRpcRedisRegistryCoordinator({
        config: ctx.redisRegistry,
        userId,
        socketId: socket.id,
        ownedMethods,
    });

    const resolveUserRpcListeners = (mode: 'get' | 'ensure'): Map<string, Socket> => {
        const current = allRpcListeners.get(userId);
        if (current) return current;
        if (mode === 'ensure') {
            ensureUserRpcListenerMapRegistered(allRpcListeners, userId, userRpcListeners);
        }
        return userRpcListeners;
    };

    // RPC register - Register this socket as a listener for an RPC method
    socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Invalid method name' });
                return;
            }

            if (!canRegisterSessionScopedRpcMethod({ socket, method })) {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Forbidden' });
                return;
            }

            // Register this socket as the listener for this method
            const listeners = resolveUserRpcListeners('ensure');
            listeners.set(method, socket);
            ownedMethods.add(method);
            await redisRegistry.registerMethod(method);
            redisRegistry.startRefreshLoopIfNeeded();

            socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
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

            const listeners = resolveUserRpcListeners('get');
            if (listeners.get(method) === socket) {
                listeners.delete(method);
                ownedMethods.delete(method);
                await redisRegistry.removeSocketRegistration(userId, method, socket.id);
                await redisRegistry.stopRefreshLoopIfIdle();
                pruneUserRpcListenerMapIfEmpty(allRpcListeners, userId, listeners);
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
            const { method, params: callParams, timeoutMs: requestedTimeoutMs } = data;

            if (!method || typeof method !== 'string') {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: method is required'
                    });
                }
                return;
            }

            const targetResolution = await resolveRpcCallTarget({
                callerUserId: userId,
                method,
                allRpcListeners,
            });
            if (targetResolution.type === "forbidden") {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Forbidden',
                    });
                }
                return;
            }

            let { targetUserId, targetSocket } = targetResolution;
            const forwardTimeoutMs = resolveRpcForwardTimeoutMs(method, requestedTimeoutMs);
            let attemptedTargetSocketId: string | null = null;
            const lookupInMemoryTargetSocket = (): Socket | null => {
                if (targetUserId === userId && !allRpcListeners.has(userId)) {
                    return userRpcListeners.get(method) ?? null;
                }
                return allRpcListeners.get(targetUserId)?.get(method) ?? null;
            };

            try {
                if (redisRegistry.enabled) {
                    let targetSocketId = await redisRegistry.lookupSocketId(targetUserId, method);
                    if (!targetSocket?.connected || !targetSocketId) {
                        const awaited = await waitForRpcTargetAvailability({
                            method,
                            initialTargetSocket: targetSocket ?? null,
                            initialTargetSocketId: typeof targetSocketId === 'string' ? targetSocketId : null,
                            lookupTargetSocket: lookupInMemoryTargetSocket,
                            lookupRedisSocketId: async () => {
                                const lookedUp = await redisRegistry.lookupSocketId(targetUserId, method);
                                return typeof lookedUp === 'string' && lookedUp.trim().length > 0 ? lookedUp : null;
                            },
                        });
                        targetSocketId = awaited.targetSocketId;
                        targetSocket = awaited.targetSocket ?? targetSocket;
                    }
                    const fallbackSocket = targetSocket ?? lookupInMemoryTargetSocket();
                    if (fallbackSocket && fallbackSocket.connected) {
                        if (fallbackSocket === socket) {
                            if (callback) {
                                callback({
                                    ok: false,
                                    error: 'Cannot call RPC on the same socket',
                                });
                            }
                            return;
                        }

                        const response = await fallbackSocket.timeout(forwardTimeoutMs).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                            method,
                            params: callParams,
                        });
                        if (callback) {
                            callback({
                                ok: true,
                                result: response,
                            });
                        }
                        return;
                    }
                    if (!targetSocketId) {
                        // Fallback: Redis registry can briefly miss registrations (e.g. during reconnect or cleanup),
                        // but the in-process registry may still know the correct socket. Prefer keeping UX stable
                        // over failing fast with METHOD_NOT_AVAILABLE.
                        if (callback) {
                            callback({
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                    if (targetSocketId === socket.id) {
                        if (callback) {
                            callback({
                                ok: false,
                                error: 'Cannot call RPC on the same socket',
                            });
                        }
                        return;
                    }

                    attemptedTargetSocketId = targetSocketId;
                    const responses = await ctx.io.timeout(forwardTimeoutMs).to(targetSocketId).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                        method,
                        params: callParams,
                    });
                    if (Array.isArray(responses) && responses.length === 0) {
                        // The socket mapping exists in Redis, but no socket acknowledged the call.
                        // Treat this as method unavailable and clean up stale mapping.
                        try {
                            await redisRegistry.removeSocketRegistration(targetUserId, method, targetSocketId);
                        } catch {
                            // best-effort cleanup only
                        }
                        if (callback) {
                            callback({
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                    const response = Array.isArray(responses) ? responses[0] : responses;

                    if (callback) {
                        callback({
                            ok: true,
                            result: response,
                        });
                    }
                    return;
                }

                if (!targetSocket) {
                    targetSocket = lookupInMemoryTargetSocket() ?? undefined;
                }
                if (!targetSocket || !targetSocket.connected) {
                    const awaited = await waitForRpcTargetAvailability({
                        method,
                        initialTargetSocket: targetSocket ?? null,
                        lookupTargetSocket: lookupInMemoryTargetSocket,
                    });
                    targetSocket = awaited.targetSocket ?? undefined;
                }
                if (!targetSocket || !targetSocket.connected) {
                    if (callback) {
                        callback({
                            ok: false,
                            error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
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
                const response = await targetSocket.timeout(forwardTimeoutMs).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                    method,
                    params: callParams,
                });

                if (callback) {
                    callback({
                        ok: true,
                        result: response,
                    });
                }

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';

                // Timeout or error occurred
                if (redisRegistry.enabled && attemptedTargetSocketId) {
                    try {
                        await redisRegistry.removeSocketRegistration(targetUserId, method, attemptedTargetSocketId);
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
            if (callback) {
                callback({
                    ok: false,
                    error: 'Internal error'
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const listeners = resolveUserRpcListeners('get');
        const methodsToRemove: string[] = [];
        for (const [method, registeredSocket] of listeners.entries()) {
            if (registeredSocket === socket) {
                methodsToRemove.push(method);
            }
        }

        if (methodsToRemove.length > 0) {
            methodsToRemove.forEach(method => listeners.delete(method));
            ownedMethods.clear();
            void redisRegistry.cleanupMethodsForSocket(userId, methodsToRemove, socket.id);
        }

        pruneUserRpcListenerMapIfEmpty(allRpcListeners, userId, listeners);

        void redisRegistry.stopRefreshLoopIfIdle();
    });
}
