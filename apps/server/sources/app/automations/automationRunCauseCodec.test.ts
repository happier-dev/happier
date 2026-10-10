import { describe, expect, it } from "vitest";

import { randomUUID, createHash } from "node:crypto";
import { AutomationRunCauseSchema } from "@happier-dev/protocol";
import { decodeAutomationRunCause, encodeAutomationRunCause, retainedV2OriginKindForRun } from "./automationRunCauseCodec";

describe("automationRunCauseCodec", () => {
    it("preserves the scoped conversation trigger while ordinary Channel conversations remain unscoped", () => {
        const triggerId = randomUUID();
        const conversation = AutomationRunCauseSchema.parse({
            kind: "conversation" as const, occurredAt: 123,
            occurrenceKey: createHash("sha256").update("conversation").digest("base64url"),
        });
        const scoped = encodeAutomationRunCause(AutomationRunCauseSchema.parse({ ...conversation, triggerId }));
        expect(scoped.triggerId).toBe(triggerId);
        expect(decodeAutomationRunCause({ ...scoped, originKind: "automation", createdAt: new Date(0) }))
            .toEqual({ ...conversation, triggerId });
        expect(encodeAutomationRunCause(conversation).triggerId).toBeNull();
    });
    it("keeps direct Workflow rows out of Automation cause decoding", () => {
        const direct = {
            originKind: "direct",
            triggerId: null,
            causeKind: null,
            causeTriggerKind: null,
            causeTriggerRevision: null,
            causeOccurredAt: null,
            causeEventPluginId: null,
            causeEventLocalId: null,
            causeScheduledFor: null,
            causeSessionLifecycleEvent: null,
            causeSourceSessionId: null,
            causeSourceTurnId: null,
            causeRunLifecycleEvidenceJson: null,
            causeOriginRunId: null,
            causeSessionLifecycleRequestId: null,
            causeSessionLifecycleRequestKind: null,
            causeSessionLifecyclePolicyKind: null,
            causeSessionLifecycleConfiguredCount: null,
            occurrenceKey: null,
            causeSourceSelectorId: null,
            createdAt: new Date(0),
        } as const;

        expect(decodeAutomationRunCause(direct)).toBeNull();
        expect(retainedV2OriginKindForRun(direct)).toBeUndefined();
    });

    it("round-trips exact Run evidence and refuses an unavailable persisted fact", () => {
        const cause = AutomationRunCauseSchema.parse({ kind: "trigger", triggerKind: "runLifecycle",
            triggerId: randomUUID(), triggerRevision: 2, occurredAt: 123,
            occurrenceKey: createHash("sha256").update("run-lifecycle").digest("base64url"),
            evidence: { source: { kind: "execution_run", machineId: "machine-one", runId: "run-one" },
                condition: "terminal", sourceRevision: 123 } });
        const persisted = { ...encodeAutomationRunCause(cause), originKind: "automation" as const, createdAt: new Date(0) };
        expect(decodeAutomationRunCause(persisted)).toEqual(cause);
        expect(retainedV2OriginKindForRun(persisted)).toBeUndefined();
        expect(() => decodeAutomationRunCause({ ...persisted, causeRunLifecycleEvidenceJson: null })).toThrow();
    });
});
