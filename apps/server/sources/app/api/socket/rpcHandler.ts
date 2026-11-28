import { randomUUID } from "node:crypto";
import { log, warn } from "@/utils/logging/log";
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
    SocketRpcCancellationPayloadSchema,
    SocketRpcRequestIdSchema,
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
import { readHappierSocketData } from "./socketData";
import type {
    CaptureExplicitMachineStopResult,
    createSessionPublisherPresence,
} from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherLifecycleUpdate } from "@/app/session/runtimeActivity/publishPublisherLifecycleUpdate";

const MAX_RPC_METHOD_NAME_LENGTH = 512;

type ActiveSocketRpcCancellation = {
    controller: AbortController;
    targetRequestId: string;
    targetSocketId: string | null;
    targetCancellationSent: boolean;
};

function readOptionalSocketRpcRequestId(data: unknown): string | null | undefined {
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (requestId === undefined) return undefined;
    const parsed = SocketRpcRequestIdSchema.safeParse(requestId);
    return parsed.success ? parsed.data : null;
}

function cancelActiveSocketRpcCall(params: Readonly<{
    io: Server;
    active: ActiveSocketRpcCancellation;
}>): void {
    if (!params.active.controller.signal.aborted) {
        params.active.controller.abort(new Error("RPC request cancelled by caller"));
    }
    if (!params.active.targetSocketId || params.active.targetCancellationSent) return;
    params.active.targetCancellationSent = true;
    try {
        params.io.to(params.active.targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: params.active.targetRequestId,
        });
    } catch (error) {
        log(
            { module: "websocket", level: "warn" },
            `RPC target cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function awaitCancellableTargetResponse<T>(params: Readonly<{
    io: Server;
    cancellation?: ActiveSocketRpcCancellation;
    targetSocketId: string;
    submit: () => Promise<T>;
}>): Promise<T> {
    const active = params.cancellation;
    if (!active) return await params.submit();
    if (active.controller.signal.aborted) throw active.controller.signal.reason;
    active.targetSocketId = params.targetSocketId;
    if (active.controller.signal.aborted) {
        cancelActiveSocketRpcCall({ io: params.io, active });
        throw active.controller.signal.reason;
    }
    const submitted = params.submit();
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(active.controller.signal.reason ?? new Error("RPC request cancelled by caller"));
        active.controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => active.controller.signal.removeEventListener("abort", onAbort);
        if (active.controller.signal.aborted) onAbort();
    });
    try {
        return await Promise.race([submitted, aborted]);
    } finally {
        removeAbortListener();
    }
}

function normalizeRpcMethodName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return trimmed;
}

async function waitForRpcTargetAvailability<T>(
    method: string,
    lookup: () => T | null | Promise<T | null>,
    canForwardImmediately: (target: T) => boolean = () => true,
): Promise<T | null> {
    let target = await lookup();
    if (target !== null && canForwardImmediately(target)) return target;

    const deadline = Date.now() + resolveRpcMethodAvailabilityGraceMs(method);
    const pollMs = resolveRpcMethodAvailabilityPollMs();
    let remainingMs = deadline - Date.now();
    while (remainingMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
        target = await lookup();
        if (target !== null && canForwardImmediately(target)) return target;
        remainingMs = deadline - Date.now();
    }
    return target;
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

function readMachineScopedSocketMachineId(socket: Pick<Socket, "data">): string | null {
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
    socket: Pick<Socket, "data">;
    request: Readonly<{ machineId: string }>;
}>): boolean {
    return readMachineScopedSocketMachineId(params.socket) === params.request.machineId;
}

function readExplicitMachineStopTargetMismatch(params: Readonly<{
    socket: Pick<Socket, "data">;
    request: Readonly<{ machineId: string }> | null;
}>): Readonly<{ ok: false; error: string; errorCode: string }> | null {
    if (!params.request || isExplicitMachineStopTargetSocket({
        socket: params.socket,
        request: params.request,
    })) {
        return null;
    }
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
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
    const pendingRegistrations = new Map<string, symbol>();
    const redisRegistry = createRpcRedisRegistryCoordinator({
        config: ctx.redisRegistry,
        userId,
        socketId: socket.id,
    });
    // Correlations are scoped to this authenticated caller socket. The relay
    // maps each one to a fresh target id before forwarding.
    const activeCancellations = new Map<string, ActiveSocketRpcCancellation>();

    socket.on(SOCKET_RPC_EVENTS.CANCEL, (data: unknown) => {
        const parsed = SocketRpcCancellationPayloadSchema.safeParse(data);
        if (!parsed.success) return;
        const active = activeCancellations.get(parsed.data.requestId);
        if (active) cancelActiveSocketRpcCall({ io: ctx.io, active });
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
    socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: { method?: unknown } | undefined) => {
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

        // Machine validation can yield to an unregister, disconnect, or replacement REGISTER.
        const registration = Symbol();
        pendingRegistrations.set(method, registration);
        try {
            const machineId = readMachineScopedSocketMachineId(socket);
            if (machineId) {
                const currentMachine = await validateCurrentMachineSocket({ accountId: userId, machineId });
                if (pendingRegistrations.get(method) !== registration) return;
                if (!currentMachine.ok) {
                    socket.emit(SOCKET_RPC_EVENTS.ERROR, {
                        type: 'register',
                        error: formatCurrentMachineSocketError(currentMachine.reason),
                    });
                    return;
                }
            }
            if (!socket.connected) return;

            resolveUserRpcListeners('ensure').set(method, socket);
            await redisRegistry.registerMethod(method);

            if (pendingRegistrations.get(method) === registration && socket.connected) {
                socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-register: ${error}`);
            if (pendingRegistrations.get(method) === registration && socket.connected) {
                socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'register', error: 'Internal error' });
            }
        } finally {
            if (pendingRegistrations.get(method) === registration) pendingRegistrations.delete(method);
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

            pendingRegistrations.delete(method);
            const listeners = resolveUserRpcListeners('get');
            if (listeners.get(method) === socket) {
                listeners.delete(method);
                pruneUserRpcListenerMapIfEmpty(allRpcListeners, userId, listeners);
            }
            await redisRegistry.unregisterMethod(method);

            socket.emit(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in rpc-unregister: ${error}`);
            socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: 'unregister', error: 'Internal error' });
        }
    });

    // RPC call - Call an RPC method on another socket of the same user
    socket.on(SOCKET_RPC_EVENTS.CALL, async (data: any, callback: (response: any) => void) => {
        let callerRequestId: string | undefined;
        let cancellation: ActiveSocketRpcCancellation | undefined;
        try {
            const parsedRequestId = readOptionalSocketRpcRequestId(data);
            if (parsedRequestId === null) {
                callback?.({ ok: false, error: "Invalid RPC request correlation" });
                return;
            }
            callerRequestId = parsedRequestId;
            if (callerRequestId) {
                if (activeCancellations.has(callerRequestId)) {
                    callback?.({ ok: false, error: "RPC request correlation is already active" });
                    return;
                }
                cancellation = {
                    controller: new AbortController(),
                    targetRequestId: `rpc_${randomUUID()}`,
                    targetSocketId: null,
                    targetCancellationSent: false,
                };
                activeCancellations.set(callerRequestId, cancellation);
            }
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

            const { targetUserId } = targetResolution;
            const explicitMachineStopRequest = readExplicitMachineStopRequest(method, rpcAuthorization);
            if (method.endsWith(`:${RPC_METHODS.STOP_SESSION}`) && !explicitMachineStopRequest) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: sessionId is required",
                });
                return;
            }
            const forwardTimeoutMs = resolveRpcForwardTimeoutMs(method, requestedTimeoutMs);
            let explicitMachineStopCapture: CaptureExplicitMachineStopResult | null = null;
            const buildForwardedRequest = () => ({
                method,
                params: callParams,
                ...(cancellation ? { requestId: cancellation.targetRequestId } : {}),
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
                        badgeAttentionChanged: closed.badgeAttentionChanged,
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
                        callback?.(explicitMachineStopCapture.reason === "machine_control_unavailable"
                            ? {
                                ok: false,
                                error: RPC_ERROR_MESSAGES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
                                errorCode: RPC_ERROR_CODES.SESSION_MACHINE_CONTROL_UNAVAILABLE,
                            }
                            : {
                                ok: false,
                                error: "Session stop target unavailable",
                            });
                        return;
                    }
                }

                const lookupConnectedLocalTarget = () => {
                    const local = lookupInMemoryTargetSocket();
                    return local?.connected ? local : null;
                };
                const needsRemoteMachine = Boolean(
                    resolveSocketRpcProviderStartingMethod(method) || explicitMachineStopRequest,
                );
                let unreachableRemoteId: string | null = null;
                let initialRedisSocketId: string | null | undefined;
                const target = redisRegistry.enabled
                    ? await waitForRpcTargetAvailability(method, async () => {
                        const id = await redisRegistry.lookupSocketId(targetUserId, method);
                        if (initialRedisSocketId === undefined) initialRedisSocketId = id;
                        if (!id) {
                            unreachableRemoteId = null;
                            return null;
                        }
                        const local = lookupConnectedLocalTarget();
                        if (local?.id === id) return { id, local, metadata: local, ready: true };
                        if (!needsRemoteMachine || id === socket.id) {
                            // For ordinary calls, preserve the existing Redis-only grace when
                            // the initial remote ID is unchanged. No cluster census is needed.
                            return { id, local: null, metadata: null, ready: id !== initialRedisSocketId || id === socket.id };
                        }

                        // Reuse the reconnect window without running a cluster lookup on every poll.
                        if (id === unreachableRemoteId) return null;
                        const candidates = await ctx.io.in(id).fetchSockets();
                        const remote = candidates.find(candidate => candidate.id === id);
                        unreachableRemoteId = remote ? null : id;
                        return remote ? { id, local: null, metadata: remote, ready: true } : null;
                    }, target => target.ready)
                    : await waitForRpcTargetAvailability(method, () => {
                        const initial = targetResolution.targetSocket;
                        const local = initial?.connected ? initial : lookupConnectedLocalTarget();
                        return local ? { id: local.id, local, metadata: local } : null;
                    });
                if (!target) {
                    callback?.({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                    return;
                }
                const { id: targetSocketId, local: localTarget, metadata: targetWithMetadata } = target;
                if (targetSocketId === socket.id) {
                    callback?.({ ok: false, error: 'Cannot call RPC on the same socket' });
                    return;
                }

                if (targetWithMetadata) {
                    const stopTargetMismatch = readExplicitMachineStopTargetMismatch({
                        socket: targetWithMetadata,
                        request: explicitMachineStopRequest,
                    });
                    if (stopTargetMismatch) {
                        callback?.(stopTargetMismatch);
                        return;
                    }
                    const machineId = readMachineScopedSocketMachineId(targetWithMetadata);
                    if (!localTarget && needsRemoteMachine && !machineId) {
                        callback?.({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                        return;
                    }
                    if (machineId) {
                        const targetMachine = await validateCurrentMachineSocket({ accountId: targetUserId, machineId });
                        if (!targetMachine.ok) {
                            callback?.({
                                ok: false,
                                error: formatCurrentMachineSocketError(targetMachine.reason),
                                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            });
                            return;
                        }
                    }
                }

                const responses = await awaitCancellableTargetResponse({
                    io: ctx.io,
                    cancellation,
                    targetSocketId,
                    submit: async () => {
                        const request = buildForwardedRequest();
                        if (localTarget) {
                            // A direct ack can itself be an array. Wrap it in the response list
                            // so it is interpreted the same way as a single broadcast ack.
                            return [await localTarget.timeout(forwardTimeoutMs).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, request)];
                        }
                        const responses = await ctx.io.timeout(forwardTimeoutMs).to(targetSocketId).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, request);
                        return Array.isArray(responses) ? responses : [responses];
                    },
                });
                if (responses.length === 0) {
                    callback?.({ ok: false, error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
                    return;
                }
                // Stop lifecycle effects apply even when the caller supplied no acknowledgement.
                const forwardedResponse = await forwardTargetResponse(responses[0]);
                callback?.(forwardedResponse);
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'RPC call failed';

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
        } finally {
            if (
                callerRequestId
                && cancellation
                && activeCancellations.get(callerRequestId) === cancellation
            ) {
                activeCancellations.delete(callerRequestId);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const active of activeCancellations.values()) {
            cancelActiveSocketRpcCall({ io: ctx.io, active });
        }
        activeCancellations.clear();
        pendingRegistrations.clear();
        const listeners = resolveUserRpcListeners('get');
        for (const [method, registeredSocket] of listeners) {
            if (registeredSocket === socket) listeners.delete(method);
        }
        pruneUserRpcListenerMapIfEmpty(allRpcListeners, userId, listeners);

        void redisRegistry.unregisterAll().catch(error => {
            warn({ module: "websocket", socketId: socket.id, error }, "Failed to unregister Redis RPC routes on disconnect");
        });
    });
}
