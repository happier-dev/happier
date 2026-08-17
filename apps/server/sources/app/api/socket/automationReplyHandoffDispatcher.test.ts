import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1,
} from "@happier-dev/protocol";
import type { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";

import type { RpcAckResponseEmitter } from "./rpc/_types";
import {
    createAutomationReplyHandoffDaemonDispatcher,
    type AutomationReplyHandoffForwardRpcCall,
} from "./automationReplyHandoffDispatcher";

const correspondence = {
    accountId: "account-1",
    automationId: "automation-1",
    runId: "run-1",
    handoffId: "handoff-1",
} as const;

const request = {
    v: 1,
    kind: "automation.replyHandoff.dispatch",
    target: {
        accountId: "account-1",
        machineId: "machine-1",
        machineInstallationId: "installation-1",
        materializationId: "materialization-1",
        actionRef: AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1,
    },
    handoff: {
        handoffId: correspondence.handoffId,
        runId: correspondence.runId,
        automationId: correspondence.automationId,
        accountCurrentness: { mode: "plain", version: 7, contentKeyFingerprint: null },
        resultEnvelope: {
            t: "plain",
            v: {
                v: 1,
                correspondence,
                result: { v: 1, kind: "text", text: "Completed." },
            },
        },
        replyContextEnvelope: {
            t: "plain",
            v: {
                v: 1,
                correspondence,
                source: {
                    kind: "automationResult",
                    automationRunId: correspondence.runId,
                    resultId: correspondence.handoffId,
                    automationId: correspondence.automationId,
                    templateVersion: 1,
                    resultDelivery: "finalResult",
                },
                opaqueContext: { conversationId: "conversation-1", messageId: "message-1" },
            },
        },
    },
} as const;

function createTarget(params: Readonly<{
    id: string;
    clientType: string;
    machineId: string;
}>): RpcAckResponseEmitter {
    return {
        id: params.id,
        data: {
            clientType: params.clientType,
            machineId: params.machineId,
        },
        timeout: () => ({
            emitWithAck: async () => ({ kind: "unavailable", code: "targetUnavailable" }),
        }),
    };
}

describe("createAutomationReplyHandoffDaemonDispatcher", () => {
    it("forwards only raw frozen envelopes to the exact target daemon and revalidates its socket identity before delivery", async () => {
        const exactTarget = createTarget({
            id: "exact-daemon-socket",
            clientType: "machine-scoped",
            machineId: "machine-1",
        });
        const wrongMachine = createTarget({
            id: "wrong-machine-socket",
            clientType: "machine-scoped",
            machineId: "machine-2",
        });
        const userSocket = createTarget({
            id: "user-socket",
            clientType: "user-scoped",
            machineId: "machine-1",
        });
        const forwardRpc = vi.fn(async (params: Parameters<AutomationReplyHandoffForwardRpcCall>[0]) => {
            expect(params.targetUserId).toBe("account-1");
            expect(params.method).toBe(`machine-1:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`);
            expect(params.callParams).toEqual(request);
            expect(params.callParams).not.toHaveProperty("input");
            expect(params.authorization).toEqual({ kind: "automation.replyHandoff.serverOrigin" });
            expect(params.targetGuard).toBeDefined();

            const targetGuard = params.targetGuard!;
            expect(await targetGuard.filterTargets([wrongMachine, userSocket, exactTarget])).toEqual([exactTarget]);
            const operation = vi.fn(async () => ({ ok: true }));
            await expect(targetGuard.runOperation({
                target: exactTarget,
                operation,
                readLatestTarget: async () => exactTarget,
            })).resolves.toEqual({ status: "current", value: { ok: true } });
            expect(operation).toHaveBeenCalledTimes(1);

            return {
                ok: true as const,
                result: {
                    kind: "settled",
                    settlement: { kind: "accepted" },
                    accountCurrentness: { mode: "plain", version: 7, contentKeyFingerprint: null },
                    receiptEnvelope: {
                        t: "plain",
                        v: {
                            v: 1,
                            correspondence,
                            result: { kind: "accepted", custodyId: "custody-1" },
                        },
                    },
                },
            };
        }) as AutomationReplyHandoffForwardRpcCall;
        const dispatch = createAutomationReplyHandoffDaemonDispatcher({
            io: {} as Server,
            forwardRpc,
        });

        await expect(dispatch(request)).resolves.toEqual({
            kind: "settled",
            settlement: { kind: "accepted" },
            accountCurrentness: { mode: "plain", version: 7, contentKeyFingerprint: null },
            receiptEnvelope: {
                t: "plain",
                v: {
                    v: 1,
                    correspondence,
                    result: { kind: "accepted", custodyId: "custody-1" },
                },
            },
        });
    });

    it("fails closed for malformed input, a lost target response, and a malformed daemon result", async () => {
        const targetUnavailable = vi.fn(async () => ({ ok: false as const, error: "RPC method not available" })) as AutomationReplyHandoffForwardRpcCall;
        const dispatchUnavailable = createAutomationReplyHandoffDaemonDispatcher({
            io: {} as Server,
            forwardRpc: targetUnavailable,
        });
        await expect(dispatchUnavailable({ ...request, target: { ...request.target, unexpected: true } })).resolves.toEqual({
            kind: "unavailable",
            code: "contractInvalid",
        });
        await expect(dispatchUnavailable(request)).resolves.toEqual({
            kind: "unavailable",
            code: "targetUnavailable",
        });

        const malformedResult = vi.fn(async () => ({ ok: true as const, result: { kind: "settled" } })) as AutomationReplyHandoffForwardRpcCall;
        const dispatchMalformedResult = createAutomationReplyHandoffDaemonDispatcher({
            io: {} as Server,
            forwardRpc: malformedResult,
        });
        await expect(dispatchMalformedResult(request)).resolves.toEqual({
            kind: "unavailable",
            code: "contractInvalid",
        });
    });
});
