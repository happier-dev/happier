import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    AutomationReplyHandoffDispatchRequestV1Schema,
    AutomationReplyHandoffDispatchResultV1Schema,
    type AutomationReplyHandoffDispatchResultV1,
} from "@happier-dev/protocol";
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from "@happier-dev/protocol/rpc";
import type { Server } from "socket.io";

import { forwardRpcCall, type RpcForwardResult } from "./rpc/forwardRpcCall";
import type { RpcAckResponseEmitter, RpcForwardTargetGuard } from "./rpc/_types";

export type AutomationReplyHandoffForwardRpcCall = typeof forwardRpcCall;

function unavailable(
    code: Extract<AutomationReplyHandoffDispatchResultV1, { kind: "unavailable" }>["code"],
): AutomationReplyHandoffDispatchResultV1 {
    return { kind: "unavailable", code };
}

function isExactMachineDaemonTarget(
    target: Pick<RpcAckResponseEmitter, "data">,
    machineId: string,
): boolean {
    const data = target.data;
    return data?.clientType === "machine-scoped"
        && typeof data.machineId === "string"
        && data.machineId.trim() === machineId;
}

function createExactMachineDaemonGuard(machineId: string): RpcForwardTargetGuard {
    return {
        filterTargets: async (targets) => targets.filter((target) =>
            isExactMachineDaemonTarget(target, machineId)),
        runOperation: async ({ target, operation, readLatestTarget }) => {
            if (!isExactMachineDaemonTarget(target, machineId)) {
                return { status: "unavailable" };
            }
            const latestTarget = await readLatestTarget();
            if (!latestTarget || !isExactMachineDaemonTarget(latestTarget, machineId)) {
                return { status: "unavailable" };
            }
            return { status: "current", value: await operation() };
        },
    };
}

/**
 * Server-only bridge for the one E6 target-daemon invocation. It deliberately
 * routes strict raw envelope bytes over incumbent Socket RPC rather than a
 * public method/registry or HTTP control path. The daemon is the first owner
 * allowed to open content and construct the contributed Action input.
 */
export function createAutomationReplyHandoffDaemonDispatcher(params: Readonly<{
    io: Server;
    forwardRpc?: AutomationReplyHandoffForwardRpcCall;
}>): (raw: unknown) => Promise<AutomationReplyHandoffDispatchResultV1> {
    const forwardRpc = params.forwardRpc ?? forwardRpcCall;
    return async (raw: unknown): Promise<AutomationReplyHandoffDispatchResultV1> => {
        const request = AutomationReplyHandoffDispatchRequestV1Schema.safeParse(raw);
        if (!request.success) return unavailable("contractInvalid");

        let forwarded: RpcForwardResult;
        try {
            forwarded = await forwardRpc({
                io: params.io,
                targetUserId: request.data.target.accountId,
                method: `${request.data.target.machineId}:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`,
                callParams: request.data,
                authorization: {
                    kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.AUTOMATION_REPLY_HANDOFF_SERVER_ORIGIN,
                },
                targetGuard: createExactMachineDaemonGuard(request.data.target.machineId),
            });
        } catch {
            return unavailable("targetUnavailable");
        }
        if (!forwarded.ok) return unavailable("targetUnavailable");
        const result = AutomationReplyHandoffDispatchResultV1Schema.safeParse(forwarded.result);
        return result.success ? result.data : unavailable("contractInvalid");
    };
}
