import type { Prisma } from "@prisma/client";

import { AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS } from "@happier-dev/protocol";

export const automationTriggerSelect = {
    id: true, automationId: true, kind: true, enabled: true, revision: true, deletedAt: true,
    scheduleKind: true, scheduleExpr: true, everyMs: true, timezone: true, nextRunAt: true,
    eventPluginId: true, eventLocalId: true, sourceSelectorId: true, sourceContractVersion: true,
    observationTransport: true, webhookEndpointId: true, observationStartsAt: true,
    watcherMachineId: true, watcherMachineInstallationId: true, watcherPluginId: true,
    watcherMaterializationId: true, definitionEnvelope: true,
    sessionLifecycleEvent: true, sourceSessionId: true, sourceTurnId: true,
    createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationTriggerSelect;

/**
 * The list-specific trigger read: everything the list/detail DTO and released
 * V2 representability need, without the private definition envelope. Status
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
    sessionLifecycleEvent: true, sourceSessionId: true, sourceTurnId: true,
    createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationTriggerSelect;

/** Canonical definition read. Every current trigger reader starts here. */
export const automationListItemSelect = {
    id: true, accountId: true, name: true, description: true, enabled: true,
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

export const automationRunItemSelect = {
    id: true, automationId: true, accountId: true, state: true, triggerId: true,
    causeKind: true, causeTriggerKind: true, causeTriggerRevision: true, causeOccurredAt: true,
    causeEventPluginId: true, causeEventLocalId: true, causeScheduledFor: true,
    causeSessionLifecycleEvent: true, causeSourceSessionId: true, causeSourceTurnId: true,
    occurrenceKey: true, legacyManualIdempotencyKey: true,
    occurrenceEvidenceEqualityTag: true, causeSourceSelectorId: true,
    triggerEvidenceEnvelope: true, executionInputEnvelope: true,
    executionDispatchState: true, executionAttempt: true,
    executionDispatchCommittedAt: true, executionDispatchDueAt: true,
    executionNativeRunId: true, executionNativeCallId: true, executionNativeSidechainId: true,
    resultEnvelope: true, replyContextEnvelope: true,
    replyHandoffActionPluginId: true, replyHandoffActionLocalId: true,
    replyHandoffTargetMachineId: true, replyHandoffTargetMachineInstallationId: true,
    replyHandoffTargetMaterializationId: true, replyHandoffId: true,
    replyHandoffState: true, replyHandoffAttempt: true, replyHandoffDueAt: true,
    replyHandoffReceiptEnvelope: true, scheduledAt: true, dueAt: true,
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
    id: true, automationId: true, state: true, triggerId: true,
    causeKind: true, causeTriggerKind: true, causeTriggerRevision: true, causeOccurredAt: true,
    causeEventPluginId: true, causeEventLocalId: true, causeScheduledFor: true,
    causeSessionLifecycleEvent: true, causeSourceSessionId: true, causeSourceTurnId: true,
    occurrenceKey: true, causeSourceSelectorId: true,
    executionDispatchState: true, executionAttempt: true,
    errorCode: true,
    replyHandoffState: true, replyHandoffAttempt: true, replyHandoffDueAt: true,
    dueAt: true,
    claimedAt: true, startedAt: true, finishedAt: true, claimedByMachineId: true,
    leaseExpiresAt: true, attempt: true, revision: true,
    producedSessionId: true, createdAt: true, updatedAt: true,
} satisfies Prisma.AutomationRunSelect;

/** Released-V2 boundary read; retains fields required by its legacy adapter. */
export const automationRunV2ListItemSelect = {
    ...automationRunV3ListItemSelect,
    executionInputEnvelope: true,
    resultEnvelope: true,
    errorMessage: true,
    scheduledAt: true,
} satisfies Prisma.AutomationRunSelect;

export const automationRunWithAutomationSelect = {
    ...automationRunItemSelect,
    assignments: {
        select: { machineId: true, priority: true },
        orderBy: [{ priority: "desc" }, { machineId: "asc" }],
    },
    automation: {
        select: { id: true, name: true, enabled: true, targetType: true, templateCiphertext: true },
    },
} satisfies Prisma.AutomationRunSelect;
