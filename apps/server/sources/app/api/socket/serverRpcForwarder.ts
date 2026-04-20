import type { Server } from "socket.io";

import { forwardRpcCall } from "./rpc/forwardRpcCall";

export type ServerRpcForwardResult =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

export type ForwardRpcForUser = (params: Readonly<{
    userId: string;
    method: string;
    params: unknown;
    timeoutMs?: number;
}>) => Promise<ServerRpcForwardResult>;

export function createServerRpcForwarder(params: Readonly<{
    io: Server;
}>): ForwardRpcForUser {
    return async ({ userId, method, params: callParams, timeoutMs }): Promise<ServerRpcForwardResult> => forwardRpcCall({
        io: params.io,
        targetUserId: userId,
        method,
        callParams,
        timeoutMs,
    });
}
