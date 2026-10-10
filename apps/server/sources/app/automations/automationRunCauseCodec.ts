import {
    AutomationRunCauseSchema,
    type AutomationRunCause,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { automationRunCauseSelect, automationRunItemSelect } from "./automationPersistenceSelect";
import type { AutomationRunItem } from "./automationTypes";

/**
 * The decoder's row contract, derived from the canonical cause column set so a
 * read that omits one cause column cannot reach the decoder.
 */
export type CauseRow = Prisma.AutomationRunGetPayload<{
    select: typeof automationRunCauseSelect;
}>;

export type AutomationCauseRow = CauseRow & Readonly<{
    originKind: "automation";
    causeKind: NonNullable<CauseRow["causeKind"]>;
}>;

type StoredAutomationRunRow = Prisma.AutomationRunGetPayload<{
    select: typeof automationRunItemSelect;
}>;

/** The canonical physical-row origin correspondence guard. */
export function isAutomationCauseRow<T extends Readonly<{
    originKind: string;
    automationId?: string | null;
    causeKind: CauseRow["causeKind"];
}>>(row: T): row is T & Readonly<{
    originKind: "automation";
    automationId: string;
    causeKind: NonNullable<CauseRow["causeKind"]>;
}> {
    return row.originKind === "automation"
        && row.automationId !== null
        && row.automationId !== undefined
        && row.causeKind !== null;
}

/**
 * Projects a generalized physical Run row into the Automation-only domain.
 * The database correspondence constraint is rechecked at this read boundary;
 * direct Workflow rows remain owned by the Workflow service.
 */
export function projectAutomationOriginRun(row: StoredAutomationRunRow): AutomationRunItem | null {
    if (!isAutomationCauseRow(row)) return null;
    return row as AutomationRunItem;
}

function required<T>(value: T | null, field: string): T {
    if (value === null) throw new Error(`Automation Run cause has no ${field}`);
    return value;
}

/** The sole physical-row to immutable cause decoder. */
export function decodeAutomationRunCause(row: AutomationCauseRow): AutomationRunCause;
export function decodeAutomationRunCause(row: CauseRow): AutomationRunCause | null;
export function decodeAutomationRunCause(row: CauseRow): AutomationRunCause | null {
    if (row.originKind === "direct") return null;
    if (row.originKind !== "automation" || row.causeKind === null) {
        throw new Error("Automation Run has invalid origin correspondence");
    }
    if (row.causeKind === "manual") {
        return AutomationRunCauseSchema.parse({
            kind: "manual",
            invokedAt: (row.causeOccurredAt ?? row.createdAt).getTime(),
        });
    }
    if (row.causeKind === "conversation") {
        return AutomationRunCauseSchema.parse({
            kind: "conversation",
            ...(row.triggerId === null ? {} : { triggerId: row.triggerId }),
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
        const policyKind = required(
            row.causeSessionLifecyclePolicyKind,
            "causeSessionLifecyclePolicyKind",
        );
        const policy = policyKind === "nextMatches"
            ? {
                kind: policyKind,
                count: required(
                    row.causeSessionLifecycleConfiguredCount,
                    "causeSessionLifecycleConfiguredCount",
                ),
            } as const
            : { kind: policyKind } as const;
        const event = required(
            row.causeSessionLifecycleEvent,
            "causeSessionLifecycleEvent",
        );
        return AutomationRunCauseSchema.parse({
            ...common,
            triggerKind: "sessionLifecycle",
            evidence: {
                event,
                sourceSessionId: required(row.causeSourceSessionId, "causeSourceSessionId"),
                ...(event === "sessionArchived" && row.causeOriginRunId !== null
                    ? { originRunId: row.causeOriginRunId } : {}),
                ...(event === "sessionStarted" || event === "sessionArchived" ? {} : {
                    sourceTurnId: required(row.causeSourceTurnId, "causeSourceTurnId"),
                }),
                ...(event === "userActionRequired"
                    ? {
                        requestId: required(
                            row.causeSessionLifecycleRequestId,
                            "causeSessionLifecycleRequestId",
                        ),
                        requestKind: required(
                            row.causeSessionLifecycleRequestKind,
                            "causeSessionLifecycleRequestKind",
                        ),
                    }
                    : {}),
                policy,
            },
        });
    }
    if (row.causeTriggerKind === "runLifecycle") {
        return AutomationRunCauseSchema.parse({ ...common, triggerKind: "runLifecycle",
            evidence: JSON.parse(required(row.causeRunLifecycleEvidenceJson, "causeRunLifecycleEvidenceJson")) });
    }
    throw new Error("Automation trigger cause has no valid trigger kind");
}

/**
 * The one durable-cause to retained-V2 frozen-origin projection. The released
 * V2 seam reads this mapping wherever it must name a Run's predecessor origin;
 * no caller keeps a private copy of the decision.
 */
export function retainedV2OriginKindForRun(run: CauseRow): "scheduled" | "manual" | undefined {
    const cause = decodeAutomationRunCause(run);
    if (cause === null) return undefined;
    if (cause.kind === "manual") return "manual";
    return cause.kind === "trigger" && cause.triggerKind === "schedule"
        ? "scheduled"
        : undefined;
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
            causeRunLifecycleEvidenceJson: null,
            causeOriginRunId: null,
            causeSessionLifecycleRequestId: null,
            causeSessionLifecycleRequestKind: null,
            causeSessionLifecyclePolicyKind: null,
            causeSessionLifecycleConfiguredCount: null,
            occurrenceKey: null,
            causeSourceSelectorId: null,
        };
    }
    if (cause.kind === "conversation") {
        return {
            triggerId: cause.triggerId ?? null,
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
            causeRunLifecycleEvidenceJson: null,
            causeOriginRunId: null,
            causeSessionLifecycleRequestId: null,
            causeSessionLifecycleRequestKind: null,
            causeSessionLifecyclePolicyKind: null,
            causeSessionLifecycleConfiguredCount: null,
            occurrenceKey: cause.occurrenceKey,
            causeSourceSelectorId: null,
        };
    }
    return {
        triggerId: cause.triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: cause.triggerKind,
        causeTriggerRevision: cause.triggerRevision,
        causeRunLifecycleEvidenceJson: cause.triggerKind === "runLifecycle" ? JSON.stringify(cause.evidence) : null,
        causeOriginRunId: cause.triggerKind === "sessionLifecycle" && cause.evidence.event === "sessionArchived"
            ? cause.evidence.originRunId ?? null : null,
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
        causeSourceTurnId: cause.triggerKind === "sessionLifecycle" && "sourceTurnId" in cause.evidence
            ? cause.evidence.sourceTurnId
            : null,
        causeSessionLifecycleRequestId: cause.triggerKind === "sessionLifecycle"
            && cause.evidence.event === "userActionRequired"
            ? cause.evidence.requestId
            : null,
        causeSessionLifecycleRequestKind: cause.triggerKind === "sessionLifecycle"
            && cause.evidence.event === "userActionRequired"
            ? cause.evidence.requestKind
            : null,
        causeSessionLifecyclePolicyKind: cause.triggerKind === "sessionLifecycle"
            ? cause.evidence.policy.kind
            : null,
        causeSessionLifecycleConfiguredCount: cause.triggerKind === "sessionLifecycle"
            && cause.evidence.policy.kind === "nextMatches"
            ? cause.evidence.policy.count
            : null,
        occurrenceKey: cause.occurrenceKey,
        causeSourceSelectorId: cause.triggerKind === "pluginEvent"
            ? cause.evidence.sourceSelectorId
            : null,
    };
}
