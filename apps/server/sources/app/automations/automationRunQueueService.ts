import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';
import type { Prisma } from '@prisma/client';

import { resolveReadableWorkflowRunIdsInTx } from "@/app/workflows/workflowRunAccess";
import { db } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { afterTx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";

import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { computeNextDueAtForAutomation } from "./automationSchedulingService";
import type { AutomationListItem, AutomationRunItem, AutomationScheduleKind } from "./automationTypes";
import { AUTOMATION_RUN_TERMINAL_STATES, isTerminalAutomationRunState } from "./automationTypes";
import { emitAutomationScheduleWake } from "./automationScheduleWake";
import { catchUpAutomationRunLifecycleSourcesTx } from "./automationRunLifecycleAdmission";
import { markSharedWorkflowTriggerSummaryChangedInTx } from "./automationSharedWorkflowSummaries";

function isCanonicalScheduleKind(value: string | null): value is AutomationScheduleKind {
    return value === "cron" || value === "interval" || value === "once";
}

function hasOneOpenScheduleOccurrence(scopeSessionId: string | null): boolean {
    return scopeSessionId === null;
}

function openScheduleOccurrencesWhere(triggerId: Prisma.AutomationRunWhereInput["triggerId"]) {
    return { triggerId, causeTriggerKind: "schedule",
        state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] } } satisfies Prisma.AutomationRunWhereInput;
}

/** Project the same incumbent the queue checks, including after a cadence edit. */
export async function loadAutomationScheduleHolds(
    accountId: string,
    automations: readonly Pick<AutomationListItem, "id" | "enabled" | "scopeSessionId" | "triggers">[],
): Promise<Map<string, NonNullable<AutomationDefinitionDetail["scheduleHolds"]>>> {
    const candidates = new Map<string, string>();
    for (const automation of automations) {
        if (!automation.enabled || !hasOneOpenScheduleOccurrence(automation.scopeSessionId)) continue;
        for (const trigger of automation.triggers) {
            if (trigger.kind === "schedule" && trigger.enabled && trigger.deletedAt === null
                && (trigger.scheduleKind === "cron" || trigger.scheduleKind === "interval") && trigger.nextRunAt !== null) {
                candidates.set(trigger.id, automation.id);
            }
        }
    }
    const runs = (await Promise.all(portableQueryChunks({
        values: [...candidates.keys()], bindingsPerValue: 1, fixedBindings: 1 + AUTOMATION_RUN_TERMINAL_STATES.length,
    }).map(triggerIds => db.automationRun.findMany({
        where: openScheduleOccurrencesWhere({ in: [...triggerIds] }),
        select: { id: true, automationId: true, triggerId: true, accountId: true, state: true,
            sourceArtifactId: true, visibleTeamId: true, workflowCustodyState: true },
    })))).flat().filter(run => run.triggerId !== null && candidates.get(run.triggerId) === run.automationId);
    const readable = await resolveReadableWorkflowRunIdsInTx(db, accountId, runs);
    const byAutomation = new Map<string, NonNullable<AutomationDefinitionDetail["scheduleHolds"]>>();
    for (const run of runs) {
        if (run.automationId === null || run.triggerId === null) continue;
        const holds = byAutomation.get(run.automationId) ?? [];
        holds.push({ triggerId: AutomationTriggerIdSchema.parse(run.triggerId), reason: "open_occurrence",
            ...(readable.has(run.id) ? { runId: run.id, runState: run.state } : {}) });
        byAutomation.set(run.automationId, holds);
    }
    return byAutomation;
}

export function resolveScheduledRunDueAt(params: Readonly<{
    now: Date;
    scheduleKind: AutomationScheduleKind;
    everyMs: number | null;
    scheduleExpr: string | null;
    timezone: string | null;
    nextRunAt: Date | null;
    scheduledAt?: Date | null;
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
    await catchUpAutomationRunLifecycleSourcesTx(params.tx, params.automationId);
    const automation = await params.tx.automation.findUnique({
        where: { id: params.automationId },
        select: {
            id: true, accountId: true, enabled: true, deletedAt: true,
            triggers: {
                where: { kind: "schedule", enabled: true, deletedAt: null },
                select: {
                    id: true, revision: true, scheduleKind: true, scheduleExpr: true,
                    everyMs: true, timezone: true, nextRunAt: true, scheduledAt: true, remainingOccurrences: true,
                },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            },
        },
    });
    if (!automation || !automation.enabled || automation.deletedAt !== null) return;
    let changed = false;
    for (const trigger of automation.triggers) {
        if (!isCanonicalScheduleKind(trigger.scheduleKind) || trigger.nextRunAt !== null) continue;
        if (trigger.scheduleKind === "once" && trigger.remainingOccurrences !== 1) continue;
        // Property narrowing does not survive an object spread, so the live
        // schedule kind is passed explicitly instead of `...trigger`.
        const dueAt = resolveScheduledRunDueAt({
            now: params.now,
            scheduleKind: trigger.scheduleKind,
            everyMs: trigger.everyMs,
            scheduleExpr: trigger.scheduleExpr,
            timezone: trigger.timezone,
            nextRunAt: trigger.nextRunAt,
            scheduledAt: trigger.scheduledAt,
        });
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
            automation: { select: { accountId: true, scopeSessionId: true } },
        },
    });
    if (!trigger || trigger.scheduleKind === null || trigger.nextRunAt === null) return null;
    // The one physical-row to branded trigger-identity boundary for this owner.
    const triggerId = AutomationTriggerIdSchema.parse(trigger.id);
    const scheduledFor = trigger.nextRunAt.getTime();
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({
        triggerId,
        evidence: { v: 1, kind: "schedule", scheduledFor },
    });
    const oneOpen = hasOneOpenScheduleOccurrence(trigger.automation.scopeSessionId);
    const open = oneOpen ? await params.tx.automationRun.findFirst({
        where: { ...openScheduleOccurrencesWhere(trigger.id), automationId: trigger.automationId },
        select: { occurrenceKey: true },
    }) : null;
    if (open && open.occurrenceKey !== occurrenceKey) return null;
    const result = await admitAutomationRunTx({
        tx: params.tx,
        accountId: trigger.automation.accountId,
        automationId: trigger.automationId,
        now: params.now,
        cause: {
            kind: "trigger", triggerId, triggerRevision: trigger.revision,
            triggerKind: "schedule", occurrenceKey, occurredAt: scheduledFor,
            evidence: { scheduledFor },
        },
    });
    if (result.kind === "ineligible") return null;
    if (trigger.scheduleKind === "once" || !oneOpen || isTerminalAutomationRunState(result.run.state)) {
        await advanceAutomationScheduleCursorTx({
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
    if (!isTerminalAutomationRunState(params.run.state)) return;
    await advanceAutomationScheduleCursorTx(params);
}

/** Scoped admission and unscoped terminal settlement share the exact cursor CAS. */
async function advanceAutomationScheduleCursorTx(params: Readonly<{
    tx: Tx;
    run: AutomationRunItem;
    now: Date;
}>): Promise<void> {
    if (
        params.run.triggerId === null
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
    if (!trigger || !isCanonicalScheduleKind(trigger.scheduleKind) || trigger.nextRunAt === null) return;
    // Property narrowing does not survive an object spread, so the live
    // schedule kind is passed explicitly instead of `...trigger`. A disabled
    // or deleted trigger still tombstones its cursor to null below.
    const nextRunAt = trigger.scheduleKind !== "once" && trigger.enabled && trigger.deletedAt === null
        ? resolveScheduledRunDueAt({
            now: params.now,
            scheduleKind: trigger.scheduleKind,
            everyMs: trigger.everyMs,
            scheduleExpr: trigger.scheduleExpr,
            timezone: trigger.timezone,
            nextRunAt: trigger.nextRunAt,
        })
        : null;
    const updated = await params.tx.automationTrigger.updateMany({
        where: {
            id: trigger.id,
            automationId: trigger.automationId,
            revision: trigger.revision,
            nextRunAt: trigger.nextRunAt,
        },
        data: { nextRunAt, ...(trigger.scheduleKind === "once" ? { remainingOccurrences: 0 } : {}) },
    });
    if (updated.count > 0) await markSharedWorkflowTriggerSummaryChangedInTx(params.tx, trigger.automationId);
}
