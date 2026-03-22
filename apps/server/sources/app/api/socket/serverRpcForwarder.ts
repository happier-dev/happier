import { type Server, type Socket } from 'socket.io';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { resolveRpcForwardTimeoutMs } from './rpcForwardTimeout';
import { resolveRpcMethodAvailabilityGraceMs, resolveRpcMethodAvailabilityPollMs } from './rpcMethodAvailabilityGrace';
import { createRpcRedisRegistryCoordinator, type RpcRedisRegistryConfig } from './rpcRedisRegistryCoordinator';

export type ServerRpcForwardResult =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export type ForwardRpcForUser = (params: Readonly<{
    userId: string;
    method: string;
    params: unknown;
    timeoutMs?: number;
}>) => Promise<ServerRpcForwardResult>;

async function waitForRpcTargetAvailability(params: Readonly<{
    method: string;
    initialTargetSocket: Socket | null;
    lookupTargetSocket: () => Socket | null;
    lookupRedisSocketId?: () => Promise<string | null>;
}>): Promise<Readonly<{ targetSocket: Socket | null; targetSocketId: string | null }>> {
    const graceMs = resolveRpcMethodAvailabilityGraceMs(params.method);
    const pollMs = resolveRpcMethodAvailabilityPollMs();
    const deadline = Date.now() + graceMs;

    let targetSocketId = params.lookupRedisSocketId ? await params.lookupRedisSocketId() : null;
    let targetSocket =
        params.initialTargetSocket && params.initialTargetSocket.connected
            ? params.initialTargetSocket
            : params.lookupTargetSocket();

    while (!targetSocketId && (!targetSocket || !targetSocket.connected) && graceMs > 0 && Date.now() < deadline) {
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

export function createServerRpcForwarder(params: Readonly<{
    io: Server;
    allRpcListeners: Map<string, Map<string, Socket>>;
    redisRegistry: RpcRedisRegistryConfig;
}>): ForwardRpcForUser {
    const redisRegistry = createRpcRedisRegistryCoordinator({
        config: params.redisRegistry,
        userId: '__server_forwarder__',
        socketId: '__server_forwarder__',
        ownedMethods: new Set<string>(),
    });

    return async ({ userId, method, params: callParams, timeoutMs }): Promise<ServerRpcForwardResult> => {
        const forwardTimeoutMs = resolveRpcForwardTimeoutMs(method, timeoutMs);
        let attemptedTargetSocketId: string | null = null;
        let targetSocket = params.allRpcListeners.get(userId)?.get(method) ?? null;
        const lookupInMemoryTargetSocket = (): Socket | null => params.allRpcListeners.get(userId)?.get(method) ?? null;

        try {
            if (redisRegistry.enabled) {
                let targetSocketId = await redisRegistry.lookupSocketId(userId, method);
                if (!targetSocketId) {
                    const awaited = await waitForRpcTargetAvailability({
                        method,
                        initialTargetSocket: targetSocket,
                        lookupTargetSocket: lookupInMemoryTargetSocket,
                        lookupRedisSocketId: async () => {
                            const lookedUp = await redisRegistry.lookupSocketId(userId, method);
                            return typeof lookedUp === 'string' && lookedUp.trim().length > 0 ? lookedUp : null;
                        },
                    });
                    targetSocketId = awaited.targetSocketId;
                    targetSocket = awaited.targetSocket ?? targetSocket;
                }

                if (!targetSocketId) {
                    const fallbackSocket = targetSocket ?? lookupInMemoryTargetSocket();
                    if (fallbackSocket && fallbackSocket.connected) {
                        const response = await fallbackSocket.timeout(forwardTimeoutMs).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                            method,
                            params: callParams,
                        });
                        return {
                            ok: true,
                            result: response,
                        };
                    }

                    return {
                        ok: false,
                        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                    };
                }

                attemptedTargetSocketId = targetSocketId;
                const responses = await params.io.timeout(forwardTimeoutMs).to(targetSocketId).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                    method,
                    params: callParams,
                });
                if (Array.isArray(responses) && responses.length === 0) {
                    try {
                        await redisRegistry.removeSocketRegistration(userId, method, targetSocketId);
                    } catch {
                        // best-effort cleanup only
                    }
                    return {
                        ok: false,
                        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                    };
                }

                return {
                    ok: true,
                    result: Array.isArray(responses) ? responses[0] : responses,
                };
            }

            if (!targetSocket || !targetSocket.connected) {
                const awaited = await waitForRpcTargetAvailability({
                    method,
                    initialTargetSocket: targetSocket,
                    lookupTargetSocket: lookupInMemoryTargetSocket,
                });
                targetSocket = awaited.targetSocket;
            }
            if (!targetSocket || !targetSocket.connected) {
                return {
                    ok: false,
                    error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                    errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                };
            }

            const response = await targetSocket.timeout(forwardTimeoutMs).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, {
                method,
                params: callParams,
            });
            return {
                ok: true,
                result: response,
            };
        } catch (error) {
            if (redisRegistry.enabled && attemptedTargetSocketId) {
                try {
                    await redisRegistry.removeSocketRegistration(userId, method, attemptedTargetSocketId);
                } catch {
                    // best-effort cleanup only
                }
            }
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'RPC call failed',
            };
        }
    };
}
