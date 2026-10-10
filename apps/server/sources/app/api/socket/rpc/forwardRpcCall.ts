import type { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import type { CallerInputConstraintsV1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import type { ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope } from "@happier-dev/protocol/actions";

import {
    isPlainMachineDataKeyMarker,
    type SocketRpcMachineAdmissionContextV1,
    type AnyClientUpgradeRequiredV1,
} from "@happier-dev/protocol";
import {
    RPC_ERROR_CODES,
    RPC_METHODS,
    RPC_ERROR_MESSAGES,
    type SocketRpcAuthorizationContext,
} from "@happier-dev/protocol/rpc";
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
import {
    isRpcForwardCallerLifecycleOwned,
    resolveRpcForwardTimeoutMs,
} from "./rpcForwardTimeout";
import {
    resolveRpcClusterFetchTimeoutMs,
    resolveRpcMethodAvailabilityGraceMs,
    resolveRpcMethodAvailabilityPollMs,
} from "./rpcMethodAvailability";
import { discoverRpcTargets } from "./rpcTargetDiscovery";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./_types";

export type RpcForwardResult =
    | Readonly<{
        ok: true;
        result: unknown;
        transportAcknowledgement?: SocketRpcTransportAcknowledgementV1;
      }>
    | Readonly<{
        ok: false;
        error: string;
        errorCode?: string;
      }>
    | Readonly<{ ok: false } & AnyClientUpgradeRequiredV1>;

function recordMethodUnavailable(params: Readonly<{
    method: string;
    callStartedAt: number;
}>): Extract<RpcForwardResult, { ok: false; error: string }> {
    recordRpcMethodNotAvailable(params.method);
    recordRpcCallFailure(params.method, "method_not_available");
    observeRpcCall({
        method: params.method,
        durationMs: Date.now() - params.callStartedAt,
        result: "error",
    });
    return {
        ok: false,
        error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
}

async function readLatestRpcTargetBySocketId(params: Readonly<{
    io: Server;
    targetSocketId: string;
    fetchTimeoutMs?: number;
}>): Promise<RpcAckResponseEmitter | null> {
    try {
        const targetRoom = params.io.in(params.targetSocketId);
        const targets = typeof params.fetchTimeoutMs === "number" && params.fetchTimeoutMs > 0
            ? await targetRoom.timeout(params.fetchTimeoutMs).fetchSockets() as RpcAckResponseEmitter[]
            : await targetRoom.fetchSockets() as RpcAckResponseEmitter[];
        const exactTargets = targets.filter((target) => target.id === params.targetSocketId);
        return exactTargets.length === 1 ? exactTargets[0] : null;
    } catch (error) {
        log(
            { module: "websocket-rpc", level: "warn", targetSocketId: params.targetSocketId },
            `RPC target revalidation failed for ${params.targetSocketId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
    }
}

export async function forwardRpcCall(params: Readonly<{
    io: Server;
    targetUserId: string;
    method: string;
    callParams: unknown;
    timeoutMs?: unknown;
    authorization?: SocketRpcAuthorizationContext;
    /** Home-owned current Machine routing facts; never copied from inbound fields. */
    machineAdmission?: SocketRpcMachineAdmissionContextV1;
    transportResponseEnvelopeVersion?: 1;
    callerSocketId?: string;
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
    cancellation?: Readonly<{
        /** Server-minted correlation that is safe to expose to the exact target. */
        targetRequestId: string;
        signal: AbortSignal;
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
    const selection = await waitForRpcTargetAvailability({
        graceMs: resolveRpcMethodAvailabilityGraceMs(params.method),
        pollMs: resolveRpcMethodAvailabilityPollMs(),
        excludedSocketId: params.callerSocketId,
        ...(params.callerLifetime ? { callerLifetime: params.callerLifetime } : {}),
        discoverTargets: async () => {
            const targets = await discoverRpcTargets({
                io: params.io,
                userId: params.targetUserId,
                method: params.method,
                fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
            });
            return params.targetGuard
                ? await params.targetGuard.filterTargets(targets)
                : targets;
        },
    });
    observeRpcTargetLookup({
        method: params.method,
        durationMs: Date.now() - lookupStartedAt,
        result: selection.type === "not-available" ? "miss" : "resolved",
    });

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
        return recordMethodUnavailable({
            method: params.method,
            callStartedAt,
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
    if (targetClientType === "machine-scoped" && targetMachineId) {
        const machine = await db.machine.findFirst({
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
        if (classifyMachineAvailabilityState(machine) !== "available") {
            return recordMethodUnavailable({
                method: params.method,
                callStartedAt,
            });
        }
        if (isPlainMachineDataKeyMarker(machine?.dataEncryptionKey)) {
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
    try {
        if (params.cancellation?.signal.aborted) {
            throw new Error("RPC request cancelled by caller");
        }
        const timeoutMs = resolveRpcForwardTimeoutMs(params.method, params.timeoutMs);
        const targetRequestId = params.cancellation?.targetRequestId
            ?? (params.createCallerInputAuthorization ? `rpc_${randomUUID()}` : undefined);
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
            ...(params.authorization ? { authorization: params.authorization } : {}),
            ...(params.machineAdmission ? { machineAdmission: params.machineAdmission } : {}),
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
            const targetEmitter = selection.target.timeout(timeoutMs);
            const callerInputAuthorization = params.createCallerInputAuthorization && targetRequestId
                ? await params.createCallerInputAuthorization({ target: selection.target, requestId: targetRequestId })
                : null;
            if (params.cancellation?.signal.aborted) throw new Error("RPC request cancelled by caller");
            requestSubmitted = true;
            const response = targetEmitter.emitWithAck(
                SOCKET_RPC_EVENTS.REQUEST,
                callerInputAuthorization ? {
                    ...request,
                    callerInputAuthorization,
                    ...('grant' in callerInputAuthorization.binding ? { callerInputConstraints: {
                        models: callerInputAuthorization.binding.grant.models,
                        permissionModes: callerInputAuthorization.binding.grant.permissionModes,
                    } } : {}),
                } : request,
            );
            const cancellationSignal = params.cancellation?.signal;
            // Caller-lifecycle operations forward cancellation to their exact
            // target and let that owner return the correlated terminal result.
            // Ending the relay locally after submission would discard a V2
            // Action's authenticated cancellation/outcome-unknown response.
            if (!cancellationSignal || isRpcForwardCallerLifecycleOwned(params.method)) {
                return await response;
            }

            let removeAbortListener: (() => void) | undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
                const onAbort = (): void => {
                    reject(new Error('RPC request cancelled by caller'));
                };
                cancellationSignal.addEventListener('abort', onAbort, { once: true });
                removeAbortListener = () => {
                    cancellationSignal.removeEventListener('abort', onAbort);
                };
                if (cancellationSignal.aborted) onAbort();
            });

            try {
                return await Promise.race([response, aborted]);
            } finally {
                removeAbortListener?.();
            }
        };
        const guarded = params.targetGuard
            ? await params.targetGuard.runOperation({
                target: selection.target,
                operation,
                readLatestTarget: async () => await readLatestRpcTargetBySocketId({
                    io: params.io,
                    targetSocketId: selection.target.id,
                    fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
                }),
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
                return recordMethodUnavailable({
                    method: params.method,
                    callStartedAt,
                });
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
            ...(envelope.success && envelope.data.acknowledgement
                ? { transportAcknowledgement: envelope.data.acknowledgement }
                : {}),
        };
    } catch (error) {
        if (requestSubmitted) params.onSubmittedUnknown?.();
        recordRpcCallFailure(params.method, "request_error");
        observeRpcCall({
            method: params.method,
            durationMs: Date.now() - callStartedAt,
            result: "error",
        });
        return {
            ok: false,
            ...(params.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`)
                ? { error: 'confidential_continuation_failed', errorCode: 'confidential_continuation_failed' }
                : { error: error instanceof Error ? error.message : "RPC call failed" }),
        };
    }
}
