import type { Server } from "socket.io";

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import {
    observeRpcCall,
    observeRpcTargetLookup,
    recordRpcCallFailure,
    recordRpcMethodNotAvailable,
    recordRpcSelfCallRejection,
} from "@/app/monitoring/metrics/index";
import { log } from "@/utils/logging/log";

import { waitForRpcTargetAvailability } from "./rpcAvailabilityWait";
import { resolveRpcForwardTimeoutMs } from "./rpcForwardTimeout";
import {
    resolveRpcClusterFetchTimeoutMs,
    resolveRpcMethodAvailabilityGraceMs,
    resolveRpcMethodAvailabilityPollMs,
} from "./rpcMethodAvailability";
import { discoverRpcTargets } from "./rpcTargetDiscovery";

export type RpcForwardResult =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export async function forwardRpcCall(params: Readonly<{
    io: Server;
    targetUserId: string;
    method: string;
    callParams: unknown;
    timeoutMs?: unknown;
    callerSocketId?: string;
}>): Promise<RpcForwardResult> {
    const callStartedAt = Date.now();
    const lookupStartedAt = Date.now();
    const selection = await waitForRpcTargetAvailability({
        graceMs: resolveRpcMethodAvailabilityGraceMs(params.method),
        pollMs: resolveRpcMethodAvailabilityPollMs(),
            excludedSocketId: params.callerSocketId,
            discoverTargets: async () => discoverRpcTargets({
                io: params.io,
                userId: params.targetUserId,
                method: params.method,
                fetchTimeoutMs: resolveRpcClusterFetchTimeoutMs(params.method),
            }),
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

    if (selection.hadMultipleTargets) {
        log(
            { module: "websocket-rpc", level: "warn", targetUserId: params.targetUserId, method: params.method },
            `Multiple sockets were eligible for ${params.method}; using ${selection.target.id}`,
        );
    }

    try {
        const response = await selection.target.timeout(resolveRpcForwardTimeoutMs(params.method, params.timeoutMs)).emitWithAck(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method: params.method,
                params: params.callParams,
            },
        );
        observeRpcCall({
            method: params.method,
            durationMs: Date.now() - callStartedAt,
            result: "ok",
        });
        return {
            ok: true,
            result: response,
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
