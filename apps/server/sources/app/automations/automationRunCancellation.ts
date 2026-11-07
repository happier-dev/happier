import type { Prisma } from "@prisma/client";
import { AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1, AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import type { Tx } from "@/storage/inTx";
import { retireAutomationPendingInputInTx } from "@/app/session/pending/pendingMessageService";
import { automationRunCauseSelect } from "./automationPersistenceSelect";
import { retainedV2OriginKindForRun } from "./automationRunCauseCodec";
import { applyAutomationRunTerminalEffectsTx } from "./automationRunSucceeded";
import { resolveAutomationPendingInputSessionIdTx } from "./automationRunSessionTarget";

/** Only the fields the pre-Workflow-custody cancellation transition consumes. */
export const automationRunCancellationSelect = {
    ...automationRunCauseSelect,
    id: true, automationId: true, state: true, revision: true,
    executionDispatchState: true, executionInputEnvelope: true,
} satisfies Prisma.AutomationRunSelect;

type CancellationRun = Prisma.AutomationRunGetPayload<{ select: typeof automationRunCancellationSelect }>
    & Readonly<{ automationId: string }>;

/**
 * Pre-Workflow-custody row transition used by the canonical Workflow cancel owner.
 * Its caller owns the Account encryption fence; terminal consequences stay with
 * the shared terminal-effects owner.
 */
export async function cancelAutomationRunRowTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    previousRun: CancellationRun;
    accountEncryptionMode: "plain" | "e2ee";
    /** Explicit per-Run Stop, rather than permanent target loss. */
    presentUserCancellation: boolean;
}>) {
    const { previousRun } = params;
    if (previousRun.state !== "queued" && previousRun.state !== "claimed" && previousRun.state !== "running") return null;
    const now = new Date();
    // Dispatch permission or an observed running target means accepted external
    // work may still exist. Stop remains authoritative without claiming it vanished.
    const dispatchPermitted = previousRun.executionDispatchState === "dispatchPermitted";
    const outcomeUncertain = dispatchPermitted || previousRun.state === "running";
    const terminalState = outcomeUncertain ? "outcome_uncertain" : "cancelled";
    const sessionTargetRunningCancellation = params.presentUserCancellation
        && !dispatchPermitted && previousRun.state === "running" && previousRun.executionDispatchState === null;
    const updated = await params.tx.automationRun.updateMany({
        where: {
            id: previousRun.id, accountId: params.accountId, state: previousRun.state,
            revision: previousRun.revision, executionDispatchState: previousRun.executionDispatchState,
        },
        data: {
            state: terminalState,
            ...(outcomeUncertain ? {
                executionDispatchState: previousRun.executionDispatchState === null ? null : "outcomeUnknown",
                executionDispatchDueAt: null,
                errorCode: dispatchPermitted ? "execution_run_cancelled_outcome_unknown" : "execution_run_outcome_unknown",
            } : {}),
            finishedAt: now, revision: { increment: 1 }, updatedAt: now,
        },
    });
    if (updated.count !== 1) return null;
    if (params.presentUserCancellation && outcomeUncertain) {
        const sessionId = await resolveAutomationPendingInputSessionIdTx({
            tx: params.tx, accountId: params.accountId, automationId: previousRun.automationId,
            runId: previousRun.id, executionInputEnvelope: previousRun.executionInputEnvelope,
            accountEncryptionMode: params.accountEncryptionMode,
            retainedV2OriginKind: retainedV2OriginKindForRun(previousRun),
        });
        if (sessionId !== null) await retireAutomationPendingInputInTx({
            tx: params.tx, accountId: params.accountId, sessionId, runId: previousRun.id,
        });
    }
    return applyAutomationRunTerminalEffectsTx({
        tx: params.tx, accountId: params.accountId, runId: previousRun.id,
        previousState: previousRun.state, state: terminalState, now,
        ...(dispatchPermitted
            ? { eventPayload: { reason: "cancelled_after_dispatch_permitted" },
                transitionCause: AUTOMATION_RUN_CANCELLED_AFTER_DISPATCH_PERMITTED_CAUSE_V1 }
            : outcomeUncertain
                ? { eventPayload: { reason: "cancelled_while_running" },
                    ...(sessionTargetRunningCancellation
                        ? { transitionCause: AUTOMATION_RUN_CANCELLED_WHILE_RUNNING_CAUSE_V1 } : {}) }
                : {}),
    });
}
