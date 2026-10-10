import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";
import { AutomationPluginEventOccurrenceEvidenceV1Schema, AutomationRunLifecycleOccurrenceEvidenceV1Schema } from "@happier-dev/protocol";

import { classifyPlainAutomationOccurrenceEvidence, findAutomationOccurrencesTx } from "./automationOccurrencePersistence";

describe("retained host occurrence provenance", () => {
    it("reads canonical plain evidence and rejects unsupported host-origin wrappers", () => {
        const evidence = AutomationPluginEventOccurrenceEvidenceV1Schema.parse({ v: 1, kind: "pluginEvent",
            eventRef: { pluginId: "acme.events", localId: "changed" }, sourceSelectorId: "00000000-0000-4000-8000-000000000001",
            occurrenceId: "occurrence", occurredAt: 100, payload: { changed: true } });
        const legacy = JSON.stringify({ t: "plain", v: evidence });
        expect(classifyPlainAutomationOccurrenceEvidence({ triggerEvidenceEnvelope: legacy, expectedEvidence: evidence })).toBe("match");
        const wrapped = JSON.stringify({ v: 1, originRunId: "host-origin", evidence: JSON.parse(legacy) });
        expect(classifyPlainAutomationOccurrenceEvidence({ triggerEvidenceEnvelope: wrapped,
            expectedEvidence: evidence })).toBe("unavailable");
    });

    it("compares the immutable host origin retained inside canonical Run lifecycle evidence", () => {
        const evidence = AutomationRunLifecycleOccurrenceEvidenceV1Schema.parse({
            v: 1, kind: "runLifecycle", source: { kind: "execution_run", machineId: "machine", runId: "execution" },
            condition: "terminal", sourceRevision: 1, occurredAt: 100, originRunId: "host-origin",
        });
        const triggerEvidenceEnvelope = JSON.stringify({ t: "plain", v: evidence });
        expect(classifyPlainAutomationOccurrenceEvidence({ triggerEvidenceEnvelope, expectedEvidence: evidence })).toBe("match");
        expect(classifyPlainAutomationOccurrenceEvidence({ triggerEvidenceEnvelope,
            expectedEvidence: { ...evidence, originRunId: "different-origin" } })).toBe("mismatch");
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
