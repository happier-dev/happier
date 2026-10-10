import { describe, expect, it } from "vitest";
import { sealWorkflowFinalResultStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";
import { AutomationOccurrenceKeyV1Schema, createAccountScopedCryptoMaterialSnapshotV1, sealAutomationConversationReplyContextStoredEnvelopeV1 } from "@happier-dev/protocol";

import {
    classifyAutomationReplyHandoffDispatchability,
    type AutomationReplyHandoffImmutableFacts,
} from "./automationReplyHandoffDispatchability";

const ACCOUNT_ID = "account-reply-handoff-dispatchability";
const OCCURRENCE_KEY = AutomationOccurrenceKeyV1Schema.parse("A".repeat(43));

function envelope(content: "result" | "replyContext"): string {
    return JSON.stringify({
        t: "plain",
        v: content === "result"
            ? {
                v: 1,
                correspondence: {
                    accountId: ACCOUNT_ID,
                    automationId: "automation-1",
                    runId: "run-1",
                    handoffId: "handoff-1",
                },
                result: { v: 1, kind: "text", text: "The Automation completed." },
            }
            : {
                v: 1,
                correspondence: { automationId: "automation-1", occurrenceKey: OCCURRENCE_KEY },
                opaqueContext: { conversationId: "conversation-1", messageId: "message-1" },
            },
    });
}

function facts(
    overrides: Partial<AutomationReplyHandoffImmutableFacts> = {},
): AutomationReplyHandoffImmutableFacts {
    return {
        id: "run-1",
        accountId: ACCOUNT_ID,
        workflowCustodyState: null,
        occurrenceKey: OCCURRENCE_KEY,
        replyHandoffId: "handoff-1",
        replyHandoffActionPluginId: "happier.channels",
        replyHandoffActionLocalId: "automation/result-deliver-v1",
        replyHandoffTargetMachineId: "machine-1",
        replyHandoffTargetMachineInstallationId: "installation-1",
        replyHandoffTargetMaterializationId: "materialization-1",
        resultEnvelope: envelope("result"),
        replyContextEnvelope: envelope("replyContext"),
        ...overrides,
    };
}

describe("Automation reply-handoff dispatchability", () => {
    it.each(["plain", "e2ee"] as const)("admits a %s Workflow result through the existing Channels handoff", (mode) => {
        const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
            ...(mode === "plain" ? { mode } : { mode, runDataKey: new Uint8Array(32).fill(3),
                randomBytes: (length: number) => new Uint8Array(length).fill(7) }),
            binding: { v: 1, purpose: "final_result", accountId: ACCOUNT_ID, runId: "run-1" },
            finalResult: { kind: "happier.workflow-final-result.v1", result: { kind: "text", value: "Reply from the Workflow" },
                producerInvocation: { recordId: "prompt-invocation" } },
        }));
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: "e2ee",
            material: { type: "legacy", secret: new Uint8Array(32).fill(9) } }).material;
        const replyContextEnvelope = mode === "plain" ? envelope("replyContext") : JSON.stringify(sealAutomationConversationReplyContextStoredEnvelopeV1({
            mode, material, randomBytes: (length) => new Uint8Array(length).fill(7),
            correspondence: { automationId: "automation-1", occurrenceKey: OCCURRENCE_KEY },
            opaqueContext: { conversationId: "conversation-1", messageId: "message-1" },
        }));
        expect(classifyAutomationReplyHandoffDispatchability({
            facts: facts({ resultEnvelope, replyContextEnvelope, workflowCustodyState: "settled" }), mode,
        })).toBe("dispatchable");
        if (mode === "plain") {
            expect(classifyAutomationReplyHandoffDispatchability({
                facts: facts({ resultEnvelope, replyContextEnvelope, workflowCustodyState: "settled", id: "different-run" }), mode,
            })).toBe("immutableHandoffInvalid");
        }
    });

    it.each(["null", "omitted"] as const)("admits a complete historical frozen handoff with %s Workflow custody", (custody) => {
        const { workflowCustodyState: _workflowCustodyState, ...historicalFacts } = facts();
        expect(classifyAutomationReplyHandoffDispatchability({
            facts: custody === "null" ? facts() : historicalFacts,
            mode: "plain",
        })).toBe("dispatchable");
    });

    it.each([
        ["a missing occurrence identity", { occurrenceKey: null }],
        ["a missing handoff identity", { replyHandoffId: null }],
        ["a missing target machine", { replyHandoffTargetMachineId: null }],
        ["a missing target materialization", { replyHandoffTargetMaterializationId: null }],
        ["a missing target Action", { replyHandoffActionLocalId: null }],
        ["an unparseable result envelope", { resultEnvelope: "{" }],
        ["an absent reply-context envelope", { replyContextEnvelope: null }],
    ] as const)(
        "classifies %s as terminally invalid rather than retryable",
        (_description, override) => {
            expect(classifyAutomationReplyHandoffDispatchability({
                facts: facts(override),
                mode: "plain",
            })).toBe("immutableHandoffInvalid");
        },
    );

    it("classifies an envelope written for the other Account mode as terminally invalid", () => {
        expect(classifyAutomationReplyHandoffDispatchability({
            facts: facts(),
            mode: "e2ee",
        })).toBe("immutableHandoffInvalid");
    });
});
