import type { Server, Socket } from "socket.io";
import { createHash, randomUUID } from "node:crypto";
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';

import { isPlainMachineDataKeyMarker } from '@happier-dev/protocol/machines/machineStoredContent';
import { type SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { type AnyClientUpgradeRequiredV1 } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { isSocketIoAckTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { isSocketRpcActionApiServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { type SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import {
    SOCKET_RPC_EVENTS,
    SocketRpcTransportResponseEnvelopeV1Schema,
    type SocketRpcRequestPayload,
    type SessionTransferRoutingV1,
    type WorkspaceSyncSourceRoutingV1,
    type WorkspaceSyncTargetRoutingV1,
    type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceExecutionV1,
    type WorkspaceSyncSeedRoutingV1,
    type SessionActionRpcOriginV1,
    type SocketRpcTransportAcknowledgementV1,
    type SocketRpcAnsweringClientV1,
    type SocketRpcAnsweringClientCandidateV1,
} from "@happier-dev/protocol/socketRpc";

import {
    observeRpcCall,
    observeRpcTargetLookup,
    recordRpcCallFailure,
    recordRpcMethodNotAvailable,
    recordRpcSelfCallRejection,
} from "@/app/monitoring/metrics/index";
import {
    buildAccountStoredContentSocketUpgradeError,
    readAccountStoredContentCompatibilityForSocket,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    classifyMachineAvailabilityState,
} from "@/app/machines/machineStateGuards";
import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

import { waitForRpcTargetAvailability } from "./rpcAvailabilityWait";
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
import {
    resolveRpcClusterFetchTimeoutMs,
    resolveRpcMethodAvailabilityGraceMs,
    resolveRpcMethodAvailabilityPollMs,
} from "./rpcMethodAvailability";
import { classifySocketClusterFetchFailureReason, discoverRpcTargets, readMachineRpcTargetPresence } from "./rpcTargetDiscovery";
import { readSocketRoomSnapshot, subscribeToSocketRoomJoins } from '../socketRoomDiscovery';
import { readVerifiedMachineSocketInstallationIdFromSocketData } from '../machineSocketInstallationProof';
import { buildRpcMethodRoom } from './rpcMethodRoom';
import { projectRpcFailureDiagnostic } from './rpcFailureDiagnostic';
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./_types";

export type RpcForwardResult =
    | Readonly<{
        ok: true;
        result: unknown;
        answeringClientId?: string;
        answeringClientIds?: readonly string[];
        answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[];
        transportAcknowledgement?: SocketRpcTransportAcknowledgementV1;
      }>
    | Readonly<{
        ok: false;
        error: string;
        errorCode?: string;
        answeringClients?: readonly SocketRpcAnsweringClientCandidateV1[];
        failureCause?: ActionFailureCauseV1;
      }>
    | Readonly<{ ok: false } & AnyClientUpgradeRequiredV1>;

function recordMethodUnavailable(params: Readonly<{
    method: string;
    callStartedAt: number;
    targetUnavailable?: boolean;
    methodNotFound?: boolean;
}>): Extract<RpcForwardResult, { ok: false; error: string }> {
    recordRpcMethodNotAvailable(params.method);
    recordRpcCallFailure(params.method, params.targetUnavailable ? "target_unavailable" : params.methodNotFound ? "method_not_found" : "method_not_available");
    observeRpcCall({
        method: params.method,
        durationMs: Date.now() - params.callStartedAt,
        result: "error",
    });
    return {
        ok: false,
        error: params.targetUnavailable ? "RPC target unavailable" : params.methodNotFound ? RPC_ERROR_MESSAGES.METHOD_NOT_FOUND : RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: params.targetUnavailable ? "target_unavailable" : params.methodNotFound ? RPC_ERROR_CODES.METHOD_NOT_FOUND : RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
}

async function readLatestRpcTargetBySocketId(params: Readonly<{
    io: Server;
    targetSocketId: string;
    fetchTimeoutMs?: number;
}>): Promise<RpcAckResponseEmitter | null> {
    try {
        const localTarget = params.io.sockets.sockets.get(params.targetSocketId);
        if (localTarget?.connected) return localTarget;
        const snapshot = await readSocketRoomSnapshot({ io: params.io, room: params.targetSocketId,
            timeoutMs: params.fetchTimeoutMs,
            acceptPartial: async sockets => sockets.some(socket => 'id' in socket && socket.id === params.targetSocketId),
        });
        const targets = snapshot.sockets as RpcAckResponseEmitter[];
        const exactTargets = targets.filter((target) => target.id === params.targetSocketId);
        // An incomplete census cannot prove that the selected target vanished.
        if (exactTargets.length === 0 && !snapshot.complete) {
            throw snapshot.error ?? new Error('Incomplete RPC target revalidation');
        }
        return exactTargets.length === 1 ? exactTargets[0] : null;
    } catch (error) {
        log(
            { module: "websocket-rpc", level: "warn", targetSocketId: params.targetSocketId },
            `RPC target revalidation failed for ${params.targetSocketId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
    }
}

function rpcLogCorrelation(params: Readonly<{
    traceId?: string;
    callerSocketId?: string;
    cancellation?: Readonly<{ targetRequestId: string }>;
}>) {
    const targetTraceId = params.traceId ?? params.cancellation?.targetRequestId;
    return targetTraceId ? {
        // Ingress supplies a safe relay identity; HTTP roots use the existing
        // opaque-id privacy projection without changing the wire identity.
        requestId: params.callerSocketId || /^(?:rpc_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetTraceId)
            ? targetTraceId : `sha256:${createHash('sha256').update(targetTraceId).digest('hex')}`,
        ...(params.callerSocketId ? { callerSocketId: params.callerSocketId } : {}),
    } : null;
}

export async function forwardRpcCall(params: Omit<Parameters<typeof executeRpcForwardCall>[0], 'observationReconnectGraceMs' | 'retainedObservation'>): Promise<RpcForwardResult> {
    // Only retained observations are replayable. Effects keep their original
    // disconnect/unknown contract; no inbound flag can opt a write into replay.
    const observation = isRetainedObservation(params);
    const timeoutMs = resolveRpcForwardTimeoutMs(params.timeoutMs);
    const deadlineAtMs = timeoutMs === null ? null : Date.now() + timeoutMs;
    // Finite wake is already admitted before its first read. Publication may
    // still be absent after the admission ACK was lost, so that read owns the
    // original invocation's remaining lifetime too.
    let reconnecting = observation && params.method.slice(params.method.indexOf(':') + 1) === MANAGED_FINITE_WAKE_RPC_METHOD;
    let result: RpcForwardResult;
    for (;;) {
        const remainingMs = deadlineAtMs === null ? null : Math.max(0, deadlineAtMs - Date.now());
        if (observation && remainingMs === 0) {
            result = { ok: false, error: 'operation has timed out', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE };
            break;
        }
        try {
            result = await executeRpcForwardCall({ ...params, retainedObservation: observation, ...(observation ? {
                timeoutMs: remainingMs,
                ...(reconnecting ? { observationReconnectGraceMs: remainingMs } : {}),
            } : {}) });
            break;
        } catch (error) {
            if (!observation || params.cancellation?.signal.aborted
                || !(error instanceof Error) || !('code' in error) || error.code !== 'SOCKET_DISCONNECTED') throw error;
            reconnecting = true;
        }
    }
    const method = params.method.slice(params.method.indexOf(':') + 1);
    const failure = projectRpcFailureDiagnostic(params.method, result, 'rpc.forward');
    if (failure) {
        const connectedAccount = method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD || method === CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD;
        log({ module: 'websocket-rpc', event: connectedAccount ? 'connected-account-rpc-failed' : 'rpc-failed',
            ...failure, code: failure.errorCode, phase: failure.failureCause.phase,
            ...(rpcLogCorrelation(params) ?? { requestId: randomUUID() }),
        }, 'RPC failed');
    }
    return result;
}

function isRetainedObservation(params: Readonly<{ method: string; callParams: unknown; authorization?: SocketRpcAuthorizationContext }>): boolean {
    const method = params.method.slice(params.method.indexOf(':') + 1);
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT) return true;
    if (method !== MANAGED_FINITE_WAKE_RPC_METHOD
        || !isSocketRpcActionApiServerOriginAuthorizationContext(params.authorization)) return false;
    const request = ManagedFiniteWakeRequestV1Schema.safeParse(params.callParams);
    return request.success && request.data.observation !== undefined;
}

async function executeRpcForwardCall(params: Readonly<{
    io: Server;
    targetUserId: string;
    method: string;
    callParams: unknown;
    /** Existing Machine registration carrying an unchanged Session-bound encrypted decision. */
    sessionDecisionTargetMethod?: string;
    timeoutMs?: number | null;
    /** Internal replay discovery consumes the original observation's remaining lifetime. */
    observationReconnectGraceMs?: number | null;
    retainedObservation: boolean;
    authorization?: SocketRpcAuthorizationContext;
    /** Home-owned current Machine routing facts; never copied from inbound fields. */
    machineAdmission?: SocketRpcMachineAdmissionContextV1;
    receivingMachineAdmission?: SocketRpcMachineAdmissionContextV1;
    /** Exact admitted receiver when placement owns routing independently of a source context. */
    admittedMachineTarget?: Pick<SocketRpcMachineAdmissionContextV1, 'machineId' | 'custodianAccountId' | 'installationId'>;
    /** Home producer runs under the selected target guard; null leaves existing Machine routing unchanged. */
    createMachineAdmission?: (input: Readonly<{ target: RpcAckResponseEmitter }>) => Promise<SocketRpcMachineAdmissionContextV1 | null>;
    transportResponseEnvelopeVersion?: 1;
    callerSocketId?: string;
    /** Admitted App-to-App Actions may explicitly address their own registered App. */
    allowCallerTarget?: boolean;
    continuationReturn?: SocketRpcRequestPayload['continuationReturn'];
    /** Home-minted observation only, independent of cancellation/signed request identity. */
    traceId?: string;
    answeringClient?: SocketRpcAnsweringClientV1;
    callerSocket?: Pick<Socket, "data">;
    /** Trusted source continuation ceiling, never copied from inbound generic RPC fields. */
    callerAuthority?: SocketRpcRequestPayload['callerAuthority'];
    /** Trusted ingress stamp admitted by the source Machine/current Session guard. */
    sessionActionOrigin?: SessionActionRpcOriginV1;
    /** Verified credential constraints; inbound RPC fields are never authoritative. */
    callerInputConstraints?: CallerInputConstraintsV1;
    transferRouting?: SessionTransferRoutingV1;
    workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
    workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
    workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
    /** Original verified D packet, captured before the relay replaces its request correlation. */
    workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
    workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
    originalActionEnvelope?: ExternalActionRequestEnvelope;
    /** Trusted ingress producer, invoked only inside the selected target's currentness guard. */
    createCallerInputAuthorization?: (input: Readonly<{
        target: RpcAckResponseEmitter;
        requestId: string;
    }>) => Promise<ExternalActionExecutionAuthorizationV1>;
    targetGuard?: RpcForwardTargetGuard;
    /** A server-owned forward whose receiver binds work to the request: mint a fresh correlation id for it. */
    identifyRequest?: true;
    /** The admitted route's canonical presence owner distinguishes target loss from a missing method. */
    isTargetUnavailable?: () => Promise<boolean>;
    cancellation?: Readonly<{
        /** Server-minted correlation that is safe to expose to the exact target. */
        targetRequestId: string;
        signal: AbortSignal;
        /** Retain a cooperative caller's result until disconnect or the existing ACK deadline. */
        ackSignal?: AbortSignal;
        /** Records the selected target before its request is emitted. */
        onTargetSelected: (target: RpcAckResponseEmitter) => void;
    }>;
    /**
     * Internal classification for callers that own an idempotent creation key.
     * The normal Socket-RPC result remains backward-compatible.
     */
    onSubmittedUnknown?: () => void;
    /** Accepted wake discovery consumes the original invocation's budget and currentness. */
    callerLifetime?: Parameters<typeof waitForRpcTargetAvailability>[0]['callerLifetime'];
}>): Promise<RpcForwardResult> {
    const callStartedAt = Date.now();
    const lookupStartedAt = Date.now();
    const correlation = rpcLogCorrelation(params);
    let methodRegistrationAbsent = false;
    let discoveryFailure: ActionFailureCauseV1 | undefined;
    // An admitted Machine's post-firewall observation must travel through Home
    // and ACK on its own registered daemon. Keep ordinary self-calls excluded;
    // this exact read still consumes the existing admission and target guard.
    const excludedSocketId = params.allowCallerTarget || params.machineAdmission
        && params.method === `${params.machineAdmission.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`
        ? undefined : params.callerSocketId;
    const selection = await waitForRpcTargetAvailability({
        graceMs: params.observationReconnectGraceMs !== undefined
            ? params.observationReconnectGraceMs : resolveRpcMethodAvailabilityGraceMs(params.method),
        pollMs: resolveRpcMethodAvailabilityPollMs(),
        subscribeToAvailability: listener => subscribeToSocketRoomJoins(params.io, buildRpcMethodRoom({
            userId: params.targetUserId, method: params.sessionDecisionTargetMethod ?? params.method,
        }), listener),
        signal: params.cancellation?.signal ?? params.callerLifetime?.signal,
        excludedSocketId,
        answeringClient: params.answeringClient,
        ...(params.callerLifetime && params.observationReconnectGraceMs === undefined ? { callerLifetime: params.callerLifetime } : {}),
        discoverTargets: async () => {
            const discovery = await discoverRpcTargets({
                io: params.io,
                userId: params.targetUserId,
                method: params.sessionDecisionTargetMethod ?? params.method,
                fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
                excludedSocketId,
                answeringClient: params.answeringClient,
                targetGuard: params.targetGuard,
                ...(correlation ? { correlation } : {}),
            });
            discoveryFailure = discovery.failureCause;
            methodRegistrationAbsent = discovery?.methodRoomEmpty === true;
            return discovery?.targets ?? [];
        },
    });
    if (correlation) log({ module: 'websocket-rpc', event: 'rpc-target-lookup', ...correlation,
        method: params.method, status: selection.type, discoveryFailed: discoveryFailure !== undefined,
        ...(selection.type === 'target' ? { targetSocketId: selection.target.id } : {}),
        durationMs: Date.now() - lookupStartedAt,
    }, 'RPC target lookup completed');
    observeRpcTargetLookup({
        method: params.method,
        durationMs: Date.now() - lookupStartedAt,
        result: selection.type === "not-available" ? "miss" : "resolved",
    });

    if (selection.type === 'ambiguous') {
        recordRpcCallFailure(params.method, 'request_error');
        observeRpcCall({ method: params.method, durationMs: Date.now() - callStartedAt, result: 'error' });
        return { ok: false, error: 'Pass clientId to choose an exact answering client', errorCode: RPC_ERROR_CODES.CLIENT_AMBIGUOUS,
            answeringClients: selection.clients };
    }

    if (selection.type === "self-call") {
        recordRpcSelfCallRejection(params.method);
        recordRpcCallFailure(params.method, "self_call");
        observeRpcCall({
            method: params.method,
            durationMs: Date.now() - callStartedAt,
            result: "error",
        });
        return {
            ok: false,
            error: "Cannot call RPC on the same socket",
        };
    }

    if (selection.type === "not-available") {
        if (params.observationReconnectGraceMs !== undefined && params.observationReconnectGraceMs !== null
            && !params.cancellation?.signal.aborted && Date.now() - callStartedAt >= params.observationReconnectGraceMs) {
            return { ok: false, error: 'operation has timed out', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE };
        }
        if (discoveryFailure) {
            recordRpcCallFailure(params.method, 'request_error');
            observeRpcCall({ method: params.method, durationMs: Date.now() - callStartedAt, result: 'error' });
            return { ok: false, error: 'RPC target discovery unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                failureCause: discoveryFailure };
        }
        if (params.answeringClient) return { ok: false, error: 'Answering client unavailable', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
        const presence = params.isTargetUnavailable ? null : await readMachineRpcTargetPresence({
            io: params.io,
            userId: params.targetUserId,
            method: params.sessionDecisionTargetMethod ?? params.method,
            fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
            machineAdmission: params.receivingMachineAdmission ?? params.machineAdmission,
        });
        return recordMethodUnavailable({
            method: params.method,
            callStartedAt,
            targetUnavailable: params.isTargetUnavailable ? await params.isTargetUnavailable() : presence === 'disconnected',
            // A failed census, guard rejection or cancelled wake is not method absence.
            methodNotFound: methodRegistrationAbsent && presence === 'method-absent' && !params.callerLifetime,
        });
    }

    if (selection.hadMultipleTargets) {
        log(
            { module: "websocket-rpc", level: "warn", targetUserId: params.targetUserId, method: params.method },
            `Multiple sockets were eligible for ${params.method}; using ${selection.target.id}`,
        );
    }

    const targetData = selection.target.data ?? {};
    const targetClientType =
        typeof targetData.clientType === "string"
            ? targetData.clientType
            : "";
    const targetMachineId =
        typeof targetData.machineId === "string"
            ? targetData.machineId.trim()
            : "";
    const admission = params.receivingMachineAdmission ?? params.machineAdmission;
    const admittedTarget = admission?.machineId === targetMachineId
        && admission.custodianAccountId === params.targetUserId ? admission : null;
    const exactTarget = params.admittedMachineTarget ?? admittedTarget;
    if (exactTarget && (targetClientType !== 'machine-scoped'
        || targetMachineId !== exactTarget.machineId || params.targetUserId !== exactTarget.custodianAccountId
        || readVerifiedMachineSocketInstallationIdFromSocketData(targetData) !== exactTarget.installationId)) {
        return recordMethodUnavailable({ method: params.method, callStartedAt });
    }
    if (targetClientType === "machine-scoped" && targetMachineId) {
        // The request admission already decided lifecycle and content mode.
        // Legacy callers and physically different receivers retain their own read.
        const machine = admittedTarget ? null : await db.machine.findFirst({
            where: {
                accountId: params.targetUserId,
                id: targetMachineId,
            },
            select: {
                dataEncryptionKey: true,
                revokedAt: true,
                replacedByMachineId: true,
            },
        });
        if (!admittedTarget && classifyMachineAvailabilityState(machine) !== "available") {
            return recordMethodUnavailable({
                method: params.method,
                callStartedAt,
                targetUnavailable: true,
            });
        }
        if (admittedTarget ? admittedTarget.encryptionMode === 'plain' : isPlainMachineDataKeyMarker(machine?.dataEncryptionKey)) {
            const callerCompatibility = params.callerSocket
                ? readAccountStoredContentCompatibilityForSocket(
                    params.callerSocket,
                )
                : null;
            const targetCompatibility =
                readAccountStoredContentCompatibilityForSocket(
                    selection.target,
                );
            const blockingCompatibility =
                callerCompatibility
                && !callerCompatibility.supportsCurrentProtocol
                    ? callerCompatibility
                    : !targetCompatibility.supportsCurrentProtocol
                        ? targetCompatibility
                        : null;
            if (blockingCompatibility) {
                recordRpcCallFailure(params.method, "request_error");
                observeRpcCall({
                    method: params.method,
                    durationMs: Date.now() - callStartedAt,
                    result: "error",
                });
                return {
                    ok: false,
                    ...buildAccountStoredContentSocketUpgradeError(
                        blockingCompatibility,
                    ).data,
                };
            }
        }
    }

    let requestSubmitted = false;
    let targetRevalidationFailure: ActionFailureCauseV1 | undefined;
    try {
        if (params.cancellation?.signal.aborted) {
            throw new Error("RPC request cancelled by caller");
        }
        const requestedTimeoutMs = resolveRpcForwardTimeoutMs(params.timeoutMs);
        const timeoutMs = params.retainedObservation
            && requestedTimeoutMs !== null ? Math.max(0, requestedTimeoutMs - (Date.now() - callStartedAt)) : requestedTimeoutMs;
        if (params.retainedObservation && timeoutMs === 0) {
            return { ok: false, error: 'operation has timed out', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE };
        }
        const targetRequestId = params.cancellation?.targetRequestId
            ?? (params.createCallerInputAuthorization || params.identifyRequest ? `rpc_${randomUUID()}` : undefined);
        const request: SocketRpcRequestPayload = {
            method: params.method,
            params: params.callParams,
            callerAuthority: params.callerAuthority ?? (!params.sessionActionOrigin && params.callerSocket?.data?.authAuthority === "present_user"
                ? "present_user"
                : "account_automation"),
            ...(params.sessionActionOrigin ? { sessionActionOrigin: params.sessionActionOrigin } : {}),
            ...(params.callerInputConstraints ? { callerInputConstraints: params.callerInputConstraints } : {}),
            ...(params.transferRouting ? { transferRouting: params.transferRouting } : {}),
            ...(params.workspaceSyncSourceRouting ? { workspaceSyncSourceRouting: params.workspaceSyncSourceRouting } : {}),
            ...(params.workspaceSyncTargetRouting ? { workspaceSyncTargetRouting: params.workspaceSyncTargetRouting } : {}),
            ...(params.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: params.workspaceSyncSourceWriterTargetRouting } : {}),
            ...(params.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: params.workspaceSyncSourceExecution } : {}),
            ...(params.workspaceSyncSeedRouting ? { workspaceSyncSeedRouting: params.workspaceSyncSeedRouting } : {}),
            ...(params.originalActionEnvelope ? { originalActionEnvelope: params.originalActionEnvelope } : {}),
            timeoutMs,
            ...(targetRequestId ? { requestId: targetRequestId } : {}),
            ...(params.continuationReturn ? { continuation: true as const, continuationReturn: params.continuationReturn } : {}),
            ...(params.cancellation?.ackSignal ? { waitForResultOnCancel: true } : {}),
            ...(params.traceId ? { traceId: params.traceId } : {}),
            ...(params.authorization ? { authorization: params.authorization } : {}),
            ...(params.machineAdmission ? { machineAdmission: params.machineAdmission } : {}),
            ...(params.receivingMachineAdmission ? { receivingMachineAdmission: params.receivingMachineAdmission } : {}),
            ...(params.transportResponseEnvelopeVersion === 1
                ? { transportResponseEnvelopeVersion: 1 as const }
                : {}),
        };
        const operation = async () => {
            if (params.cancellation?.signal.aborted) {
                throw new Error("RPC request cancelled by caller");
            }
            params.cancellation?.onTargetSelected(selection.target);
            if (params.cancellation?.signal.aborted) {
                throw new Error("RPC request cancelled by caller");
            }
            // Socket.IO 4.8.3 cluster ACKs call Node setTimeout directly. Keep
            // its real 2^31-1 ms adapter boundary separate from the authored
            // deadline, which is forwarded verbatim to the target owner.
            const callerInputAuthorization = params.createCallerInputAuthorization && targetRequestId
                ? await params.createCallerInputAuthorization({ target: selection.target, requestId: targetRequestId })
                : null;
            const machineAdmission = await params.createMachineAdmission?.({ target: selection.target });
            if (params.cancellation?.signal.aborted) throw new Error("RPC request cancelled by caller");
            // Socket.IO's local Socket stores emit flags on the socket itself,
            // so configure the ACK immediately before dispatch, after async auth.
            // Default cancellation retires ACK custody. Cooperative callers
            // retain their own result until disconnect or the existing deadline.
            const targetEmitter = selection.target.timeout(Math.min(timeoutMs ?? 2_147_483_647, 2_147_483_647), {
                rejectOnDisconnect: true,
                ...(params.cancellation ? { signal: params.cancellation.ackSignal ?? params.cancellation.signal } : {}),
            });
            requestSubmitted = true;
            const response = targetEmitter.emitWithAck(
                SOCKET_RPC_EVENTS.REQUEST,
                callerInputAuthorization || machineAdmission ? {
                    ...request,
                    ...(machineAdmission ? { machineAdmission } : {}),
                    ...(callerInputAuthorization ? { callerInputAuthorization } : {}),
                    ...(callerInputAuthorization && 'grant' in callerInputAuthorization.binding ? { callerInputConstraints: {
                        models: callerInputAuthorization.binding.grant.models,
                        permissionModes: callerInputAuthorization.binding.grant.permissionModes,
                    } } : {}),
                } : request,
            );
            // An emit invocation is not proof of a wire write or target execution.
            // Keep its exact target correlation separate from native ACK settlement.
            if (correlation) log({ module: 'websocket-rpc', event: 'rpc-target-issued', ...correlation,
                method: params.method, targetSocketId: selection.target.id, boundary: 'emitWithAck-returned',
            }, 'RPC target emit invoked');
            try {
                const value = await response;
                if (correlation) log({ module: 'websocket-rpc', event: 'rpc-target-ack', ...correlation,
                    method: params.method, targetSocketId: selection.target.id, status: 'received',
                }, 'RPC target ACK received');
                return value;
            } catch (error) {
                if (correlation) log({ module: 'websocket-rpc', event: 'rpc-target-ack', ...correlation,
                    method: params.method, targetSocketId: selection.target.id, status: 'failed',
                    failure: params.cancellation?.signal.aborted ? 'cancelled'
                        : error instanceof Error && 'code' in error && error.code === 'SOCKET_DISCONNECTED' ? 'disconnected'
                        : isSocketIoAckTimeoutError(error) ? 'timeout' : 'request_error',
                }, 'RPC target ACK failed');
                throw error;
            }
        };
        const guarded = params.targetGuard
            ? await params.targetGuard.runOperation({
                target: selection.target,
                operation,
                readLatestTarget: async () => {
                    try {
                        return await readLatestRpcTargetBySocketId({
                            io: params.io,
                            targetSocketId: selection.target.id,
                            fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
                        });
                    } catch (error) {
                        targetRevalidationFailure = projectActionFailureCauseV1(classifySocketClusterFetchFailureReason(error) === 'timeout'
                            ? Object.assign(new Error('RPC target revalidation timeout'), { code: 'ETIMEDOUT' }) : error,
                        'rpc.target.revalidation');
                        throw error;
                    }
                },
            })
            : { status: "current" as const, value: await operation() };
        if (guarded.status === "refused") {
            // The guard proved a typed refusal, not an absent target: answer with
            // its exact envelope so the caller keeps the stated recovery.
            if (requestSubmitted) params.onSubmittedUnknown?.();
            recordRpcCallFailure(params.method, "forbidden");
            observeRpcCall({
                method: params.method,
                durationMs: Date.now() - callStartedAt,
                result: "error",
            });
            return guarded.response;
        }
        if (guarded.status === "unavailable") {
            if (requestSubmitted) {
                params.onSubmittedUnknown?.();
                recordRpcCallFailure(params.method, "request_error");
                observeRpcCall({
                    method: params.method,
                    durationMs: Date.now() - callStartedAt,
                    result: "error",
                });
                return { ok: false, error: "RPC target changed after request submission", errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN };
            }
            return recordMethodUnavailable({
                method: params.method,
                callStartedAt,
            });
        }
        const response = guarded.value;
        observeRpcCall({
            method: params.method,
            durationMs: Date.now() - callStartedAt,
            result: "ok",
        });
        const envelope = SocketRpcTransportResponseEnvelopeV1Schema.safeParse(response);
        return {
            ok: true,
            result: envelope.success ? envelope.data.result : response,
            ...(params.answeringClient ? { answeringClientId: selection.target.id } : {}),
            ...(selection.clientIds ? { answeringClientIds: selection.clientIds, answeringClients: selection.clients } : {}),
            ...(envelope.success && envelope.data.acknowledgement
                ? { transportAcknowledgement: envelope.data.acknowledgement }
                : {}),
        };
    } catch (error) {
        if (params.retainedObservation
            && !params.cancellation?.signal.aborted
            && error instanceof Error && 'code' in error && error.code === 'SOCKET_DISCONNECTED') throw error;
        if (requestSubmitted) params.onSubmittedUnknown?.();
        recordRpcCallFailure(params.method, "request_error");
        observeRpcCall({
            method: params.method,
            durationMs: Date.now() - callStartedAt,
            result: "error",
        });
        const result: RpcForwardResult = {
            ok: false,
            ...(requestSubmitted && params.cancellation?.signal.aborted
                ? { error: 'RPC request cancelled after request submission', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN }
                : !requestSubmitted && targetRevalidationFailure
                ? { error: 'RPC target revalidation unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                    failureCause: targetRevalidationFailure }
                : error instanceof Error && 'code' in error && error.code === 'SOCKET_DISCONNECTED'
                ? { error: 'RPC target disconnected after request submission', errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN }
                : params.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`)
                ? { error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed' }
                : !requestSubmitted && error instanceof Error && 'code' in error && error.code === RPC_ERROR_CODES.FORBIDDEN
                ? { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN }
                : !requestSubmitted && error instanceof Error && 'code' in error && error.code === 'agent_isolation_unavailable'
                ? { error: error.message, errorCode: error.code,
                    failureCause: projectActionFailureCauseV1(error, 'rpc.forward.requester_execution') }
                : isSocketIoAckTimeoutError(error)
                ? { error: error.message, errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE }
                : { error: error instanceof Error ? error.message : "RPC call failed" }),
        };
        // Keep transport JSON unchanged; the existing outer failure logger consumes this host-only cause.
        return result.errorCode === undefined || result.errorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN
            || result.errorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE
            ? withActionFailureCauseDiagnostic(result, {
                failureCause: projectActionFailureCauseV1(error, 'rpc.forward', { allowUnknownErrorCode: false }),
            }, 'rpc.forward')
            : result;
    }
}
