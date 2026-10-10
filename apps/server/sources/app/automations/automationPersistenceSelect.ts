import type { Prisma } from "@prisma/client";

import { AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS } from "@happier-dev/protocol";

/** The predecessor started transaction committed before any Session effect.
 * Reclaimed pre-start claims remain safe; attempt count is not effect evidence.
 */
export const automationRunWithoutExecutionWhere = {
    state: { in: ["queued", "claimed"] },
    startedAt: null, finishedAt: null, producedSessionId: null, summaryCiphertext: null, resultEnvelope: null,
    executionAttempt: 0, executionDispatchCommittedAt: null,
    executionNativeRunId: null, executionNativeCallId: null, executionNativeSidechainId: null,
    workflowAcceptedSnapshotEnvelope: null, workflowCheckpointEnvelope: null,
    workflowInvocations: { none: {} },
    events: { none: { type: "run_started" } },
    AND: [{ OR: [{ executionDispatchState: null }, { executionDispatchState: "notStarted" }] }],
} satisfies Prisma.AutomationRunWhereInput;

export const automationTriggerSelect = {
    id: true, automationId: true, kind: true, enabled: true, revision: true, deletedAt: true,
    scheduleKind: true, scheduleExpr: true, everyMs: true, timezone: true, nextRunAt: true,
    eventPluginId: true, eventLocalId: true, sourceSelectorId: true, sourceContractVersion: true,
    observationTransport: true, webhookEndpointId: true, observationStartsAt: true,
    watcherMachineId: true, watcherMachineInstallationId: true, watcherPluginId: true,
    watcherMaterializationId: true, definitionEnvelope: true,
    sessionLifecycleEventsJson: true, sessionLifecyclePolicyKind: true,
    sessionLifecycleMatchCount: true, remainingOccurrences: true,
    sourceSessionId: true, sourceTurnId: true,
    sourceRunId: true, sourceRunMachineId: true, runLifecycleConfigurationJson: true,
    createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationTriggerSelect;

/**
 * The list-specific trigger read: everything the current list/detail DTO
 * needs, without the private definition envelope. Status
 * summaries are batch-loaded by the status projection owner, so no trigger
 * select loads the unused status relation.
 */
export const automationTriggerListItemSelect = {
    id: true, automationId: true, kind: true, enabled: true, revision: true, deletedAt: true,
    scheduleKind: true, scheduleExpr: true, everyMs: true, timezone: true, nextRunAt: true,
    eventPluginId: true, eventLocalId: true, sourceSelectorId: true, sourceContractVersion: true,
    observationTransport: true, webhookEndpointId: true, observationStartsAt: true,
    watcherMachineId: true, watcherMachineInstallationId: true, watcherPluginId: true,
    watcherMaterializationId: true,
    sessionLifecycleEventsJson: true, sessionLifecyclePolicyKind: true,
    sessionLifecycleMatchCount: true, remainingOccurrences: true,
    sourceSessionId: true, sourceTurnId: true,
    sourceRunId: true, sourceRunMachineId: true, runLifecycleConfigurationJson: true,
    createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationTriggerSelect;

/** Canonical definition read. Every current trigger reader starts here. */
export const automationListItemSelect = {
    id: true, accountId: true, name: true, description: true, enabled: true,
    workflowDefinitionId: true, scopeSessionId: true,
    targetType: true, templateCiphertext: true, templateVersion: true, lastRunAt: true,
    createdAt: true, updatedAt: true,
    assignments: {
        select: { machineId: true, enabled: true, priority: true, updatedAt: true },
        orderBy: [{ priority: "desc" }, { machineId: "asc" }],
    },
    triggers: {
        where: { deletedAt: null },
        select: automationTriggerSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    },
} satisfies Prisma.AutomationSelect;

/**
 * The list-specific Automation definition read. Identical to the canonical
 * definition read except that each trigger omits its private definition
 * envelope, which no list consumer projects.
 */
export const automationDefinitionListItemSelect = {
    ...automationListItemSelect,
    triggers: {
        where: { deletedAt: null },
        select: automationTriggerListItemSelect,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    },
} satisfies Prisma.AutomationSelect;

/**
 * The one physical cause column set. Every read whose rows reach
 * `decodeAutomationRunCause` starts from this fragment, so no caller can
 * select a partial immutable cause; `CauseRow` is derived from these keys.
 */
export const automationRunCauseSelect = {
    originKind: true,
    triggerId: true,
    causeKind: true, causeTriggerKind: true, causeTriggerRevision: true, causeOccurredAt: true,
    causeEventPluginId: true, causeEventLocalId: true, causeScheduledFor: true,
    causeSessionLifecycleEvent: true, causeSourceSessionId: true, causeSourceTurnId: true,
    causeRunLifecycleEvidenceJson: true,
    causeSessionLifecycleRequestId: true, causeSessionLifecycleRequestKind: true,
    causeSessionLifecyclePolicyKind: true, causeSessionLifecycleConfiguredCount: true,
    occurrenceKey: true, causeSourceSelectorId: true, createdAt: true,
} satisfies Prisma.AutomationRunSelect;

export const automationRunItemSelect = {
    ...automationRunCauseSelect,
    id: true, originKind: true, automationId: true, originSessionId: true,
    workflowAcceptedSnapshotEnvelope: true,
    accountId: true, state: true,
    legacyManualIdempotencyKey: true, occurrenceEvidenceEqualityTag: true,
    triggerEvidenceEnvelope: true, executionInputEnvelope: true,
    workflowCustodyState: true,
    executionDispatchState: true, executionAttempt: true,
    executionDispatchCommittedAt: true, executionDispatchDueAt: true,
    executionNativeRunId: true, executionNativeCallId: true, executionNativeSidechainId: true,
    resultEnvelope: true, replyContextEnvelope: true,
    replyHandoffActionPluginId: true, replyHandoffActionLocalId: true,
    replyHandoffTargetMachineId: true, replyHandoffTargetMachineInstallationId: true,
    replyHandoffTargetMaterializationId: true, replyHandoffId: true,
    replyHandoffState: true, replyHandoffAttempt: true, replyHandoffDueAt: true,
    scheduledAt: true, dueAt: true,
    claimedAt: true, startedAt: true, finishedAt: true, claimedByMachineId: true,
    leaseExpiresAt: true, attempt: true, revision: true, summaryCiphertext: true,
    errorCode: true, errorMessage: true,
    producedSessionId: true, createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationRunSelect;

export const automationRunDetailSelect = {
    ...automationRunItemSelect,
    events: {
        select: { ts: true, type: true, payload: true },
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS,
    },
} satisfies Prisma.AutomationRunSelect;

/** The current V3 Run-list read: public list facts and immutable cause only. */
export const automationRunV3ListItemSelect = {
    ...automationRunCauseSelect,
    id: true, automationId: true, state: true,
    executionDispatchState: true, executionAttempt: true,
    errorCode: true,
    replyHandoffState: true, replyHandoffAttempt: true, replyHandoffDueAt: true,
    dueAt: true,
    claimedAt: true, startedAt: true, finishedAt: true, claimedByMachineId: true,
    leaseExpiresAt: true, attempt: true, revision: true,
    producedSessionId: true, createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationRunSelect;

export const automationRunWithAutomationSelect = {
    ...automationRunItemSelect,
    workflowResumeRequestedRevision: true,
    assignments: {
        select: { machineId: true, priority: true },
        orderBy: [{ priority: "desc" }, { machineId: "asc" }],
    },
    automation: {
        select: { id: true, name: true, enabled: true, targetType: true, templateCiphertext: true,
            workflowDefinitionId: true, scopeSessionId: true },
    },
} satisfies Prisma.AutomationRunSelect;
