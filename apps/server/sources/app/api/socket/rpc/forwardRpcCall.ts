import type { Server, Socket } from "socket.io";

import {
    isPlainMachineDataKeyMarker,
    type AnyClientUpgradeRequiredV1,
} from "@happier-dev/protocol";
import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    type SocketRpcAuthorizationContext,
} from "@happier-dev/protocol/rpc";
import {
    SOCKET_RPC_EVENTS,
    SocketRpcTransportResponseEnvelopeV1Schema,
    type SocketRpcRequestPayload,
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
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
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
    transportResponseEnvelopeVersion?: 1;
    callerSocketId?: string;
    callerSocket?: Pick<Socket, "data">;
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
}>): Promise<RpcForwardResult> {
    const callStartedAt = Date.now();
    const lookupStartedAt = Date.now();
    const selection = await waitForRpcTargetAvailability({
        graceMs: resolveRpcMethodAvailabilityGraceMs(params.method),
        pollMs: resolveRpcMethodAvailabilityPollMs(),
        excludedSocketId: params.callerSocketId,
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
        const request: SocketRpcRequestPayload = {
            method: params.method,
            params: params.callParams,
            timeoutMs,
            ...(params.cancellation ? { requestId: params.cancellation.targetRequestId } : {}),
            ...(params.authorization ? { authorization: params.authorization } : {}),
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
            requestSubmitted = true;
            const response = targetEmitter.emitWithAck(
                SOCKET_RPC_EVENTS.REQUEST,
                request,
            );
            const cancellationSignal = params.cancellation?.signal;
            if (!cancellationSignal) return await response;

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
            error: error instanceof Error ? error.message : "RPC call failed",
        };
    }
}
