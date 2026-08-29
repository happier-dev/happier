import { randomUUID } from "node:crypto";
import {
    AutomationOccurrenceKeyV1Schema,
    MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

import type {
    AutomationAccountEncryptionTransitionInventoryItem,
    AutomationAccountEncryptionTransitionStageItem,
} from "@/app/automations/automationCrudService";

import {
    measureAccountEncryptionTransitionAutomationSourceItemBytes,
    measureAccountEncryptionTransitionAutomationStageItemBytes,
    sourceItemFromAccountEncryptionTransitionAutomationStage,
    targetItemFromAccountEncryptionTransitionAutomationStage,
    type AccountEncryptionTransitionAutomationStoredStage,
} from "./accountEncryptionTransitionAutomationStage";

const TRANSITION_ID = randomUUID();
const RUN_ID = "automation-run-near-maximum-envelope";
const AUTOMATION_ID = "automation-near-maximum-envelope";

/**
 * A retained envelope only a little under the released Protocol ceiling. The
 * canonical bound is a UTF-8 byte ceiling, so the ASCII fixture is sized in
 * characters and asserted in bytes below.
 */
function nearMaximumStoredEnvelope(tag: string): string {
    const framing = JSON.stringify({ t: "encrypted", c: "" });
    const ciphertext = tag.padEnd(
        MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES - framing.length - 64,
        "A",
    );
    return JSON.stringify({ t: "encrypted", c: ciphertext });
}

function runSourceItem(
    replyContextEnvelope: string,
): AutomationAccountEncryptionTransitionInventoryItem {
    return {
        kind: "run",
        runId: RUN_ID,
        automationId: AUTOMATION_ID,
        revision: 4,
        cause: {
            kind: "conversation",
            occurrenceKey: AutomationOccurrenceKeyV1Schema.parse("A".repeat(43)),
            occurredAt: 1_723_247_200_000,
        },
        source: {
            triggerEvidenceEnvelope: null,
            occurrenceEvidenceEqualityTag: null,
            executionInputEnvelope: null,
            resultEnvelope: null,
            replyContextEnvelope,
            replyHandoffReceiptEnvelope: null,
            failureDetailEnvelope: null,
            summaryCiphertext: null,
        },
    };
}

function storedStageForSource(
    item: AutomationAccountEncryptionTransitionInventoryItem,
    target?: AutomationAccountEncryptionTransitionStageItem,
): AccountEncryptionTransitionAutomationStoredStage {
    return {
        id: randomUUID(),
        transitionId: TRANSITION_ID,
        participantKind: "run",
        participantId: RUN_ID,
        automationId: AUTOMATION_ID,
        sourceRevision: 4,
        sourceContent: JSON.stringify(item),
        targetContent: target === undefined ? null : JSON.stringify(target),
        sourceEncodedBytes:
            measureAccountEncryptionTransitionAutomationSourceItemBytes(item),
        targetEncodedBytes: target === undefined
            ? null
            : measureAccountEncryptionTransitionAutomationStageItemBytes(target),
    };
}

describe("accountEncryptionTransitionAutomationStage stored content bounds", () => {
    it("round-trips every Event trigger definition without inventing a per-Automation trigger ceiling", () => {
        const source: AutomationAccountEncryptionTransitionInventoryItem = {
            kind: "definition",
            automationId: AUTOMATION_ID,
            revision: 4,
            source: {
                templateCiphertext: JSON.stringify({ t: "plain", v: {} }),
                triggerDefinitionEnvelopes: Array.from({ length: 51 }, (_, index) => ({
                    triggerId: `automation-trigger-${index}`,
                    triggerRevision: index,
                    envelope: JSON.stringify({ t: "plain", v: { index } }),
                })),
            },
        };
        const stage: AccountEncryptionTransitionAutomationStoredStage = {
            id: randomUUID(),
            transitionId: TRANSITION_ID,
            participantKind: "definition",
            participantId: AUTOMATION_ID,
            automationId: AUTOMATION_ID,
            sourceRevision: source.revision,
            sourceContent: JSON.stringify(source),
            targetContent: null,
            sourceEncodedBytes:
                measureAccountEncryptionTransitionAutomationSourceItemBytes(source),
            targetEncodedBytes: null,
        };

        expect(
            sourceItemFromAccountEncryptionTransitionAutomationStage(stage),
        ).toEqual(source);
    });

    it("round-trips a retained envelope at the released Protocol ceiling instead of reporting an incomplete migration", () => {
        const replyContextEnvelope = nearMaximumStoredEnvelope("source");
        expect(
            new TextEncoder().encode(replyContextEnvelope).byteLength,
        ).toBeGreaterThan(400_000);
        expect(
            new TextEncoder().encode(replyContextEnvelope).byteLength,
        ).toBeLessThanOrEqual(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES);

        const source = runSourceItem(replyContextEnvelope);
        const target: AutomationAccountEncryptionTransitionStageItem = {
            kind: "run",
            runId: RUN_ID,
            automationId: AUTOMATION_ID,
            expectedRevision: 4,
            cause: {
                kind: "conversation",
                occurrenceKey: AutomationOccurrenceKeyV1Schema.parse("A".repeat(43)),
                occurredAt: 1_723_247_200_000,
            },
            source: source.kind === "run" ? source.source : (() => {
                throw new Error("Expected a Run source fixture");
            })(),
            target: {
                triggerEvidenceEnvelope: null,
                occurrenceEvidenceEqualityTag: null,
                executionInputEnvelope: null,
                resultEnvelope: null,
                replyContextEnvelope: nearMaximumStoredEnvelope("target"),
                replyHandoffReceiptEnvelope: null,
                failureDetailEnvelope: null,
            },
        };
        const stage = storedStageForSource(source, target);

        expect(
            sourceItemFromAccountEncryptionTransitionAutomationStage(stage),
        ).toEqual(source);
        expect(
            targetItemFromAccountEncryptionTransitionAutomationStage(stage),
        ).toEqual(target);
    });

    it("refuses a retained envelope past the released Protocol ceiling", () => {
        const oversized = JSON.stringify({
            t: "encrypted",
            c: "A".repeat(MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES + 1),
        });
        const source = runSourceItem(oversized);

        expect(
            sourceItemFromAccountEncryptionTransitionAutomationStage(
                storedStageForSource(source),
            ),
        ).toBeNull();
    });
});
