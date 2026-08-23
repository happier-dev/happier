import type { Prisma } from "@prisma/client";

import { AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS } from "@happier-dev/protocol";

/**
 * Canonical persistence reads for API, lifecycle, and change publication.
 * Keep these in one place so a new Run/trigger arm cannot be cast away by a
 * legacy partial select before versioned projections can enforce it.
 */
export const automationListItemSelect = {
    id: true,
    accountId: true,
    name: true,
    description: true,
    enabled: true,
    triggerKind: true,
    scheduleKind: true,
    scheduleExpr: true,
    everyMs: true,
    timezone: true,
    targetType: true,
    templateCiphertext: true,
    templateVersion: true,
    triggerEventPluginId: true,
    triggerEventLocalId: true,
    triggerSourceSelectorId: true,
    triggerSourceContractVersion: true,
    triggerObservationTransport: true,
    triggerWebhookEndpointId: true,
    triggerObservationStartsAt: true,
    watcherMachineId: true,
    watcherMachineInstallationId: true,
    watcherPluginId: true,
    watcherMaterializationId: true,
    triggerDefinitionEnvelope: true,
    nextRunAt: true,
    lastRunAt: true,
    createdAt: true,
    updatedAt: true,
    assignments: {
        select: {
            machineId: true,
            enabled: true,
            priority: true,
            updatedAt: true,
        },
        orderBy: [{ priority: "desc" }, { machineId: "asc" }],
    },
} satisfies Prisma.AutomationSelect;

export const automationRunItemSelect = {
    id: true,
    automationId: true,
    accountId: true,
    state: true,
    originKind: true,
    originOccurredAt: true,
    occurrenceKey: true,
    occurrenceEvidenceEqualityTag: true,
    originSourceSelectorId: true,
    triggerEvidenceEnvelope: true,
    executionInputEnvelope: true,
    executionDispatchState: true,
    executionAttempt: true,
    executionDispatchCommittedAt: true,
    executionDispatchDueAt: true,
    executionNativeRunId: true,
    executionNativeCallId: true,
    executionNativeSidechainId: true,
    resultEnvelope: true,
    replyContextEnvelope: true,
    replyHandoffActionPluginId: true,
    replyHandoffActionLocalId: true,
    replyHandoffTargetMachineId: true,
    replyHandoffTargetMachineInstallationId: true,
    replyHandoffTargetMaterializationId: true,
    replyHandoffId: true,
    replyHandoffState: true,
    replyHandoffAttempt: true,
    replyHandoffDueAt: true,
    replyHandoffReceiptEnvelope: true,
    scheduledAt: true,
    dueAt: true,
    claimedAt: true,
    startedAt: true,
    finishedAt: true,
    claimedByMachineId: true,
    leaseExpiresAt: true,
    attempt: true,
    revision: true,
    summaryCiphertext: true,
    errorCode: true,
    errorMessage: true,
    producedSessionId: true,
    createdAt: true,
    updatedAt: true,
} as const;

/**
 * The authenticated Run detail additionally reads the committed transition
 * history that lifecycle owners already write. It is the one place a user can
 * ask why a Run behaved the way it did, so the history has a reader instead of
 * only a retention policy. Ordered newest-first and reversed by the projection
 * so a long-lived Run keeps its decision-relevant tail.
 */
export const automationRunDetailSelect = {
    ...automationRunItemSelect,
    events: {
        select: { ts: true, type: true, payload: true },
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        take: AUTOMATION_V3_RUN_DETAIL_MAX_EVENTS,
    },
} satisfies Prisma.AutomationRunSelect;

export const automationRunWithAutomationSelect = {
    ...automationRunItemSelect,
    automation: {
        select: {
            id: true,
            name: true,
            enabled: true,
            targetType: true,
            templateCiphertext: true,
            triggerKind: true,
        },
    },
} as const;
