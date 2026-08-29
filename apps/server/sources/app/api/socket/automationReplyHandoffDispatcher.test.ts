import { AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1 } from "@happier-dev/protocol";
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
const occurrenceKey = "A".repeat(43);
const occurredAt = 1_786_294_800_000;

/** A synthetic out-of-tree bridge, so no first-party id is load-bearing here. */
const thirdPartyDeliveryActionRef = {
    pluginId: "acme.slack-bridge",
    localId: "automation/reply-deliver-v1",
} as const;

const request = {
    v: 1,
    kind: "automation.replyHandoff.dispatch",
    target: {
        accountId: "account-1",
        machineId: "machine-1",
        machineInstallationId: "installation-1",
        materializationId: "materialization-1",
        actionRef: thirdPartyDeliveryActionRef,
    },
    handoff: {
        handoffId: correspondence.handoffId,
        runId: correspondence.runId,
        automationId: correspondence.automationId,
        occurrenceKey,
        cause: {
            kind: "conversation",
            occurrenceKey,
            occurredAt,
        },
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
                correspondence: {
                    automationId: correspondence.automationId,
                    occurrenceKey,
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

    it("classifies a schema-invalid dispatch request as stable pre-effect invalidRequest before any daemon effect", async () => {
        const targetUnavailable = vi.fn(async () => ({ ok: false as const, error: "RPC method not available" })) as AutomationReplyHandoffForwardRpcCall;
        const dispatchUnavailable = createAutomationReplyHandoffDaemonDispatcher({
            io: {} as Server,
            forwardRpc: targetUnavailable,
        });
        await expect(dispatchUnavailable({ ...request, target: { ...request.target, unexpected: true } })).resolves.toEqual({
            kind: "unavailable",
            code: "invalidRequest",
        });
        expect(targetUnavailable).not.toHaveBeenCalled();
    });

    it("classifies a malformed daemon response as post-effect contractInvalid so the same handoff rejoins", async () => {
        const targetUnavailable = vi.fn(async () => ({ ok: false as const, error: "RPC method not available" })) as AutomationReplyHandoffForwardRpcCall;
        const dispatchUnavailable = createAutomationReplyHandoffDaemonDispatcher({
            io: {} as Server,
            forwardRpc: targetUnavailable,
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
