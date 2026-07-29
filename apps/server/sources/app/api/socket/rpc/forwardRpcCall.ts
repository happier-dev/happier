import type { Server } from "socket.io";

import {
    RPC_ERROR_CODES,
    RPC_ERROR_MESSAGES,
    resolveSocketRpcProviderStartingMethod,
    type SocketRpcAuthorizationContext,
} from "@happier-dev/protocol/rpc";
import type { ClientUpgradeRequiredV1 } from "@happier-dev/protocol";
import {
    SOCKET_RPC_EVENTS,
    SocketRpcTransportResponseEnvelopeV1Schema,
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
    readSessionSyncSocketCompatibility,
    revalidateSessionSyncSocketCompatibility,
} from "@/app/clientCompatibility/socketEnforcement";
import { readMachineAvailabilityState } from "@/app/machines/machineStateGuards";
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
    | Readonly<{ ok: false; error: string; errorCode?: string }>
    | Readonly<{ ok: false } & ClientUpgradeRequiredV1>;

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
    targetGuard?: RpcForwardTargetGuard;
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

    if (resolveSocketRpcProviderStartingMethod(params.method)) {
        const targetData = selection.target.data ?? {};
        const clientType = typeof targetData.clientType === "string" ? targetData.clientType : "";
        const machineId = typeof targetData.machineId === "string" ? targetData.machineId.trim() : "";
        if (clientType === "machine-scoped" && machineId) {
            const state = await readMachineAvailabilityState({
                accountId: params.targetUserId,
                machineId,
            });
            if (state !== "available") {
                recordRpcMethodNotAvailable(params.method);
                recordRpcCallFailure(params.method, "method_not_available");
                observeRpcCall({
                    method: params.method,
                    durationMs: Date.now() - callStartedAt,
                    result: "error",
                });
                return {
                    ok: false,
                    error: RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE,
                    errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                };
            }
        }

        const compatibility = readSessionSyncSocketCompatibility({ data: targetData });
        const currentCompatibility = revalidateSessionSyncSocketCompatibility(
            compatibility?.parseResult ?? { status: "missing" },
            process.env,
            "machine-scoped",
        );
        if (!currentCompatibility.accepted && currentCompatibility.upgradeRequired) {
            recordRpcCallFailure(params.method, "request_error");
            observeRpcCall({
                method: params.method,
                durationMs: Date.now() - callStartedAt,
                result: "error",
            });
            return {
                ok: false,
                ...currentCompatibility.upgradeRequired,
            };
        }

    }

    try {
        const timeoutMs = resolveRpcForwardTimeoutMs(params.method, params.timeoutMs);
        const operation = async () => await selection.target.timeout(timeoutMs).emitWithAck(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method: params.method,
                params: params.callParams,
                timeoutMs,
                ...(params.authorization ? { authorization: params.authorization } : {}),
                ...(params.transportResponseEnvelopeVersion === 1
                    ? { transportResponseEnvelopeVersion: 1 as const }
                    : {}),
            },
        );
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
