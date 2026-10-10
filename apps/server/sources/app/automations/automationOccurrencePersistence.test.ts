import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { AutomationPluginEventOccurrenceEvidenceV1Schema } from "@happier-dev/protocol";

import { classifyPlainAutomationOccurrenceEvidence, findAutomationOccurrencesTx } from "./automationOccurrencePersistence";

describe("retained occurrence evidence", () => {
    it("continues to read the legacy plain occurrence evidence", () => {
        const evidence = AutomationPluginEventOccurrenceEvidenceV1Schema.parse({ v: 1, kind: "pluginEvent",
            eventRef: { pluginId: "acme.events", localId: "changed" }, sourceSelectorId: "04de2271-6313-4fd4-8f1b-e0bd39222f21",
            occurrenceId: "occurrence", occurredAt: 100, payload: { changed: true } });
        const legacy = JSON.stringify({ t: "plain", v: evidence });
        expect(classifyPlainAutomationOccurrenceEvidence({ triggerEvidenceEnvelope: legacy, expectedEvidence: evidence })).toBe("match");
    });

    // Current cause-arm CHECKs prohibit host-origin wrappers; an approved storage amendment is required.
    it.todo("retains immutable host origin through opaque evidence reads and encryption migration");
});

describe("findAutomationOccurrencesTx", () => {
    it("reads a bounded occurrence set in one query through the canonical Automation identity", async () => {
        const findMany = vi.fn().mockResolvedValue([
            { id: "run-1", automationId: "automation-1", occurrenceKey: "occurrence-1" },
        ]);

        await expect(findAutomationOccurrencesTx({
            tx: { automationRun: { findMany } } as unknown as Tx,
            accountId: "account-1",
            occurrences: [
                { automationId: "automation-1", occurrenceKey: "occurrence-1" },
                { automationId: "automation-2", occurrenceKey: "occurrence-2" },
            ],
            select: { id: true, automationId: true, occurrenceKey: true },
        })).resolves.toEqual([
            { id: "run-1", automationId: "automation-1", occurrenceKey: "occurrence-1" },
        ]);

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                OR: [
                    { automationId: "automation-1", occurrenceKey: "occurrence-1" },
                    { automationId: "automation-2", occurrenceKey: "occurrence-2" },
                ],
            },
            select: { id: true, automationId: true, occurrenceKey: true },
        });
    });
});
