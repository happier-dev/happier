import type { AutomationSessionLifecycleTriggerStatus } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import type { AutomationRun as StoredAutomationRun } from '@prisma/client';

import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { AutomationRunState as StoredAutomationRunState, getDbProviderFromEnv, prismaRuntime } from "@/storage/prisma";
import { workflowRunSqlIdentifier } from "@/app/workflows/workflowRunAttention";

import { portableQueryChunks as automationPortableQueryChunks } from "@/storage/portableQueryChunks";
import { AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS } from "./automationSessionLifecycleTerminalTruth";
import { decodeAutomationSessionLifecycleConfiguration } from "./automationSessionLifecycleConfigurationCodec";
import {
    projectAutomationRunState,
    isTerminalAutomationRunState,
    type AutomationTriggerSummarySource,
    type AutomationRunState,
    type AutomationTriggerItem,
} from "./automationTypes";

type SessionLifecycleTrigger = AutomationTriggerItem & Readonly<{
    kind: "sessionLifecycle";
}>;

type LifecycleStatusRun = Pick<StoredAutomationRun,
    "id" | "state" | "triggerId" | "causeSessionLifecycleEvent" | "causeSourceSessionId" | "causeSourceTurnId"
>;

function lifecycleTriggers(automations: readonly AutomationTriggerSummarySource[]) {
    return automations.flatMap((automation) => automation.triggers.flatMap((trigger) => (
        trigger.kind === "sessionLifecycle"
            ? [{
                automation,
                trigger: trigger as SessionLifecycleTrigger,
                stored: decodeAutomationSessionLifecycleConfiguration(trigger),
            }]
            : []
    )));
}

function sourceKey(sessionId: string, turnId: string): string {
    return JSON.stringify([sessionId, turnId]);
}

function admittedStatus(
    run: Readonly<{ id: string; state: AutomationRunState }>,
): AutomationSessionLifecycleTriggerStatus {
    if (isTerminalAutomationRunState(run.state)) return { state: "finished", runId: run.id };
    return run.state === "running"
        ? { state: "running", runId: run.id }
        : { state: "triggered", runId: run.id };
}

/** Batch-derived lifecycle status from the source facts, budget, and latest immutable Run. */
export async function loadAutomationSessionLifecycleStatusProjections(params: Readonly<{
    automations: readonly AutomationTriggerSummarySource[];
    tx?: Tx;
}>): Promise<ReadonlyMap<string, ReadonlyMap<string, AutomationSessionLifecycleTriggerStatus>>> {
    const client = params.tx ?? db;
    const candidates = lifecycleTriggers(params.automations);
    const result = new Map<string, Map<string, AutomationSessionLifecycleTriggerStatus>>();
    for (const automation of params.automations) result.set(automation.id, new Map());
    if (candidates.length === 0) return result;

    const currentTurnCandidates = candidates.filter(({ stored }) => (
        stored.definition.policy.kind === "currentTurn"
    ));
    const sourceSessionIds = [...new Set(candidates.map(({ stored }) => (
        stored.definition.sourceSessionId
    )))];
    const id = workflowRunSqlIdentifier;
    const textType = prismaRuntime.raw(getDbProviderFromEnv(process.env, "postgres") === "mysql" ? "CHAR" : "TEXT");
    const applicableRunStates = Object.values(StoredAutomationRunState)
        .filter((state) => projectAutomationRunState(state) !== null);
    const [sessionPages, turnPages, receiptPages, runPages] = await Promise.all([
        Promise.all(automationPortableQueryChunks({ values: sourceSessionIds, bindingsPerValue: 1 })
            .map((page) => client.session.findMany({
                where: { id: { in: [...page] } },
                select: { id: true },
            }))),
        Promise.all(automationPortableQueryChunks({ values: currentTurnCandidates, bindingsPerValue: 2 })
            .map((page) => client.sessionTurn.findMany({
                where: { OR: page.map(({ stored }) => ({
                    sessionId: stored.definition.sourceSessionId,
                    turnId: stored.definition.policy.kind === "currentTurn"
                        ? stored.definition.policy.sourceTurnId
                        : "",
                })) },
                select: { sessionId: true, turnId: true, status: true },
            }))),
        Promise.all(automationPortableQueryChunks({
            values: currentTurnCandidates,
            bindingsPerValue: 2,
            fixedBindings: 4,
        }).map((page) => client.sessionTurnMutationReceipt.findMany({
            where: {
                action: { in: [...AUTOMATION_SESSION_LIFECYCLE_TERMINAL_NO_RUN_ACTIONS] },
                decision: "applied",
                OR: page.map(({ stored }) => ({
                    sessionId: stored.definition.sourceSessionId,
                    turnId: stored.definition.policy.kind === "currentTurn"
                        ? stored.definition.policy.sourceTurnId
                        : "",
                })),
            },
            select: { id: true, sessionId: true, turnId: true, action: true },
            orderBy: [{ appliedAt: "asc" }, { id: "asc" }],
        }))),
        Promise.all(automationPortableQueryChunks({
            values: candidates, bindingsPerValue: 3, fixedBindings: applicableRunStates.length,
        }).map((page) => client.$queryRaw<LifecycleStatusRun[]>(prismaRuntime.sql`
            SELECT ${id("id")}, ${id("state")}, ${id("triggerId")}, ${id("causeSessionLifecycleEvent")},
                ${id("causeSourceSessionId")}, ${id("causeSourceTurnId")}
            FROM (
                SELECT r.${id("id")}, r.${id("state")}, r.${id("triggerId")}, r.${id("causeSessionLifecycleEvent")},
                    r.${id("causeSourceSessionId")}, r.${id("causeSourceTurnId")},
                    ROW_NUMBER() OVER (PARTITION BY r.${id("triggerId")}
                        ORDER BY r.${id("createdAt")} DESC, r.${id("id")} DESC) AS ${id("lifecycleStatusRank")}
                FROM ${id("AutomationRun")} r
                WHERE r.${id("causeKind")} = 'trigger' AND r.${id("causeTriggerKind")} = 'sessionLifecycle'
                    AND CAST(r.${id("state")} AS ${textType}) IN (${prismaRuntime.join(applicableRunStates)})
                    AND (${prismaRuntime.join(page.map(({ trigger, stored }) => (
                        stored.definition.policy.kind === "currentTurn"
                            ? prismaRuntime.sql`(r.${id("triggerId")} = ${trigger.id}
                                AND r.${id("causeSourceSessionId")} = ${stored.definition.sourceSessionId}
                                AND r.${id("causeSourceTurnId")} = ${stored.definition.policy.sourceTurnId})`
                            : prismaRuntime.sql`r.${id("triggerId")} = ${trigger.id}`
                    )), " OR ")})
            ) ranked
            WHERE ranked.${id("lifecycleStatusRank")} = 1
        `))),
    ]);

    const existingSessions = new Set(sessionPages.flat().map((session) => session.id));
    const turnByKey = new Map(turnPages.flat().map((turn) => [
        sourceKey(turn.sessionId, turn.turnId),
        turn.status,
    ]));
    type LegacyLifecycleRun = Omit<(typeof runPages)[number][number], "state"> & Readonly<{
        state: AutomationRunState;
    }>;
    const latestRunByTrigger = new Map<string, LegacyLifecycleRun>();
    for (const run of runPages.flat()) {
        const state = projectAutomationRunState(run.state);
        if (
            state !== null
            && run.triggerId !== null
        ) {
            latestRunByTrigger.set(run.triggerId, { ...run, state });
        }
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

    for (const { automation, trigger, stored } of candidates) {
        const perTrigger = result.get(automation.id)!;
        const definition = stored.definition;
        const latestRun = latestRunByTrigger.get(trigger.id);
        // An exact-turn trigger has exactly one occurrence, so its status may
        // only report a Run the current registration produced. The Run's
        // stored trigger revision cannot decide that: every trigger write
        // advances it, including the pause/resume and unrelated editor saves
        // that keep the registration and its produced Run. The canonical
        // registration facts are the ones the trigger writer itself uses — a
        // semantic edit restarts the occurrence budget and may reselect the
        // Event set, while every other edit preserves both.
        const boundRun = definition.policy.kind !== "currentTurn"
            ? latestRun
            : latestRun
                && stored.remainingOccurrences === 0
                && latestRun.causeSourceSessionId === definition.sourceSessionId
                && latestRun.causeSourceTurnId === definition.policy.sourceTurnId
                && definition.events.some((event) => event === latestRun.causeSessionLifecycleEvent)
                ? latestRun
                : undefined;
        if (boundRun && !isTerminalAutomationRunState(boundRun.state)) {
            perTrigger.set(trigger.id, admittedStatus(boundRun));
            continue;
        }
        if (!existingSessions.has(definition.sourceSessionId)) {
            perTrigger.set(trigger.id, { state: "sourceUnavailable", runId: null });
            continue;
        }
        if (definition.policy.kind === "currentTurn") {
            const key = sourceKey(definition.sourceSessionId, definition.policy.sourceTurnId);
            // An admitted Run for this exact source turn is the genuine
            // outcome of the occurrence the trigger selected. Terminal source
            // truth describes the turn, not the Run, so it must not replace a
            // Run this trigger really produced from that same failure or
            // cancellation.
            if (boundRun) {
                perTrigger.set(trigger.id, admittedStatus(boundRun));
                continue;
            }
            const receiptStatus = receiptStatusBySource.get(key);
            if (receiptStatus) {
                perTrigger.set(trigger.id, receiptStatus);
                continue;
            }
            const turnStatus = turnByKey.get(key);
            if (turnStatus === "failed") perTrigger.set(trigger.id, { state: "sourceFailed", runId: null });
            else if (turnStatus === "cancelled") perTrigger.set(trigger.id, { state: "sourceCancelled", runId: null });
            else if (turnStatus === "completed") {
                // Any Run this registration produced was already reported
                // above, so a completed turn reaching here finished without
                // one: the trigger was inert, disabled, or its Event
                // unselected at settlement.
                perTrigger.set(trigger.id, { state: "finished", runId: null });
            } else if (turnStatus === "in_progress") {
                perTrigger.set(trigger.id, !automation.enabled || !trigger.enabled
                    ? { state: "paused", runId: null }
                    : { state: "waiting", runId: null });
            } else perTrigger.set(trigger.id, { state: "sourceUnavailable", runId: null });
            continue;
        }
        if (stored.remainingOccurrences === 0) {
            perTrigger.set(trigger.id, { state: "finished", runId: latestRun?.id ?? null });
        } else if (!automation.enabled || !trigger.enabled) {
            perTrigger.set(trigger.id, { state: "paused", runId: null });
        } else {
            perTrigger.set(trigger.id, { state: "waiting", runId: null });
        }
    }
    return result;
}
