import {
    AutomationRunCauseSchema,
    type AutomationRunCause,
} from "@happier-dev/protocol";

import type { AutomationRunItem } from "./automationTypes";

type CauseRow = Pick<AutomationRunItem,
    | "triggerId"
    | "causeKind"
    | "causeTriggerKind"
    | "causeTriggerRevision"
    | "causeOccurredAt"
    | "causeEventPluginId"
    | "causeEventLocalId"
    | "causeScheduledFor"
    | "causeSessionLifecycleEvent"
    | "causeSourceSessionId"
    | "causeSourceTurnId"
    | "occurrenceKey"
    | "causeSourceSelectorId"
    | "createdAt"
>;

function required<T>(value: T | null, field: string): T {
    if (value === null) throw new Error(`Automation Run cause has no ${field}`);
    return value;
}

/** The sole physical-row to immutable cause decoder. */
export function decodeAutomationRunCause(row: CauseRow): AutomationRunCause {
    if (row.causeKind === "manual") {
        return AutomationRunCauseSchema.parse({
            kind: "manual",
            invokedAt: (row.causeOccurredAt ?? row.createdAt).getTime(),
        });
    }
    if (row.causeKind === "conversation") {
        return AutomationRunCauseSchema.parse({
            kind: "conversation",
            occurrenceKey: required(row.occurrenceKey, "occurrenceKey"),
            occurredAt: required(row.causeOccurredAt, "causeOccurredAt").getTime(),
        });
    }

    const common = {
        kind: "trigger" as const,
        triggerId: required(row.triggerId, "triggerId"),
        triggerRevision: required(row.causeTriggerRevision, "causeTriggerRevision"),
        occurrenceKey: required(row.occurrenceKey, "occurrenceKey"),
        occurredAt: required(row.causeOccurredAt, "causeOccurredAt").getTime(),
    };
    if (row.causeTriggerKind === "schedule") {
        return AutomationRunCauseSchema.parse({
            ...common,
            triggerKind: "schedule",
            evidence: { scheduledFor: required(row.causeScheduledFor, "causeScheduledFor").getTime() },
        });
    }
    if (row.causeTriggerKind === "pluginEvent") {
        return AutomationRunCauseSchema.parse({
            ...common,
            triggerKind: "pluginEvent",
            evidence: {
                eventRef: {
                    pluginId: required(row.causeEventPluginId, "causeEventPluginId"),
                    localId: required(row.causeEventLocalId, "causeEventLocalId"),
                },
                sourceSelectorId: required(row.causeSourceSelectorId, "causeSourceSelectorId"),
            },
        });
    }
    if (row.causeTriggerKind === "sessionLifecycle") {
        return AutomationRunCauseSchema.parse({
            ...common,
            triggerKind: "sessionLifecycle",
            evidence: {
                event: required(row.causeSessionLifecycleEvent, "causeSessionLifecycleEvent"),
                sourceSessionId: required(row.causeSourceSessionId, "causeSourceSessionId"),
                sourceTurnId: required(row.causeSourceTurnId, "causeSourceTurnId"),
            },
        });
    }
    throw new Error("Automation trigger cause has no valid trigger kind");
}

/** The sole immutable cause to physical-row encoder. */
export function encodeAutomationRunCause(causeInput: AutomationRunCause) {
    const cause = AutomationRunCauseSchema.parse(causeInput);
    if (cause.kind === "manual") {
        return {
            triggerId: null,
            causeKind: "manual" as const,
            causeTriggerKind: null,
            causeTriggerRevision: null,
            causeOccurredAt: new Date(cause.invokedAt),
            causeEventPluginId: null,
            causeEventLocalId: null,
            causeScheduledFor: null,
            causeSessionLifecycleEvent: null,
            causeSourceSessionId: null,
            causeSourceTurnId: null,
            occurrenceKey: null,
            causeSourceSelectorId: null,
        };
    }
    if (cause.kind === "conversation") {
        return {
            triggerId: null,
            causeKind: "conversation" as const,
            causeTriggerKind: null,
            causeTriggerRevision: null,
            causeOccurredAt: new Date(cause.occurredAt),
            causeEventPluginId: null,
            causeEventLocalId: null,
            causeScheduledFor: null,
            causeSessionLifecycleEvent: null,
            causeSourceSessionId: null,
            causeSourceTurnId: null,
            occurrenceKey: cause.occurrenceKey,
            causeSourceSelectorId: null,
        };
    }
    return {
        triggerId: cause.triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: cause.triggerKind,
        causeTriggerRevision: cause.triggerRevision,
        causeOccurredAt: new Date(cause.occurredAt),
        causeScheduledFor: cause.triggerKind === "schedule" ? new Date(cause.evidence.scheduledFor) : null,
        causeEventPluginId: cause.triggerKind === "pluginEvent"
            ? cause.evidence.eventRef.pluginId
            : null,
        causeEventLocalId: cause.triggerKind === "pluginEvent"
            ? cause.evidence.eventRef.localId
            : null,
        causeSessionLifecycleEvent: cause.triggerKind === "sessionLifecycle"
            ? cause.evidence.event
            : null,
        causeSourceSessionId: cause.triggerKind === "sessionLifecycle"
            ? cause.evidence.sourceSessionId
            : null,
        causeSourceTurnId: cause.triggerKind === "sessionLifecycle"
            ? cause.evidence.sourceTurnId
            : null,
        occurrenceKey: cause.occurrenceKey,
        causeSourceSelectorId: cause.triggerKind === "pluginEvent"
            ? cause.evidence.sourceSelectorId
            : null,
    };
}
