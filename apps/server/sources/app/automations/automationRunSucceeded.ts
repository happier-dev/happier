import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { readMachineAvailabilityStateInTx } from "@/app/machines/machineStateGuards";
import { afterTx, type Tx } from "@/storage/inTx";

import { emitAutomationRunTransition, markAutomationRunSummaryChangedTx } from "./automationChangePublisher";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import { decodeAutomationRunCause, projectAutomationOriginRun } from "./automationRunCauseCodec";
import { advanceAutomationScheduleCursorAfterTerminalRunTx } from "./automationRunQueueService";
import { invalidateSessionReviewProjectionForRunInTx } from "./sessionReviewProjectionInvalidation";
import type { AutomationRunItem, AutomationRunState } from "./automationTypes";
import type { Prisma } from '@prisma/client';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { projectAutomationRunState } from './automationTypes';

type AutomationTerminalState = "succeeded" | "failed" | "cancelled" | "outcome_uncertain" | "skipped";

const AUTOMATION_TERMINAL_EVENT_BY_STATE = {
    succeeded: "run_succeeded",
    failed: "run_failed",
    cancelled: "run_cancelled",
    outcome_uncertain: "run_outcome_uncertain",
    skipped: "run_skipped",
} as const satisfies Record<AutomationTerminalState, string>;

/** One non-content failure writer serves preclaim refusal and missing requester custody. */
export async function failAutomationRunWithoutContentInTx(params: Readonly<{
    tx: Tx; accountId: string; runId: string; previousState: WorkflowRunSummaryV1['state'];
    where: Prisma.AutomationRunWhereInput;
    errorCode: string; settleWorkflowCustody: boolean; now: Date;
}>): Promise<Readonly<{ changed: boolean; run: AutomationRunItem | null }>> {
    const previousState = projectAutomationRunState(params.previousState);
    if (previousState === null) throw new Error('Automation Run state is unavailable');
    const changed = await params.tx.automationRun.updateMany({ where: { ...params.where,
        id: params.runId, accountId: params.accountId, state: params.previousState }, data: {
        state: 'failed', finishedAt: params.now, errorCode: params.errorCode, errorMessage: null,
        ...(params.settleWorkflowCustody ? { workflowCustodyState: 'settled' } : {}),
        revision: { increment: 1 }, updatedAt: params.now,
    } });
    if (changed.count !== 1) return { changed: false, run: null };
    const run = await applyAutomationRunTerminalEffectsTx({ tx: params.tx, accountId: params.accountId,
        runId: params.runId, previousState, state: 'failed', now: params.now,
        eventPayload: { errorCode: params.errorCode } });
    return { changed: true, run };
}

/**
 * Applies the incumbent Automation-facing consequences after one physical Run
 * reaches a terminal state. Workflow and one-shot recipes share this owner;
 * direct workflow Runs intentionally bypass it because they have no Automation.
 */
export async function applyAutomationRunTerminalEffectsTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    runId: string;
    previousState: AutomationRunState;
    state: AutomationTerminalState;
    now: Date;
    eventPayload?: Readonly<Record<string, unknown>>;
    prepareWorkflowReplyHandoff?: boolean;
    transitionCause?: Parameters<typeof emitAutomationRunTransition>[0]["transitionCause"];
}>): Promise<AutomationRunItem | null> {
    const stored = await params.tx.automationRun.findFirst({
        where: { id: params.runId, accountId: params.accountId },
        select: automationRunItemSelect,
    });
    let run = stored ? projectAutomationOriginRun(stored) : null;
    if (
        !run
        || run.state !== params.state
    ) return null;

    if (decodeAutomationRunCause(run).kind === "conversation") {
        const awaiting = run.replyHandoffState === "awaitingResult";
        if (awaiting) {
            if (params.state === "succeeded" && params.prepareWorkflowReplyHandoff) {
                if (
                    typeof run.resultEnvelope !== "string"
                    || typeof run.replyContextEnvelope !== "string"
                    || typeof run.replyHandoffActionPluginId !== "string"
                    || typeof run.replyHandoffActionLocalId !== "string"
                    || typeof run.replyHandoffTargetMachineId !== "string"
                    || typeof run.replyHandoffTargetMachineInstallationId !== "string"
                    || typeof run.replyHandoffTargetMaterializationId !== "string"
                    || typeof run.replyHandoffId !== "string"
                ) {
                    throw new Error("Automation workflow reply handoff is invalid");
                }
                const suppressed = await readMachineAvailabilityStateInTx({
                    tx: params.tx,
                    accountId: params.accountId,
                    machineId: run.replyHandoffTargetMachineId,
                }) === "revoked";
                await params.tx.automationRun.update({
                    where: { id: run.id },
                    data: {
                        replyHandoffState: suppressed ? "suppressed" : "ready",
                        replyHandoffDueAt: suppressed ? null : params.now,
                    },
                });
            } else if (params.state !== "succeeded") {
                await params.tx.automationRun.update({
                    where: { id: run.id },
                    data: {
                        replyHandoffState: "blocked",
                        replyHandoffDueAt: null,
                    },
                });
            }
            const reloaded = await params.tx.automationRun.findUniqueOrThrow({
                where: { id: params.runId },
                select: automationRunItemSelect,
            });
            run = projectAutomationOriginRun(reloaded);
            if (!run) throw new Error("Automation Run has invalid origin correspondence");
        }
    }

    await params.tx.automationRunEvent.create({
        data: {
            runId: run.id,
            ts: params.now,
            type: AUTOMATION_TERMINAL_EVENT_BY_STATE[params.state],
            payload: params.eventPayload ?? null,
        },
    });
    await advanceAutomationScheduleCursorAfterTerminalRunTx({
        tx: params.tx,
        run: run as AutomationRunItem,
        now: params.now,
    });
    await invalidateSessionReviewProjectionForRunInTx(params.tx, run);
    // Initialized Workflows publish through their transition owner. A refusal
    // before that handoff still needs to refresh the same canonical History row.
    if (run.workflowAcceptedSnapshotEnvelope === null) {
        await markAccountChanged(params.tx, {
            accountId: params.accountId, kind: "account", entityId: `workflow-run:${run.id}`,
        });
    }
    const cursor = await markAutomationRunSummaryChangedTx(params.tx, {
        accountId: params.accountId,
        automationId: run.automationId,
        runId: run.id,
    });
    afterTx(params.tx, () => {
        emitAutomationRunTransition({
            accountId: params.accountId,
            run: run as AutomationRunItem,
            previousState: params.previousState,
            cursor: cursor.resolveCursor(),
            ...(params.transitionCause ? { transitionCause: params.transitionCause } : {}),
        });
    });
    return run as AutomationRunItem;
}
