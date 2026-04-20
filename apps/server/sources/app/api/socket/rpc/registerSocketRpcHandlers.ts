import type { Server, Socket } from "socket.io";

import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { observeRpcCall, recordRpcCallFailure, recordRpcRegistration, recordRpcUnregistration } from "@/app/monitoring/metrics/index";
import { log } from "@/utils/logging/log";

import { canRegisterSessionScopedRpcMethod } from "../sessionScopedBinding";
import { forwardRpcCall } from "./forwardRpcCall";
import { buildRpcMethodRoom } from "./rpcMethodRoom";
import { resolveRpcCallTarget } from "./resolveRpcCallTarget";

const MAX_RPC_METHOD_NAME_LENGTH = 512;

function normalizeRpcMethodName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_RPC_METHOD_NAME_LENGTH) return null;
    return trimmed;
}

export function registerSocketRpcHandlers(params: Readonly<{
    userId: string;
    socket: Socket;
    io: Server;
}>): void {
    const ownedMethods = new Set<string>();

    params.socket.on(SOCKET_RPC_EVENTS.REGISTER, async (data: unknown) => {
        try {
            const method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            if (!method) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Invalid method name" });
                return;
            }
            if (!canRegisterSessionScopedRpcMethod({ socket: params.socket, method })) {
                params.socket.emit(SOCKET_RPC_EVENTS.ERROR, { type: "register", error: "Forbidden" });
                return;
            }

            await params.socket.join(buildRpcMethodRoom({ userId: params.userId, method }));
            ownedMethods.add(method);
            recordRpcRegistration(method);
            params.socket.emit(SOCKET_RPC_EVENTS.REGISTERED, { method });
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
                await params.socket.leave(buildRpcMethodRoom({ userId: params.userId, method }));
                recordRpcUnregistration(method);
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
        try {
            method = normalizeRpcMethodName((data as { method?: unknown } | undefined)?.method);
            const callParams = (data as { params?: unknown } | undefined)?.params;
            const timeoutMs = (data as { timeoutMs?: unknown } | undefined)?.timeoutMs;

            if (!method) {
                callback?.({
                    ok: false,
                    error: "Invalid parameters: method is required",
                });
                return;
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

            callback?.(await forwardRpcCall({
                io: params.io,
                targetUserId: targetResolution.targetUserId,
                method,
                callParams,
                timeoutMs,
                callerSocketId: params.socket.id,
            }));
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
        }
    });

    params.socket.on("disconnect", () => {
        for (const method of ownedMethods) {
            recordRpcUnregistration(method);
            void params.socket.leave(buildRpcMethodRoom({ userId: params.userId, method }));
        }
        ownedMethods.clear();
    });
}
