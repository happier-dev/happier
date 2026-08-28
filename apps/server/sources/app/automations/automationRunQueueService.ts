import {
    deriveAutomationOccurrenceKeyV1,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { afterTx } from "@/storage/inTx";

import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { computeNextDueAtForAutomation } from "./automationSchedulingService";
import type { AutomationRunItem, AutomationScheduleKind } from "./automationTypes";
import { AUTOMATION_RUN_TERMINAL_STATES, isTerminalAutomationRunState } from "./automationTypes";
import { emitAutomationScheduleWake } from "./automationScheduleWake";

export function resolveScheduledRunDueAt(params: Readonly<{
    now: Date;
    scheduleKind: AutomationScheduleKind;
    everyMs: number | null;
    scheduleExpr: string | null;
    timezone: string | null;
    nextRunAt: Date | null;
}>): Date | null {
    return computeNextDueAtForAutomation(params);
}

/**
 * Initializes missing schedule cursors without admitting future work. Recipe
 * and assignment bytes remain mutable until the cursor is actually due.
 */
export async function ensureAutomationScheduleCursorsTx(params: Readonly<{
    tx: Tx;
    automationId: string;
    now: Date;
}>): Promise<void> {
    const automation = await params.tx.automation.findUnique({
        where: { id: params.automationId },
        select: {
            id: true, accountId: true, enabled: true, deletedAt: true,
            triggers: {
                where: { kind: "schedule", enabled: true, deletedAt: null },
                select: {
                    id: true, revision: true, scheduleKind: true, scheduleExpr: true,
                    everyMs: true, timezone: true, nextRunAt: true,
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
        },
    });
    if (!automation || !automation.enabled || automation.deletedAt !== null) return;
    let changed = false;
    for (const trigger of automation.triggers) {
        if (trigger.scheduleKind === null || trigger.nextRunAt !== null) continue;
        const dueAt = resolveScheduledRunDueAt({ now: params.now, ...trigger });
        if (!dueAt) continue;
        const updated = await params.tx.automationTrigger.updateMany({
            where: {
                id: trigger.id,
                automationId: automation.id,
                revision: trigger.revision,
                enabled: true,
                deletedAt: null,
                nextRunAt: null,
            },
            data: { nextRunAt: dueAt },
        });
        changed ||= updated.count === 1;
    }
    if (changed) afterTx(params.tx, emitAutomationScheduleWake);
}

/**
 * Admits one exact due cursor through the sole Run admission owner, then
 * advances that cursor with an exact trigger revision/current-cursor CAS.
 */
export async function admitDueAutomationScheduleTriggerTx(params: Readonly<{
    tx: Tx;
    triggerId: string;
    expectedRevision: number;
    expectedNextRunAt: Date;
    now: Date;
}>): Promise<Readonly<{ kind: "admitted" | "rejoined"; run: AutomationRunItem }> | null> {
    const trigger = await params.tx.automationTrigger.findFirst({
        where: {
            id: params.triggerId,
            revision: params.expectedRevision,
            kind: "schedule",
            enabled: true,
            deletedAt: null,
            nextRunAt: params.expectedNextRunAt,
            automation: { enabled: true, deletedAt: null },
        },
        select: {
            id: true, automationId: true, revision: true, scheduleKind: true,
            scheduleExpr: true, everyMs: true, timezone: true, nextRunAt: true,
            automation: { select: { accountId: true } },
        },
    });
    if (!trigger || trigger.scheduleKind === null || trigger.nextRunAt === null) return null;
    const scheduledFor = trigger.nextRunAt.getTime();
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({
        triggerId: trigger.id,
        evidence: { v: 1, kind: "schedule", scheduledFor },
    });
    const open = await params.tx.automationRun.findFirst({
        where: {
            triggerId: trigger.id,
            causeTriggerKind: "schedule",
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
        },
        select: { occurrenceKey: true },
    });
    if (open && open.occurrenceKey !== occurrenceKey) return null;
    const result = await admitAutomationRunTx({
        tx: params.tx,
        accountId: trigger.automation.accountId,
        automationId: trigger.automationId,
        now: params.now,
        cause: {
            kind: "trigger", triggerId: trigger.id, triggerRevision: trigger.revision,
            triggerKind: "schedule", occurrenceKey, occurredAt: scheduledFor,
            evidence: { scheduledFor },
        },
    });
    if (result.kind === "ineligible") return null;
    if (isTerminalAutomationRunState(result.run.state)) {
        await advanceAutomationScheduleCursorAfterTerminalRunTx({
            tx: params.tx,
            run: result.run,
            now: params.now,
        });
    }
    return { kind: result.kind, run: result.run };
}

/** Advances only the exact schedule occurrence that just became terminal. */
export async function advanceAutomationScheduleCursorAfterTerminalRunTx(params: Readonly<{
    tx: Tx;
    run: AutomationRunItem;
    now: Date;
}>): Promise<void> {
    if (
        !isTerminalAutomationRunState(params.run.state)
        || params.run.triggerId === null
        || params.run.causeTriggerKind !== "schedule"
        || params.run.causeTriggerRevision === null
        || params.run.causeScheduledFor === null
    ) return;
    // A cadence edit intentionally invalidates the old cursor CAS, but this
    // terminal fact still releases one-open-per-trigger suppression.
    afterTx(params.tx, emitAutomationScheduleWake);
    const trigger = await params.tx.automationTrigger.findFirst({
        where: {
            id: params.run.triggerId,
            revision: params.run.causeTriggerRevision,
            kind: "schedule",
            nextRunAt: params.run.causeScheduledFor,
        },
        select: {
            id: true, automationId: true, revision: true, enabled: true, deletedAt: true,
            scheduleKind: true, scheduleExpr: true, everyMs: true, timezone: true, nextRunAt: true,
        },
    });
    if (!trigger || trigger.scheduleKind === null || trigger.nextRunAt === null) return;
    const nextRunAt = trigger.enabled && trigger.deletedAt === null
        ? resolveScheduledRunDueAt({ now: params.now, ...trigger })
        : null;
    await params.tx.automationTrigger.updateMany({
        where: {
            id: trigger.id,
            automationId: trigger.automationId,
            revision: trigger.revision,
            nextRunAt: trigger.nextRunAt,
        },
        data: { nextRunAt },
    });
}
