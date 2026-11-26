import type { Server } from "socket.io";
import {
    SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS,
    SocketRpcMachineReadServerOriginAuthorizationContextV1Schema,
} from '@happier-dev/protocol/socketRpc';

import { forwardRpcCall } from "./rpc/forwardRpcCall";
import { readWebLatencyRequestId } from "@/utils/webLatencyTrace";

export type ServerRpcForwardResult =
    | Readonly<{ ok: true; result: unknown; verifiedMachineInstallationId?: string }>
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
    return async ({ userId, method, params: callParams, timeoutMs }): Promise<ServerRpcForwardResult> => {
        const separator = method.indexOf(':');
        const authorization = separator > 0 && SOCKET_RPC_SERVER_ORIGIN_MACHINE_READ_METHODS.includes(method.slice(separator + 1))
            ? SocketRpcMachineReadServerOriginAuthorizationContextV1Schema.parse({
                kind: 'machine.read.serverOrigin', accountId: userId, machineId: method.slice(0, separator),
            })
            : undefined;
        return forwardRpcCall({
            io: params.io,
            targetUserId: userId,
            method,
            callParams,
            timeoutMs,
            // Observation only: never turn an HTTP root into cancellation custody.
            traceId: readWebLatencyRequestId(),
            ...(authorization ? { authorization } : {}),
        });
    };
}
