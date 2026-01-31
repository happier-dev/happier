import { eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { Socket } from "socket.io";
import { RPC_ERROR_CODES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";
import { db } from "@/storage/db";
import { canApprovePermissions } from "@/app/share/accessControl";

export function rpcHandler(
    userId: string,
    socket: Socket,
    userRpcListeners: Map<string, Socket>,
    allRpcListeners: Map<string, Map<string, Socket>>,
) {
    
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
            const { method, params } = data;

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
                            const ownerListeners = allRpcListeners.get(ownerId);
                            targetSocket = ownerListeners?.get(method);
                            if (targetSocket) {
                                log({ module: 'websocket-rpc' }, `Delegated permission RPC: ${userId} -> ${ownerId} (${sessionId})`);
                            }
                        }
                    }
                }
            }

            if (!targetSocket) {
                targetSocket = userRpcListeners.get(method);
            }
            if (!targetSocket || !targetSocket.connected) {
                // log({ module: 'websocket-rpc' }, `RPC call failed: Method ${method} not available (disconnected or not registered)`);
                if (callback) {
                    callback({
                        ok: false,
                        error: 'RPC method not available',
                        // Backward compatible: older clients rely on the error string.
                        // Newer clients should prefer this structured code.
                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                    });
                }
                return;
            }

            // Don't allow calling your own socket
            if (targetSocket === socket) {
                // log({ module: 'websocket-rpc' }, `RPC call failed: Attempted self-call on method ${method}`);
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Cannot call RPC on the same socket'
                    });
                }
                return;
            }

            // Log RPC call initiation
            const startTime = Date.now();
            // log({ module: 'websocket-rpc' }, `RPC call initiated: ${socket.id} -> ${method} (target: ${targetSocket.id})`);

            // Forward the RPC request to the target socket using emitWithAck
            try {
                const response = await targetSocket.timeout(30000).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                    method,
                    params
                });

                const duration = Date.now() - startTime;
                // log({ module: 'websocket-rpc' }, `RPC call succeeded: ${method} (${duration}ms)`);

                // Forward the response back to the caller via callback
                if (callback) {
                    callback({
                        ok: true,
                        result: response
                    });
                }

            } catch (error) {
                const duration = Date.now() - startTime;
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';
                // log({ module: 'websocket-rpc' }, `RPC call failed: ${method} - ${errorMsg} (${duration}ms)`);

                // Timeout or error occurred
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
        }

        if (userRpcListeners.size === 0) {
            allRpcListeners.delete(userId);
            // log({ module: 'websocket-rpc' }, `All RPC listeners removed for user ${userId}`);
        }
    });
}
