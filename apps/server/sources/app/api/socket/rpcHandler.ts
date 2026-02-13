import { log } from "@/utils/logging/log";
import { Server, Socket } from "socket.io";
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
import { createRpcRedisRegistryCoordinator, type RpcRedisRegistryConfig } from "./rpcRedisRegistryCoordinator";
import { resolveRpcCallTarget } from "./resolveRpcCallTarget";

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

    // RPC register - Register this socket as a listener for an RPC method
    socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: any) => {
        try {
            const { method } = data;

            if (!method || typeof method !== 'string') {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Invalid method name' });
                return;
            }

            // Register this socket as the listener for this method
            userRpcListeners.set(method, socket);
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

            if (userRpcListeners.get(method) === socket) {
                userRpcListeners.delete(method);
                ownedMethods.delete(method);
                await redisRegistry.removeSocketRegistration(userId, method, socket.id);
                await redisRegistry.stopRefreshLoopIfIdle();

                // IMPORTANT:
                // Do not delete the per-user registry map when it becomes empty.
                // Other active sockets for the same user hold a reference to this map in their rpcHandler closures.
                // Deleting it would cause subsequent reconnects to allocate a new map, leaving existing sockets unable
                // to route calls to newly registered methods.
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
            const forwardTimeoutMs = resolveRpcForwardTimeoutMs(method);

            try {
                if (redisRegistry.enabled) {
                    const targetSocketId = await redisRegistry.lookupSocketId(targetUserId, method);
                    if (!targetSocketId) {
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
                    targetSocket = userRpcListeners.get(method);
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
                if (redisRegistry.enabled) {
                    try {
                        const targetSocketId = await redisRegistry.lookupSocketId(targetUserId, method);
                        if (targetSocketId) {
                            await redisRegistry.removeSocketRegistration(targetUserId, method, targetSocketId);
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
            methodsToRemove.forEach(method => userRpcListeners.delete(method));
            ownedMethods.clear();
            void redisRegistry.cleanupMethodsForSocket(userId, methodsToRemove, socket.id);
        }

        if (userRpcListeners.size === 0) {
            // See note in rpc-unregister: keep the per-user registry map object stable across socket lifetimes.
        }

        void redisRegistry.stopRefreshLoopIfIdle();
    });
}
