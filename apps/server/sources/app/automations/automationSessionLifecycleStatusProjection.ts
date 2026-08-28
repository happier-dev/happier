import type { AutomationSessionLifecycleTriggerStatus } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";

import { automationPortableQueryChunks } from "./automationPortableQueryChunks";
import { AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS } from "./automationSessionLifecycleTerminalTruth";
import {
    isTerminalAutomationRunState,
    type AutomationListItem,
    type AutomationRunState,
    type AutomationTriggerItem,
} from "./automationTypes";

type SessionLifecycleTrigger = AutomationTriggerItem & Readonly<{
    kind: "sessionLifecycle";
    sessionLifecycleEvent: "parentTurnCompleted";
    sourceSessionId: string;
    sourceTurnId: string;
}>;

function lifecycleTriggers(automations: readonly AutomationListItem[]) {
    return automations.flatMap((automation) => automation.triggers.flatMap((trigger) => (
        trigger.kind === "sessionLifecycle"
        && trigger.sessionLifecycleEvent === "parentTurnCompleted"
        && trigger.sourceSessionId !== null
        && trigger.sourceTurnId !== null
            ? [{ automation, trigger: trigger as SessionLifecycleTrigger }]
            : []
    )));
}

function sourceKey(sessionId: string, turnId: string): string {
    return JSON.stringify([sessionId, turnId]);
}

function triggerRunKey(trigger: SessionLifecycleTrigger): string {
    return JSON.stringify([
        trigger.id,
        trigger.sessionLifecycleEvent,
        trigger.sourceSessionId,
        trigger.sourceTurnId,
    ]);
}

function runKey(run: Readonly<{
    triggerId: string | null;
    causeSessionLifecycleEvent: "parentTurnCompleted" | null;
    causeSourceSessionId: string | null;
    causeSourceTurnId: string | null;
}>): string {
    return JSON.stringify([
        run.triggerId,
        run.causeSessionLifecycleEvent,
        run.causeSourceSessionId,
        run.causeSourceTurnId,
    ]);
}

function admittedStatus(
    run: Readonly<{ id: string; state: AutomationRunState }>,
): AutomationSessionLifecycleTriggerStatus {
    if (isTerminalAutomationRunState(run.state)) return { state: "finished", runId: run.id };
    return run.state === "running"
        ? { state: "running", runId: run.id }
        : { state: "triggered", runId: run.id };
}

/** Batch-derived exact-turn status with no independent consumption state. */
export async function loadAutomationSessionLifecycleStatusProjections(params: Readonly<{
    automations: readonly AutomationListItem[];
    tx?: Tx;
}>): Promise<ReadonlyMap<string, ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus>>> {
    const client = params.tx ?? db;
    const candidates = lifecycleTriggers(params.automations);
    const result = new Map<string, Map<string, AutomationSessionLifecycleTriggerStatus>>();
    for (const automation of params.automations) result.set(automation.id, new Map());
    if (candidates.length === 0) return result;

    const [turnPages, receiptPages, runPages] = await Promise.all([
        Promise.all(automationPortableQueryChunks({ values: candidates, bindingsPerValue: 2 })
            .map((page) => client.sessionTurn.findMany({
                where: { OR: page.map(({ trigger }) => ({
                    sessionId: trigger.sourceSessionId,
                    turnId: trigger.sourceTurnId,
                })) },
                select: { sessionId: true, turnId: true, status: true },
            }))),
        Promise.all(automationPortableQueryChunks({
            values: candidates,
            bindingsPerValue: 2,
            fixedBindings: 4,
        }).map((page) => client.sessionTurnMutationReceipt.findMany({
            where: {
                action: { in: [...AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS] },
                decision: "applied",
                OR: page.map(({ trigger }) => ({
                    sessionId: trigger.sourceSessionId,
                    turnId: trigger.sourceTurnId,
                })),
            },
            select: { id: true, sessionId: true, turnId: true, action: true },
            orderBy: [{ appliedAt: "asc" }, { id: "asc" }],
        }))),
        Promise.all(automationPortableQueryChunks({
            values: candidates,
            bindingsPerValue: 4,
            fixedBindings: 2,
        }).map((page) => client.automationRun.findMany({
            where: {
                causeKind: "trigger",
                causeTriggerKind: "sessionLifecycle",
                OR: page.map(({ trigger }) => ({
                    triggerId: trigger.id,
                    causeSessionLifecycleEvent: trigger.sessionLifecycleEvent,
                    causeSourceSessionId: trigger.sourceSessionId,
                    causeSourceTurnId: trigger.sourceTurnId,
                })),
            },
            select: {
                id: true,
                state: true,
                triggerId: true,
                causeSessionLifecycleEvent: true,
                causeSourceSessionId: true,
                causeSourceTurnId: true,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }))),
    ]);
    const turnByKey = new Map(turnPages.flat().map((turn) => [
        sourceKey(turn.sessionId, turn.turnId),
        turn.status,
    ]));
    const runByKey = new Map<string, (typeof runPages)[number][number]>();
    for (const run of runPages.flat()) {
        const key = runKey(run);
        if (!runByKey.has(key)) runByKey.set(key, run);
    }
    const receiptStatusBySource = new Map<string, AutomationSessionLifecycleTriggerStatus>();
    for (const receipt of receiptPages.flat()) {
        if (receipt.turnId === null) continue;
        const status = receipt.action === "fail"
            ? { state: "sourceFailed", runId: null } as const
            : { state: "sourceCancelled", runId: null } as const;
        const key = sourceKey(receipt.sessionId, receipt.turnId);
        if (!receiptStatusBySource.has(key)) receiptStatusBySource.set(key, status);
    }

    for (const { automation, trigger } of candidates) {
        const perTrigger = result.get(automation.id)!;
        const run = runByKey.get(triggerRunKey(trigger));
        if (run) {
            perTrigger.set(trigger.id, admittedStatus(run));
            continue;
        }
        const key = sourceKey(trigger.sourceSessionId, trigger.sourceTurnId);
        const receiptStatus = receiptStatusBySource.get(key);
        if (receiptStatus) {
            perTrigger.set(trigger.id, receiptStatus);
            continue;
        }
        const turnStatus = turnByKey.get(key);
        if (turnStatus === "failed") perTrigger.set(trigger.id, { state: "sourceFailed", runId: null });
        else if (turnStatus === "cancelled") perTrigger.set(trigger.id, { state: "sourceCancelled", runId: null });
        else if (turnStatus === "completed") perTrigger.set(trigger.id, { state: "finished", runId: null });
        else if (turnStatus === "in_progress") {
            perTrigger.set(trigger.id, !automation.enabled || !trigger.enabled
                ? { state: "paused", runId: null }
                : { state: "waiting", runId: null });
        } else perTrigger.set(trigger.id, { state: "sourceUnavailable", runId: null });
    }
    return result;
}
