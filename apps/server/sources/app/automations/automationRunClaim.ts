import type { Tx } from '@/storage/inTx';
import { automationRunWithoutExecutionWhere } from './automationPersistenceSelect';
import { runAssignmentClaimWhere } from './automationRunClaimEligibility';
import type { AutomationTriggerKind } from './automationTypes';

export function expectedRunTriggerCauseWhere(expectedTriggerKind?: AutomationTriggerKind) {
    return expectedTriggerKind
        ? { causeKind: "trigger" as const, causeTriggerKind: expectedTriggerKind }
        : {};
}

/** The shared claim CAS selects one executor before execution or custody refusal. */
export async function tryClaimAutomationRunInTx(params: {
    tx: Tx;
    runId: string;
    previousState: string;
    expectedRunRevision: number;
    executionInputEnvelope: string | null;
    firstFreeze?: Readonly<{ executionInputEnvelope: string; workflowDefinitionEnvelope: string | null }>;
    now: Date;
    machineId: string;
    leaseExpiresAt: Date;
    normalizeNullExecutionDispatchState?: boolean;
    expectedTriggerKind?: AutomationTriggerKind;
}) {
    if (params.previousState === "queued") {
        return await params.tx.automationRun.updateMany({
            where: {
                ...(params.firstFreeze ? { ...automationRunWithoutExecutionWhere, workflowCustodyState: null } : {}),
                id: params.runId,
                state: "queued",
                revision: params.expectedRunRevision,
                executionInputEnvelope: params.executionInputEnvelope,
                ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
                assignments: runAssignmentClaimWhere(params.machineId),
            },
            data: {
                ...(params.firstFreeze ? { executionInputEnvelope: params.firstFreeze.executionInputEnvelope,
                    ...(params.firstFreeze.workflowDefinitionEnvelope !== null ? { workflowCustodyState: "pending" } : {}) } : {}),
                state: "claimed",
                workflowResumeRequestedRevision: null,
                claimedAt: params.now,
                claimedByMachineId: params.machineId,
                leaseExpiresAt: params.leaseExpiresAt,
                attempt: { increment: 1 },
                revision: { increment: 1 },
            },
        });
    }

    const previousState = params.previousState === "pause_requested"
        ? "pause_requested"
        : params.previousState === "running" ? "running" : "claimed";
    return await params.tx.automationRun.updateMany({
        where: {
            ...(params.firstFreeze ? { ...automationRunWithoutExecutionWhere, workflowCustodyState: null } : {}),
            id: params.runId,
            state: previousState,
            leaseExpiresAt: { lt: params.now },
            revision: params.expectedRunRevision,
            executionInputEnvelope: params.executionInputEnvelope,
            ...expectedRunTriggerCauseWhere(params.expectedTriggerKind),
            ...(params.normalizeNullExecutionDispatchState
                ? { executionDispatchState: null }
                : {}),
            assignments: runAssignmentClaimWhere(params.machineId),
        },
        data: {
            ...(params.firstFreeze ? { executionInputEnvelope: params.firstFreeze.executionInputEnvelope,
                ...(params.firstFreeze.workflowDefinitionEnvelope !== null ? { workflowCustodyState: "pending" } : {}) } : {}),
            state: previousState === "pause_requested" ? "pause_requested" : "claimed",
            workflowResumeRequestedRevision: null,
            claimedAt: params.now,
            claimedByMachineId: params.machineId,
            leaseExpiresAt: params.leaseExpiresAt,
            ...(params.normalizeNullExecutionDispatchState
                ? { executionDispatchState: "notStarted" }
                : {}),
            attempt: { increment: 1 },
            revision: { increment: 1 },
        },
    });
}
