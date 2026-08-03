import { log } from "@/utils/logging/log";
import { Server, Socket } from "socket.io";
import {
    parseSocketRpcAuthorizationContext,
    RPC_METHODS,
    resolveSocketRpcProviderStartingMethod,
    resolveSocketRpcSessionWriteAuthorizationMethod,
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    type SocketRpcAuthorizationContext,
} from "@happier-dev/protocol/rpc";
import {
    SOCKET_RPC_EVENTS,
    SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
    SocketRpcTransportResponseEnvelopeV1Schema,
} from "@happier-dev/protocol/socketRpc";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
import { resolveRpcMethodAvailabilityGraceMs, resolveRpcMethodAvailabilityPollMs } from "./rpcMethodAvailabilityGrace";
import { createRpcRedisRegistryCoordinator, type RpcRedisRegistryConfig } from "./rpcRedisRegistryCoordinator";
import { resolveRpcCallTarget } from "./resolveRpcCallTarget";
import { canRegisterSessionScopedRpcMethod } from "./sessionScopedBinding";
import { forwardedRpcTargetResponse } from './forwardedRpcTargetResponse';
import {
    formatCurrentMachineSocketError,
    validateCurrentMachineSocket,
} from "@/app/machines/validateCurrentMachineSocket";
import {
    revalidateSessionSyncSocketCompatibility,
} from "@/app/clientCompatibility/socketEnforcement";
import { readHappierSocketData } from "./socketData";
import type {
    CaptureExplicitMachineStopResult,
    createSessionPublisherPresence,
} from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherLifecycleUpdate } from "@/app/session/runtimeActivity/publishPublisherLifecycleUpdate";

const MAX_RPC_METHOD_NAME_LENGTH = 512;

function normalizeRpcMethodName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return trimmed;
}

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

function readMachineScopedSocketMachineId(socket: Socket): string | null {
    const socketData = readHappierSocketData(socket);
    const clientType = socketData.clientType ?? '';
    const machineId = socketData.machineId ?? '';
    return clientType === 'machine-scoped' && machineId ? machineId : null;
}

function readMachineIdPrefix(method: string): string | null {
    const separatorIndex = method.indexOf(':');
    if (separatorIndex <= 0) return null;
    return method.slice(0, separatorIndex);
}

function canRegisterMachineScopedRpcMethod(socket: Socket, method: string): boolean {
    const machineId = readMachineScopedSocketMachineId(socket);
    if (!machineId) return true;
    const methodMachineId = readMachineIdPrefix(method);
    return methodMachineId === null || methodMachineId === machineId;
}

function isExplicitMachineStopTargetSocket(params: Readonly<{
    socket: Socket;
    request: Readonly<{ machineId: string }>;
}>): boolean {
    return readMachineScopedSocketMachineId(params.socket) === params.request.machineId;
}

function readExplicitMachineStopRequest(method: string, value: unknown): Readonly<{
    machineId: string;
    sessionId: string;
}> | null {
    const machineId = readMachineIdPrefix(method);
    if (!machineId || method.slice(machineId.length + 1) !== RPC_METHODS.STOP_SESSION) return null;
    // Machine params stay end-to-end encrypted; the authorized session context is
    // the server-readable identity used to fence and finalize the exact publisher.
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const sessionId = (value as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string") return null;
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId || trimmedSessionId.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return { machineId, sessionId: trimmedSessionId };
}

function revalidatePrivilegedRpcTargetCompatibility(socket: Socket, method: string) {
    if (!resolveSocketRpcProviderStartingMethod(method)) return null;
    const socketData = readHappierSocketData(socket);
    return revalidateSessionSyncSocketCompatibility(
        socketData.clientType === 'machine-scoped' && socketData.sessionSyncCompatibility
            ? socketData.sessionSyncCompatibility.parseResult
            : { status: 'missing' },
        process.env,
        'machine-scoped',
    );
}

function buildPrivilegedRpcUpgradeRequiredResponse(socket: Socket, method: string) {
    const compatibility = revalidatePrivilegedRpcTargetCompatibility(socket, method);
    if (compatibility === null || compatibility.accepted) return null;
    return {
        ok: false as const,
        error: 'client-upgrade-required',
        ...(compatibility.upgradeRequired ?? {}),
    };
}

function buildForbiddenRpcResponse() {
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.FORBIDDEN,
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
    };
}

export function rpcHandler(
    userId: string,
    socket: Socket,
    userRpcListeners: Map<string, Socket>,
    allRpcListeners: Map<string, Map<string, Socket>>,
    ctx: {
        io: Server;
        redisRegistry: RpcRedisRegistryConfig;
        sessionPublisherPresence?: Pick<
            ReturnType<typeof createSessionPublisherPresence>,
            "captureExplicitMachineStop" | "finalizeExplicitMachineStop"
        >;
    },
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
            const method = normalizeRpcMethodName(data?.method);

            if (!method) {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Invalid method name' });
                return;
            }

            if (
                !canRegisterSessionScopedRpcMethod({ socket, method })
                || !canRegisterMachineScopedRpcMethod(socket, method)
            ) {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Forbidden' });
                return;
            }

            const machineId = readMachineScopedSocketMachineId(socket);
            if (machineId) {
                if (resolveSocketRpcProviderStartingMethod(method)) {
                    const compatibility = readHappierSocketData(socket).sessionSyncCompatibility;
                    const currentCompatibility = revalidateSessionSyncSocketCompatibility(
                        compatibility?.parseResult ?? { status: 'missing' },
                        process.env,
                        'machine-scoped',
                    );
                    if (!currentCompatibility.accepted) {
                        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
                            type: 'register',
                            error: 'client-upgrade-required',
                            ...(currentCompatibility.upgradeRequired ?? {}),
                        });
                        return;
                    }
                }
                const currentMachine = await validateCurrentMachineSocket({ accountId: userId, machineId });
                if (!currentMachine.ok) {
                    socket.emit(SOCKET_RPC_EVENTS.ERROR, {
                        type: 'register',
                        error: formatCurrentMachineSocketError(currentMachine.reason),
                    });
                    return;
                }
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
            const method = normalizeRpcMethodName(data?.method);

            if (!method) {
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
            const method = normalizeRpcMethodName(data?.method);
            const callParams = data?.params;
            const requestedTimeoutMs = data?.timeoutMs;
            let rpcAuthorization: SocketRpcAuthorizationContext | null = null;

            if (!method) {
                if (callback) {
                    callback({
                        ok: false,
                        error: 'Invalid parameters: method is required',
                    });
                }
                return;
            }

            if (resolveSocketRpcSessionWriteAuthorizationMethod(method)) {
                const authorization = parseSocketRpcAuthorizationContext(data?.authorization);
                if (!authorization) {
                    if (callback) {
                        callback(buildForbiddenRpcResponse());
                    }
                    return;
                }

                const access = await checkSessionAccess(userId, authorization.sessionId);
                if (!access || !requireAccessLevel(access, 'edit')) {
                    if (callback) {
                        callback(buildForbiddenRpcResponse());
                    }
                    return;
                }
                rpcAuthorization = authorization;
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
            const explicitMachineStopRequest = readExplicitMachineStopRequest(method, rpcAuthorization);
            if (method.endsWith(`:${RPC_METHODS.STOP_SESSION}`) && !explicitMachineStopRequest) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: sessionId is required",
                });
                return;
            }
            const forwardTimeoutMs = resolveRpcForwardTimeoutMs(method, requestedTimeoutMs);
            let attemptedTargetSocketId: string | null = null;
            let explicitMachineStopCapture: CaptureExplicitMachineStopResult | null = null;
            const buildForwardedRequest = () => ({
                method,
                params: callParams,
                ...(rpcAuthorization ? { authorization: rpcAuthorization } : {}),
                ...(explicitMachineStopRequest
                    ? {
                        transportResponseEnvelopeVersion:
                            SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1,
                    }
                    : {}),
            });
            const lookupInMemoryTargetSocket = (): Socket | null => {
                if (targetUserId === userId && !allRpcListeners.has(userId)) {
                    return userRpcListeners.get(method) ?? null;
                }
                return allRpcListeners.get(targetUserId)?.get(method) ?? null;
            };
            // Explicit machine-stop lifecycle work is independent from whether the caller
            // supplied an acknowledgement callback, so every successful forward runs it.
            const forwardTargetResponse = async (targetResponse: unknown) => {
                const envelope = explicitMachineStopRequest
                    ? SocketRpcTransportResponseEnvelopeV1Schema.safeParse(targetResponse)
                    : null;
                const targetResult = envelope?.success ? envelope.data.result : targetResponse;
                const forwarded = forwardedRpcTargetResponse({ method, targetResponse: targetResult });
                if (!explicitMachineStopRequest || explicitMachineStopCapture?.status !== "captured") {
                    return forwarded;
                }
                const didProveStopped = (
                    envelope?.success
                    && envelope.data.acknowledgement?.kind === "session.stop"
                    && envelope.data.acknowledgement.status === "stopped"
                );
                if (!didProveStopped) return forwarded;
                const presence = ctx.sessionPublisherPresence;
                if (!presence) {
                    return {
                        ok: false as const,
                        error: "Server explicit stop lifecycle owner unavailable",
                    };
                }
                const closed = await presence.finalizeExplicitMachineStop({
                    target: explicitMachineStopCapture.target,
                });
                if (closed.status === "closed") {
                    await publishSessionPublisherLifecycleUpdate({
                        sessionId: explicitMachineStopRequest.sessionId,
                        participantCursors: closed.participantCursors,
                        active: false,
                        activeAt: closed.activeAt.getTime(),
                        ...(closed.projection ? { projection: closed.projection } : {}),
                        ...(closed.turnProjection ?? {}),
                    });
                    return forwarded;
                }
                if (closed.status === "already_inactive") return forwarded;
                return {
                    ok: false as const,
                    error: closed.status === "superseded"
                        ? "Session resumed while stop was in progress"
                        : "Session stop could not be finalized safely",
                };
            };

            try {
                const targetMachineIdPrefix = readMachineIdPrefix(method);
                if (targetMachineIdPrefix) {
                    const targetMachine = await validateCurrentMachineSocket({
                        accountId: targetUserId,
                        machineId: targetMachineIdPrefix,
                    });
                    if (!targetMachine.ok && targetMachine.reason !== "machine_not_found") {
                        if (callback) {
                            callback({
                                ok: false,
                                error: formatCurrentMachineSocketError(targetMachine.reason),
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                }
                if (explicitMachineStopRequest) {
                    const presence = ctx.sessionPublisherPresence;
                    if (!presence) {
                        callback?.({
                            ok: false,
                            error: "Server explicit stop lifecycle owner unavailable",
                        });
                        return;
                    }
                    explicitMachineStopCapture = await presence.captureExplicitMachineStop({
                        binding: {
                            accountId: targetUserId,
                            machineId: explicitMachineStopRequest.machineId,
                            sessionId: explicitMachineStopRequest.sessionId,
                        },
                    });
                    if (explicitMachineStopCapture.status === "rejected") {
                        callback?.(explicitMachineStopCapture.reason === "unauthorized"
                            ? buildForbiddenRpcResponse()
                            : {
                                ok: false,
                                error: "Session stop target unavailable",
                            });
                        return;
                    }
                }

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
                    const fallbackCandidate = targetSocket ?? lookupInMemoryTargetSocket();
                    const fallbackSocket = (
                        fallbackCandidate
                        && (
                            !explicitMachineStopRequest
                            || !targetSocketId
                            || fallbackCandidate.id === targetSocketId
                        )
                    )
                        ? fallbackCandidate
                        : null;
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

                        const fallbackMachineId = readMachineScopedSocketMachineId(fallbackSocket);
                        if (
                            explicitMachineStopRequest
                            && !isExplicitMachineStopTargetSocket({
                                socket: fallbackSocket,
                                request: explicitMachineStopRequest,
                            })
                        ) {
                            callback?.({
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                        if (fallbackMachineId) {
                            const fallbackMachine = await validateCurrentMachineSocket({
                                accountId: targetUserId,
                                machineId: fallbackMachineId,
                            });
                            if (!fallbackMachine.ok) {
                                if (callback) {
                                    callback({
                                        ok: false,
                                        error: formatCurrentMachineSocketError(fallbackMachine.reason),
                                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                                    });
                                }
                                return;
                            }
                        }

                        const upgradeRequired = buildPrivilegedRpcUpgradeRequiredResponse(fallbackSocket, method);
                        if (upgradeRequired) {
                            callback?.(upgradeRequired);
                            return;
                        }

                        const response = await fallbackSocket.timeout(forwardTimeoutMs).emitWithAck(
                            SOCKET_RPC_EVENTS.REQUEST,
                            buildForwardedRequest(),
                        );
                        // Evaluated before the optional call: `callback?.(await ...)` would
                        // short-circuit its argument and skip the stop lifecycle entirely
                        // when the caller emitted without an acknowledgement.
                        const forwardedResponse = await forwardTargetResponse(response);
                        callback?.(forwardedResponse);
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
                    if (resolveSocketRpcProviderStartingMethod(method) || explicitMachineStopRequest) {
                        const currentTargets = await ctx.io.in(targetSocketId).fetchSockets();
                        const currentTarget = currentTargets.find((candidate) => candidate.id === targetSocketId);
                        if (!currentTarget) {
                            await redisRegistry.removeSocketRegistration(targetUserId, method, targetSocketId);
                            callback?.({
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                        const currentMachineId = readMachineScopedSocketMachineId(currentTarget as unknown as Socket);
                        if (
                            explicitMachineStopRequest
                            && !isExplicitMachineStopTargetSocket({
                                socket: currentTarget as unknown as Socket,
                                request: explicitMachineStopRequest,
                            })
                        ) {
                            callback?.({
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                        if (!currentMachineId) {
                            const upgradeRequired = buildPrivilegedRpcUpgradeRequiredResponse(
                                currentTarget as unknown as Socket,
                                method,
                            );
                            callback?.(upgradeRequired ?? {
                                ok: false,
                                error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                        const currentMachine = await validateCurrentMachineSocket({
                            accountId: targetUserId,
                            machineId: currentMachineId,
                        });
                        if (!currentMachine.ok) {
                            callback?.({
                                ok: false,
                                error: formatCurrentMachineSocketError(currentMachine.reason),
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                        const upgradeRequired = buildPrivilegedRpcUpgradeRequiredResponse(
                            currentTarget as unknown as Socket,
                            method,
                        );
                        if (upgradeRequired) {
                            callback?.(upgradeRequired);
                            return;
                        }
                    }
                    const responses = await ctx.io.timeout(forwardTimeoutMs).to(targetSocketId).emitWithAck(
                        SOCKET_RPC_EVENTS.REQUEST,
                        buildForwardedRequest(),
                    );
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

                    const forwardedResponse = await forwardTargetResponse(response);
                    callback?.(forwardedResponse);
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

                const targetMachineId = readMachineScopedSocketMachineId(targetSocket);
                if (
                    explicitMachineStopRequest
                    && !isExplicitMachineStopTargetSocket({
                        socket: targetSocket,
                        request: explicitMachineStopRequest,
                    })
                ) {
                    callback?.({
                        ok: false,
                        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                    });
                    return;
                }
                if (targetMachineId) {
                    const targetMachine = await validateCurrentMachineSocket({
                        accountId: targetUserId,
                        machineId: targetMachineId,
                    });
                    if (!targetMachine.ok) {
                        if (callback) {
                            callback({
                                ok: false,
                                error: formatCurrentMachineSocketError(targetMachine.reason),
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                        }
                        return;
                    }
                }

                const upgradeRequired = buildPrivilegedRpcUpgradeRequiredResponse(targetSocket, method);
                if (upgradeRequired) {
                    callback?.(upgradeRequired);
                    return;
                }

                // Forward the RPC request to the target socket using emitWithAck (single-process path).
                const response = await targetSocket.timeout(forwardTimeoutMs).emitWithAck(
                    SOCKET_RPC_EVENTS.REQUEST,
                    buildForwardedRequest(),
                );

                const forwardedResponse = await forwardTargetResponse(response);
                callback?.(forwardedResponse);

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
