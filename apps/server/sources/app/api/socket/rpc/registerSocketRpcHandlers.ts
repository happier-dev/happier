import { randomUUID } from "node:crypto";

import type { Server, Socket } from "socket.io";

import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    RPC_METHODS,
    SESSION_RPC_METHODS,
    parseSocketRpcAuthorizationContext,
    resolveSocketRpcSessionWriteAuthorizationMethod,
    type SocketRpcAuthorizationContext,
} from "@happier-dev/protocol/rpc";
import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from "@happier-dev/protocol";
import {
    SOCKET_RPC_EVENTS,
    SocketRpcCancellationPayloadSchema,
    SocketRpcRequestIdSchema,
} from "@happier-dev/protocol/socketRpc";

import { observeRpcCall, recordRpcCallFailure, recordRpcRegistration, recordRpcUnregistration } from "@/app/monitoring/metrics/index";
import { readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { log } from "@/utils/logging/log";
import type {
    CaptureExplicitMachineStopResult,
    createSessionPublisherPresence,
} from "@/app/presence/sessionPublisherPresence";
import { readSessionPublisherAuthorityProjection } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";

import { canCallSessionScopedRpcMethod, canRegisterSessionScopedRpcMethod } from "../sessionScopedBinding";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "../machineSocketInstallationProof";
import { forwardRpcCall } from "./forwardRpcCall";
import type { RpcForwardTargetGuard } from "./_types";
import { buildRpcMethodRoom } from "./rpcMethodRoom";
import { resolveRpcCallTarget } from "./resolveRpcCallTarget";

const MAX_RPC_METHOD_NAME_LENGTH = 512;
const RPC_REGISTERED_METHODS_SOCKET_DATA_KEY = "rpcRegisteredMethods";
const MACHINE_VISIBLE_CLIENT_RPC_METHODS = new Set<string>([
    RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME,
]);

type SessionPublisherPresenceForRpc = Pick<
    ReturnType<typeof createSessionPublisherPresence>,
    | "captureExplicitMachineStop"
    | "finalizeExplicitMachineStop"
    | "isCurrentPublisherProjection"
    | "runAsProjectedCurrentPublisher"
>;

type SocketDataCarrier = Readonly<{ data?: unknown }>;

type MachineScopedRpcMethod = Readonly<{
    machineId: string;
    rpcMethod: string;
}>;

type ActiveSocketRpcCancellation = {
    controller: AbortController;
    targetRequestId: string;
    targetSocketId: string | null;
    cancelled: boolean;
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
    if (params.active.cancelled) return;
    params.active.cancelled = true;
    params.active.controller.abort();
    if (!params.active.targetSocketId) return;
    try {
        params.io.to(params.active.targetSocketId).emit(SOCKET_RPC_EVENTS.CANCEL, {
            requestId: params.active.targetRequestId,
        });
    } catch (error) {
        log(
            { module: "websocket-rpc", level: "warn", targetSocketId: params.active.targetSocketId },
            `RPC target cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function normalizeRpcMethodName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return trimmed;
}

function parseMachineScopedRpcMethod(method: string): MachineScopedRpcMethod | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === method.length - 1) return null;
    const machineId = method.slice(0, separatorIndex).trim();
    const rpcMethod = method.slice(separatorIndex + 1).trim();
    if (!machineId || !MACHINE_VISIBLE_CLIENT_RPC_METHODS.has(rpcMethod)) return null;
    return { machineId, rpcMethod };
}

function readExplicitMachineStopRequest(method: string, value: unknown): Readonly<{
    machineId: string;
    sessionId: string;
}> | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || method.slice(separatorIndex + 1) !== RPC_METHODS.STOP_SESSION) return null;
    const machineId = method.slice(0, separatorIndex).trim();
    if (!machineId || !value || typeof value !== "object" || Array.isArray(value)) return null;
    const sessionId = (value as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string") return null;
    const trimmedSessionId = sessionId.trim();
    if (!trimmedSessionId || trimmedSessionId.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return { machineId, sessionId: trimmedSessionId };
}

function readSessionModelTransitionSessionId(method: string): string | null {
    const suffix = `:${SESSION_RPC_METHODS.SESSION_MODEL_TRANSITION}`;
    if (!method.endsWith(suffix)) return null;
    const sessionId = method.slice(0, -suffix.length).trim();
    return sessionId.length > 0 ? sessionId : null;
}

function createSessionModelTransitionTargetGuard(params: Readonly<{
    method: string;
    targetUserId: string;
    presence?: SessionPublisherPresenceForRpc;
}>): RpcForwardTargetGuard | null {
    const sessionId = readSessionModelTransitionSessionId(params.method);
    if (!sessionId) return null;

    return {
        filterTargets: async (targets) => {
            if (!params.presence) return [];
            const currentTargets: typeof targets = [];
            for (const target of targets) {
                const projection = readSessionPublisherAuthorityProjection(target.data);
                if (!projection) continue;
                if (await params.presence.isCurrentPublisherProjection({
                    expectedAccountId: params.targetUserId,
                    expectedSessionId: sessionId,
                    projection,
                })) {
                    currentTargets.push(target);
                }
            }
            return currentTargets.length === 1 ? currentTargets : [];
        },
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!params.presence) return { status: "unavailable" };
            const initialProjection = readSessionPublisherAuthorityProjection(target.data);
            if (!initialProjection) return { status: "unavailable" };
            return await params.presence.runAsProjectedCurrentPublisher({
                expectedAccountId: params.targetUserId,
                expectedSessionId: sessionId,
                initialProjection,
                readLatestProjection: async () => {
                    const latestTarget = await readLatestTarget();
                    return latestTarget
                        ? readSessionPublisherAuthorityProjection(latestTarget.data)
                        : null;
                },
                operation: async () => await operation(),
            });
        },
    };
}

function buildMachineScopedSocketRoom(params: Readonly<{
    userId: string;
    machineId: string;
}>): string {
    return `machine:${params.machineId}:${params.userId}`;
}

function readSocketData(socket: SocketDataCarrier): Record<string, unknown> {
    return socket.data && typeof socket.data === "object" && !Array.isArray(socket.data)
        ? socket.data as Record<string, unknown>
        : {};
}

function ensureMutableSocketData(socket: Socket): Record<string, unknown> {
    const mutableSocket = socket as Socket & { data: Record<string, unknown> };
    if (!mutableSocket.data || typeof mutableSocket.data !== "object" || Array.isArray(mutableSocket.data)) {
        mutableSocket.data = {};
    }
    return mutableSocket.data;
}

function readSocketClientType(socket: SocketDataCarrier): string | null {
    const clientType = readSocketData(socket).clientType;
    return typeof clientType === "string" ? clientType : null;
}

function readMachineScopedSocketMachineId(socket: SocketDataCarrier): string | null {
    if (readSocketClientType(socket) !== "machine-scoped") return null;
    const machineId = readSocketData(socket).machineId;
    if (typeof machineId !== "string") return null;
    const trimmed = machineId.trim();
    return trimmed ? trimmed : null;
}

function readMachineIdPrefix(method: string): string | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0) return null;
    const prefix = method.slice(0, separatorIndex).trim();
    return prefix || null;
}

const RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS = new Set<string>([
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
]);

function readReservedServerOriginTargetMachineId(method: string): string | null {
    const separatorIndex = method.indexOf(":");
    if (separatorIndex <= 0 || !RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS.has(method.slice(separatorIndex + 1))) {
        return null;
    }
    const machineId = method.slice(0, separatorIndex).trim();
    return machineId || null;
}

function isReservedServerOriginRpcMethod(method: string): boolean {
    return [...RESERVED_SERVER_ORIGIN_DAEMON_RPC_METHODS].some((reservedMethod) => (
        method === reservedMethod || method.endsWith(`:${reservedMethod}`)
    ));
}

function isSessionServerStartReservedRpcMethod(method: string): boolean {
    return method === SESSION_SERVER_START_DAEMON_RPC_METHOD_V1
        || method.endsWith(`:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`);
}

function canRegisterReservedServerOriginRpcMethod(params: Readonly<{
    socket: SocketDataCarrier;
    method: string;
}>): boolean {
    const targetMachineId = readReservedServerOriginTargetMachineId(params.method);
    if (
        targetMachineId === null
        || readMachineScopedSocketMachineId(params.socket) !== targetMachineId
    ) {
        return false;
    }
    return !isSessionServerStartReservedRpcMethod(params.method)
        || readVerifiedMachineSocketInstallationIdFromSocketData(readSocketData(params.socket)) !== null;
}

function canRegisterMachineScopedRpcMethod(params: Readonly<{
    socketMachineId: string;
    method: string;
}>): boolean {
    const methodMachineId = readMachineIdPrefix(params.method);
    return methodMachineId === null || methodMachineId === params.socketMachineId;
}

function createExplicitMachineStopTargetGuard(
    request: Readonly<{ machineId: string }>,
): RpcForwardTargetGuard {
    const matchesRequestMachine = (target: SocketDataCarrier): boolean => (
        readMachineScopedSocketMachineId(target) === request.machineId
    );
    return {
        filterTargets: async (targets) => targets.filter(matchesRequestMachine),
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!matchesRequestMachine(target)) return { status: "unavailable" };
            const latestTarget = await readLatestTarget();
            if (!latestTarget || !matchesRequestMachine(latestTarget)) {
                return { status: "unavailable" };
            }
            return { status: "current", value: await operation() };
        },
    };
}

function readSocketRegisteredRpcMethods(socket: SocketDataCarrier): readonly string[] {
    const registeredMethods = readSocketData(socket)[RPC_REGISTERED_METHODS_SOCKET_DATA_KEY];
    if (!Array.isArray(registeredMethods)) return [];
    return registeredMethods.filter((method): method is string => typeof method === "string" && method.trim().length > 0);
}

function writeSocketRegisteredRpcMethods(socket: Socket, methods: ReadonlySet<string>): void {
    ensureMutableSocketData(socket)[RPC_REGISTERED_METHODS_SOCKET_DATA_KEY] = [...methods];
}

function buildForbiddenRpcResponse(): Readonly<{ ok: false; error: string; errorCode: string }> {
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.FORBIDDEN,
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
    };
}

async function isMachineScopedRpcMethodAvailable(params: Readonly<{
    userId: string;
    method: string;
}>): Promise<boolean> {
    const parsed = parseMachineScopedRpcMethod(params.method);
    if (!parsed) return false;
    return await readMachineAvailabilityState({
        accountId: params.userId,
        machineId: parsed.machineId,
    }) === "available";
}

function emitMachineScopedRpcAvailability(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
    event: typeof SOCKET_RPC_EVENTS.REGISTERED | typeof SOCKET_RPC_EVENTS.UNREGISTERED;
}>): void {
    const parsed = parseMachineScopedRpcMethod(params.method);
    if (!parsed) return;
    params.io.to(buildMachineScopedSocketRoom({
        userId: params.userId,
        machineId: parsed.machineId,
    })).emit(params.event, { method: params.method });
}

async function emitMachineScopedRpcRegisteredIfAvailable(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
}>): Promise<void> {
    if (!await isMachineScopedRpcMethodAvailable(params)) return;
    emitMachineScopedRpcAvailability({
        ...params,
        event: SOCKET_RPC_EVENTS.REGISTERED,
    });
}

async function hasRegisteredRpcTargets(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
}>): Promise<boolean> {
    try {
        const targets = await params.io
            .in(buildRpcMethodRoom({ userId: params.userId, method: params.method }))
            .fetchSockets();
        return targets.length > 0;
    } catch (error) {
        log({ module: "websocket-rpc", level: "error" }, `Error checking rpc handler availability: ${error}`);
        return false;
    }
}

async function emitMachineScopedRpcUnregisteredWhenUnavailable(params: Readonly<{
    userId: string;
    io: Server;
    method: string;
}>): Promise<void> {
    if (!parseMachineScopedRpcMethod(params.method)) return;
    if (await hasRegisteredRpcTargets(params)) return;
    emitMachineScopedRpcAvailability({
        ...params,
        event: SOCKET_RPC_EVENTS.UNREGISTERED,
    });
}

async function hydrateMachineScopedRpcAvailabilityForSocket(params: Readonly<{
    userId: string;
    socket: Socket;
    io: Server;
}>): Promise<void> {
    const machineId = readMachineScopedSocketMachineId(params.socket);
    if (!machineId) return;
    const state = await readMachineAvailabilityState({
        accountId: params.userId,
        machineId,
    });
    if (state !== "available") return;

    const sockets = await params.io.in(`user:${params.userId}`).fetchSockets();
    const methods = new Set<string>();
    for (const socket of sockets) {
        for (const method of readSocketRegisteredRpcMethods(socket)) {
            const parsed = parseMachineScopedRpcMethod(method);
            if (parsed?.machineId === machineId) {
                methods.add(method);
            }
        }
    }
    for (const method of methods) {
        params.socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
    }
}

export function registerSocketRpcHandlers(params: Readonly<{
    userId: string;
    socket: Socket;
    io: Server;
    sessionPublisherPresence?: SessionPublisherPresenceForRpc;
}>): void {
    const ownedMethods = new Set<string>();
    // Caller request ids are meaningful only within this authenticated socket.
    // The relay maps them to server-minted target ids, so a caller cannot name
    // or cancel another caller's in-flight work at a shared target.
    const activeCancellations = new Map<string, ActiveSocketRpcCancellation>();

    params.socket.on(SOCKET_RPC_EVENTS.CANCEL, (data: unknown) => {
        const parsed = SocketRpcCancellationPayloadSchema.safeParse(data);
        if (!parsed.success) return;
        const active = activeCancellations.get(parsed.data.requestId);
        if (!active) return;
        cancelActiveSocketRpcCall({ io: params.io, active });
    });

    params.socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: unknown) => {
        try {
            const method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            if (!method) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Invalid method name" });
                return;
            }
            if (
                isReservedServerOriginRpcMethod(method)
                && !canRegisterReservedServerOriginRpcMethod({ socket: params.socket, method })
            ) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Forbidden" });
                return;
            }
            if (!await canRegisterSessionScopedRpcMethod({ socket: params.socket, accountId: params.userId, method })) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Forbidden" });
                return;
            }
            const machineScopedSocketMachineId = readMachineScopedSocketMachineId(params.socket);
            if (readSocketClientType(params.socket) === "machine-scoped") {
                const machineId = machineScopedSocketMachineId ?? "";
                if (!machineId || !canRegisterMachineScopedRpcMethod({
                    socketMachineId: machineId,
                    method,
                })) {
                    params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Forbidden" });
                    return;
                }
                const state = await readMachineAvailabilityState({ accountId: params.userId, machineId });
                if (state !== "available") {
                    params.socket.emit(SOCKET_RPC_EVENTS.ERROR, {
                        type: "register",
                        error: state === "replaced" ? "Machine replaced" : "Machine unavailable",
                    });
                    return;
                }
            }

            await params.socket.join(buildRpcMethodRoom({ userId: params.userId, method }));
            ownedMethods.add(method);
            writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
            recordRpcRegistration(method);
            params.socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
            if (machineScopedSocketMachineId === null) {
                await emitMachineScopedRpcRegisteredIfAvailable({
                    userId: params.userId,
                    io: params.io,
                    method,
                });
            }
        } catch (error) {
            log({ module: "websocket-rpc", level: "error" }, `Error in rpc-register: ${error}`);
            params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Internal error" });
        }
    });

    params.socket.on(SOCKET_RPC_EVENTS.UNREGISTER, async (data: unknown) => {
        try {
            const method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            if (!method) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "unregister", error: "Invalid method name" });
                return;
            }

            if (ownedMethods.has(method)) {
                ownedMethods.delete(method);
                writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
                await params.socket.leave(buildRpcMethodRoom({ userId: params.userId, method }));
                recordRpcUnregistration(method);
                await emitMachineScopedRpcUnregisteredWhenUnavailable({
                    userId: params.userId,
                    io: params.io,
                    method,
                });
            }

            params.socket.emit(SOCKET_RPC_EVENTS.UNREGISTERED, { method });
        } catch (error) {
            log({ module: "websocket-rpc", level: "error" }, `Error in rpc-unregister: ${error}`);
            params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "unregister", error: "Internal error" });
        }
    });

    params.socket.on(SOCKET_RPC_EVENTS.CALL, async (data: unknown, callback?: (response: unknown) => void) => {
        const startedAt = Date.now();
        let method: string | null = null;
        let callerRequestId: string | undefined;
        let cancellation: ActiveSocketRpcCancellation | undefined;
        try {
            const parsedRequestId = readOptionalSocketRpcRequestId(data);
            if (parsedRequestId === null) {
                callback?.({
                    ok: false,
                    error: "Invalid RPC request correlation",
                });
                return;
            }
            callerRequestId = parsedRequestId;
            if (callerRequestId) {
                if (activeCancellations.has(callerRequestId)) {
                    callback?.({
                        ok: false,
                        error: "RPC request correlation is already active",
                    });
                    return;
                }
                cancellation = {
                    controller: new AbortController(),
                    targetRequestId: `rpc_${randomUUID()}`,
                    targetSocketId: null,
                    cancelled: false,
                };
                activeCancellations.set(callerRequestId, cancellation);
            }
            method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            const callParams = (data as { params?: unknown } | undefined)?.params;
            const timeoutMs = (data as { timeoutMs?: unknown } | undefined)?.timeoutMs;
            let authorization: SocketRpcAuthorizationContext | undefined;

            if (!method) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: method is required",
                });
                return;
            }

            if (isReservedServerOriginRpcMethod(method)) {
                recordRpcCallFailure(method, "forbidden");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
                callback?.(buildForbiddenRpcResponse());
                return;
            }

            if (!await canCallSessionScopedRpcMethod({ socket: params.socket, accountId: params.userId, method })) {
                recordRpcCallFailure(method, "forbidden");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
                callback?.({
                    ok: false,
                    error: "Forbidden",
                });
                return;
            }

            if (resolveSocketRpcSessionWriteAuthorizationMethod(method)) {
                const parsedAuthorization = parseSocketRpcAuthorizationContext(
                    (data as { authorization?: unknown } | undefined)?.authorization,
                );
                if (!parsedAuthorization) {
                    recordRpcCallFailure(method, "forbidden");
                    observeRpcCall({
                        method,
                        durationMs: Date.now() - startedAt,
                        result: "error",
                    });
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                const access = await checkSessionAccess(params.userId, parsedAuthorization.sessionId);
                if (!access || !requireAccessLevel(access, "edit")) {
                    recordRpcCallFailure(method, "forbidden");
                    observeRpcCall({
                        method,
                        durationMs: Date.now() - startedAt,
                        result: "error",
                    });
                    callback?.(buildForbiddenRpcResponse());
                    return;
                }
                authorization = parsedAuthorization;
            }

            const targetResolution = await resolveRpcCallTarget({
                callerUserId: params.userId,
                method,
            });
            if (targetResolution.type === "forbidden") {
                recordRpcCallFailure(method, "forbidden");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
                callback?.({
                    ok: false,
                    error: "Forbidden",
                });
                return;
            }

            // Only resolveRpcCallTarget can mint this narrow attestation after
            // owner/share authorization. In particular, no client-supplied
            // `authorization` field is considered for permission decisions.
            if (targetResolution.permissionRespondAuthorization) {
                authorization = targetResolution.permissionRespondAuthorization;
            }

            const explicitMachineStopRequest = readExplicitMachineStopRequest(method, authorization);
            if (method.endsWith(`:${RPC_METHODS.STOP_SESSION}`) && !explicitMachineStopRequest) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: sessionId is required",
                });
                return;
            }

            let explicitMachineStopCapture: CaptureExplicitMachineStopResult | null = null;
            if (explicitMachineStopRequest) {
                const presence = params.sessionPublisherPresence;
                if (!presence) {
                    callback?.({
                        ok: false,
                        error: "Server explicit stop lifecycle owner unavailable",
                    });
                    return;
                }
                explicitMachineStopCapture = await presence.captureExplicitMachineStop({
                    binding: {
                        accountId: targetResolution.targetUserId,
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

            const targetGuard = explicitMachineStopRequest
                ? createExplicitMachineStopTargetGuard(explicitMachineStopRequest)
                : createSessionModelTransitionTargetGuard({
                    method,
                    targetUserId: targetResolution.targetUserId,
                    presence: params.sessionPublisherPresence,
                });
            const forwarded = await forwardRpcCall({
                io: params.io,
                targetUserId: targetResolution.targetUserId,
                method,
                callParams,
                timeoutMs,
                authorization,
                ...(explicitMachineStopRequest
                    ? { transportResponseEnvelopeVersion: 1 as const }
                    : {}),
                callerSocketId: params.socket.id,
                callerSocket: params.socket,
                ...(targetGuard ? { targetGuard } : {}),
                ...(cancellation
                    ? {
                        cancellation: {
                            targetRequestId: cancellation.targetRequestId,
                            signal: cancellation.controller.signal,
                            onTargetSelected: (target) => {
                                cancellation!.targetSocketId = target.id;
                            },
                        },
                    }
                    : {}),
            });
            if (
                explicitMachineStopRequest
                && explicitMachineStopCapture?.status === "captured"
                && forwarded.ok
            ) {
                const didProveStopped = (
                    forwarded.transportAcknowledgement?.kind === "session.stop"
                    && forwarded.transportAcknowledgement.status === "stopped"
                );
                if (didProveStopped) {
                    const presence = params.sessionPublisherPresence;
                    if (!presence) {
                        callback?.({
                            ok: false,
                            error: "Server explicit stop lifecycle owner unavailable",
                        });
                        return;
                    }
                    const closed = await presence.finalizeExplicitMachineStop({
                        target: explicitMachineStopCapture.target,
                    });
                    if (closed.status === "closed") {
                        await publishSessionPublisherClose({
                            sessionId: explicitMachineStopRequest.sessionId,
                            publisherAccountId: targetResolution.targetUserId,
                            closed,
                        });
                    } else if (closed.status !== "already_inactive") {
                        callback?.({
                            ok: false,
                            error: closed.status === "superseded"
                                ? "Session resumed while stop was in progress"
                                : "Session stop could not be finalized safely",
                        });
                        return;
                    }
                }
            }
            callback?.(forwarded.ok && "transportAcknowledgement" in forwarded
                ? { ok: true, result: forwarded.result }
                : forwarded);
        } catch (error) {
            if (method) {
                recordRpcCallFailure(method, "internal_error");
                observeRpcCall({
                    method,
                    durationMs: Date.now() - startedAt,
                    result: "error",
                });
            }
            callback?.({
                ok: false,
                error: error instanceof Error ? error.message : "Internal error",
            });
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

    params.socket.on("disconnect", async () => {
        for (const active of activeCancellations.values()) {
            cancelActiveSocketRpcCall({ io: params.io, active });
        }
        activeCancellations.clear();
        const methods = [...ownedMethods];
        ownedMethods.clear();
        writeSocketRegisteredRpcMethods(params.socket, ownedMethods);
        for (const method of methods) {
            recordRpcUnregistration(method);
            await Promise.resolve(params.socket.leave(buildRpcMethodRoom({ userId: params.userId, method }))).catch((error: unknown) => {
                log({ module: "websocket-rpc", level: "error" }, `Error leaving rpc room on disconnect: ${error}`);
            });
            await emitMachineScopedRpcUnregisteredWhenUnavailable({
                userId: params.userId,
                io: params.io,
                method,
            });
        }
    });

    void hydrateMachineScopedRpcAvailabilityForSocket(params).catch((error) => {
        log({ module: "websocket-rpc", level: "error" }, `Error hydrating rpc handler availability: ${error}`);
    });
}
