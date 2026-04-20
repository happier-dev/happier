import type { Server } from "socket.io";

import { recordSocketClusterFetchSockets } from "@/app/monitoring/metrics/index";
import { log } from "@/utils/logging/log";

import type { RpcAckResponseEmitter } from "./_types";
import { buildRpcMethodRoom } from "./rpcMethodRoom";

function classifySocketClusterFetchFailureReason(error: unknown): "timeout" | "transport" | "unknown" {
    if (!(error instanceof Error)) {
        return "unknown";
    }
    const message = error.message.toLowerCase();
    return message.includes("timeout") ? "timeout" : "unknown";
}

export async function discoverRpcTargets(params: Readonly<{
    io: Server;
    userId: string;
    method: string;
    fetchTimeoutMs?: number;
}>): Promise<RpcAckResponseEmitter[]> {
    const room = buildRpcMethodRoom({
        userId: params.userId,
        method: params.method,
    });
    const startedAt = Date.now();

    try {
        const targets = typeof params.fetchTimeoutMs === "number" && params.fetchTimeoutMs > 0
            ? await params.io.in(room).timeout(params.fetchTimeoutMs).fetchSockets() as RpcAckResponseEmitter[]
            : await params.io.in(room).fetchSockets() as RpcAckResponseEmitter[];
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "ok",
        });
        return targets;
    } catch (error) {
        recordSocketClusterFetchSockets({
            durationMs: Date.now() - startedAt,
            result: "error",
            reason: classifySocketClusterFetchFailureReason(error),
        });
        log(
            { module: "websocket-rpc", level: "warn", room },
            `RPC target discovery failed for ${room}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}
