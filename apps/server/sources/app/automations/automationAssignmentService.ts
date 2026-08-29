import type { Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

import {
    isTerminalAutomationRunState,
    type AutomationAssignmentInput,
    type AutomationExecutionDispatchState,
    type AutomationRunState,
    type AutomationTriggerKind,
} from "./automationTypes";
import {
    AutomationValidationError,
    normalizeAutomationAssignments,
} from "./automationValidation";
import { isAutomationDefinitionRepresentableInV2 } from "./automationApiProjection";
import { RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX } from "./automationStoredContentRead";

type AutomationAssignmentWakeRun = Readonly<{
    triggerId: string | null;
    causeKind: "trigger" | "manual" | "conversation";
    causeTriggerKind: AutomationTriggerKind | null;
    state: AutomationRunState;
    dueAt: Date;
    leaseExpiresAt: Date | null;
    executionDispatchState: AutomationExecutionDispatchState | null;
    /** Omitted only by focused helper callers; persisted projections set it explicitly. */
    assignedToMachine?: boolean;
}>;

const automationAssignmentWakeRunSelect = {
    triggerId: true,
    causeKind: true,
    causeTriggerKind: true,
    state: true,
    dueAt: true,
    leaseExpiresAt: true,
    executionDispatchState: true,
} satisfies Prisma.AutomationRunSelect;

/**
 * The worker wake projection: exactly the scalar facts that decide a wake —
 * schedule cursors, open-Run state, and the released-V2 representability
 * boundary — with no private definition envelopes, assignments, or trigger
 * status state.
 */
const automationAssignmentWakeTriggerSelect = {
    id: true, kind: true, enabled: true, scheduleKind: true, scheduleExpr: true,
    everyMs: true, timezone: true, nextRunAt: true,
} satisfies Prisma.AutomationTriggerSelect;

function automationDaemonWakeAutomationSelect(
    machineId: string,
    requireV2RunRepresentability: boolean,
) {
    return {
        id: true, name: true, enabled: true,
        targetType: true, templateCiphertext: true, templateVersion: true,
        lastRunAt: true, updatedAt: true,
        triggers: {
            where: { deletedAt: null },
            select: automationAssignmentWakeTriggerSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
        runs: {
            where: {
                ...(requireV2RunRepresentability
                    ? { executionInputEnvelope: { startsWith: RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX } }
                    : {}),
                OR: [
                    { state: "queued" },
                    { state: "claimed", leaseExpiresAt: { not: null } },
                    { state: "running", leaseExpiresAt: { not: null } },
                    { executionDispatchState: "retryWaiting" },
                ],
            },
            select: {
                ...automationAssignmentWakeRunSelect,
                assignments: {
                    where: { machineId },
                    select: { machineId: true },
                },
            },
        },
    } satisfies Prisma.AutomationSelect;
}

/**
 * Canonical durable worker wake projection. It is a minimum of only facts
 * that can make this assignment claimable without relying on a socket hint.
 */
export function resolveAutomationAssignmentNextClaimAt(params: Readonly<{
    schedules: ReadonlyArray<{ triggerId: string; nextRunAt: Date | null }>;
    runs: ReadonlyArray<AutomationAssignmentWakeRun>;
}>): Date | null {
    const candidates: Date[] = [];
    const openScheduleTriggerIds = new Set<string>();
    for (const run of params.runs) {
        const triggerId = run.triggerId;
        if (
            triggerId !== null
            && run.causeKind === "trigger"
            && run.causeTriggerKind === "schedule"
            && !isTerminalAutomationRunState(run.state)
        ) {
            openScheduleTriggerIds.add(triggerId);
        }
    }
    for (const schedule of params.schedules) {
        if (schedule.nextRunAt === null) continue;
        if (!openScheduleTriggerIds.has(schedule.triggerId)) candidates.push(schedule.nextRunAt);
    }
    for (const run of params.runs) {
        if (run.assignedToMachine === false || isTerminalAutomationRunState(run.state)) {
            continue;
        }
        // Run lifecycle owns wake authority. A queued retry uses its retry dueAt,
        // while a claimed/running Run must remain dormant until lease recovery,
        // regardless of stale dispatch metadata.
        if (run.state === "queued") {
            candidates.push(run.dueAt);
            continue;
        }
        if (
            (run.state === "claimed" || run.state === "running")
            && run.leaseExpiresAt !== null
        ) {
            // Reclaim uses the strict predicate `leaseExpiresAt < now`. Wake at
            // the first millisecond that is actually eligible to avoid an
            // inert poll at the exact expiry boundary.
            candidates.push(new Date(run.leaseExpiresAt.getTime() + 1));
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    return candidates.reduce((earliest, candidate) =>
        candidate.getTime() < earliest.getTime() ? candidate : earliest,
    );
}

async function assertMachinesBelongToAccount(params: {
    tx: Tx;
    accountId: string;
    machineIds: string[];
}): Promise<void> {
    if (params.machineIds.length === 0) return;

    const rows = await params.tx.machine.findMany({
        where: {
            accountId: params.accountId,
            id: { in: params.machineIds },
            revokedAt: null,
        },
        select: { id: true },
    });

    const known = new Set(rows.map((row) => row.id));
    const missing = params.machineIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
        throw new AutomationValidationError(`Unknown machine assignments: ${missing.join(", ")}`);
    }
}

/**
 * Assignment-liveness invariant, shared by every definition writer. An enabled
 * Automation must own at least one enabled execution assignment: admission
 * freezes the current enabled-assignment set into the Run, so a Run admitted
 * with zero enabled assignments could never be claimed by any machine. A
 * disabled draft may own zero enabled assignments.
 *
 * Callers pass the exact assignment set their transaction is about to persist
 * (or the loaded persisted set). Canonical normalization prevents a repeated
 * machineId from fabricating a second assignment.
 */
export function assertAutomationAssignmentLiveness(params: Readonly<{
    enabled: boolean;
    assignments: ReadonlyArray<Readonly<{ machineId: string; enabled?: boolean }>>;
}>): void {
    if (!params.enabled) return;
    const normalized = normalizeAutomationAssignments(params.assignments) ?? [];
    const hasEnabledAssignment = normalized.some((assignment) => assignment.enabled ?? true);
    if (!hasEnabledAssignment) {
        throw new AutomationValidationError(
            "An enabled Automation requires at least one enabled execution assignment",
        );
    }
}

export async function replaceAutomationAssignmentsTx(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    assignments: ReadonlyArray<AutomationAssignmentInput>;
}): Promise<Array<{ machineId: string; enabled: boolean; priority: number; updatedAt: Date }>> {
    const normalizedAssignments = normalizeAutomationAssignments(params.assignments) ?? [];
    await assertMachinesBelongToAccount({
        tx: params.tx,
        accountId: params.accountId,
        machineIds: normalizedAssignments.map((item) => item.machineId),
    });

    await params.tx.automationAssignment.deleteMany({
        where: { automationId: params.automationId },
    });

    if (normalizedAssignments.length > 0) {
        await params.tx.automationAssignment.createMany({
            data: normalizedAssignments.map((assignment) => ({
                automationId: params.automationId,
                machineId: assignment.machineId,
                enabled: assignment.enabled ?? true,
                priority: assignment.priority ?? 0,
            })),
        });
    }

    const saved = await params.tx.automationAssignment.findMany({
        where: { automationId: params.automationId },
        select: {
            machineId: true,
            enabled: true,
            priority: true,
            updatedAt: true,
        },
        orderBy: [{ priority: "desc" }, { machineId: "asc" }],
    });

    return saved;
}

export async function listDaemonAssignments(params: {
    accountId: string;
    machineId: string;
    expectedTriggerKind?: AutomationTriggerKind;
    requireV2DefinitionRepresentability?: boolean;
}) {
    const [rows, admittedRunAssignments] = await Promise.all([
        db.automationAssignment.findMany({
            where: {
                machineId: params.machineId,
                enabled: true,
                automation: {
                    accountId: params.accountId,
                    enabled: true,
                    deletedAt: null,
                },
            },
            select: {
                id: true,
                machineId: true,
                enabled: true,
                priority: true,
                updatedAt: true,
                automation: {
                    select: automationDaemonWakeAutomationSelect(
                        params.machineId,
                        params.requireV2DefinitionRepresentability === true,
                    ),
                },
            },
            orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        }),
        db.automationRunAssignment.findMany({
            where: {
                machineId: params.machineId,
                run: {
                    accountId: params.accountId,
                    ...(params.requireV2DefinitionRepresentability
                        ? { executionInputEnvelope: { startsWith: RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX } }
                        : {}),
                    OR: [
                        { state: "queued" },
                        { state: "claimed", leaseExpiresAt: { not: null } },
                        { state: "running", leaseExpiresAt: { not: null } },
                        { executionDispatchState: "retryWaiting" },
                    ],
                },
            },
            select: {
                machineId: true,
                priority: true,
                run: {
                    select: {
                        ...automationAssignmentWakeRunSelect,
                        id: true,
                        automationId: true,
                        updatedAt: true,
                    },
                },
            },
            orderBy: [{ priority: "desc" }, { runId: "asc" }],
        }),
    ]);

    const activeAssignments = rows
        .filter((row) => !params.requireV2DefinitionRepresentability
            || isAutomationDefinitionRepresentableInV2(row.automation))
        .map((row) => {
            const runs: AutomationAssignmentWakeRun[] = row.automation.runs.map((run) => ({
                ...run,
                assignedToMachine: run.assignments.length > 0,
            }));
            return {
                ...row,
                automation: { ...row.automation, runs },
                nextClaimAt: resolveAutomationAssignmentNextClaimAt({
                    schedules: row.automation.triggers
                        .filter((trigger) => trigger.kind === "schedule" && trigger.enabled)
                        .map((trigger) => ({ triggerId: trigger.id, nextRunAt: trigger.nextRunAt })),
                    runs,
                }),
            };
        });

    const activeDefinitionIds = new Set(activeAssignments.map((row) => row.automation.id));
    const frozenByAutomationId = new Map<string, typeof admittedRunAssignments>();
    for (const assignment of admittedRunAssignments) {
        if (activeDefinitionIds.has(assignment.run.automationId)) continue;
        const group = frozenByAutomationId.get(assignment.run.automationId);
        if (group) group.push(assignment);
        else frozenByAutomationId.set(assignment.run.automationId, [assignment]);
    }

    // Frozen Run assignments survive definition disable/delete/reassignment.
    // Fetch each remaining Automation wake projection exactly once; nesting
    // that Automation's complete open-Run set under every assigned Run is
    // O(N²).
    const frozenAutomations = frozenByAutomationId.size === 0
        ? []
        : await db.automation.findMany({
            where: {
                id: { in: [...frozenByAutomationId.keys()] },
                accountId: params.accountId,
            },
            select: {
                id: true, name: true, enabled: true,
                targetType: true, templateCiphertext: true, templateVersion: true,
                lastRunAt: true, updatedAt: true,
                triggers: {
                    where: { deletedAt: null },
                    select: automationAssignmentWakeTriggerSelect,
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                },
            },
        });
    const admittedRunWakes: Array<(typeof activeAssignments)[number]> = [];
    for (const automation of frozenAutomations) {
        const assignments = frozenByAutomationId.get(automation.id) ?? [];
        if (assignments.length === 0) continue;
        const representative = assignments.reduce((best, candidate) => (
            candidate.priority > best.priority
            || (candidate.priority === best.priority
                && candidate.run.updatedAt.getTime() > best.run.updatedAt.getTime())
                ? candidate
                : best
        ));
        const runs: AutomationAssignmentWakeRun[] = assignments.map((assignment) => ({
            ...assignment.run,
            assignedToMachine: true,
        }));
        admittedRunWakes.push({
            id: representative.run.id,
            machineId: representative.machineId,
            enabled: true,
            priority: representative.priority,
            updatedAt: representative.run.updatedAt,
            automation: { ...automation, runs },
            nextClaimAt: resolveAutomationAssignmentNextClaimAt({ schedules: [], runs }),
        });
    }

    return [...activeAssignments, ...admittedRunWakes].sort((left, right) => (
        right.priority - left.priority
        || right.updatedAt.getTime() - left.updatedAt.getTime()
        || left.id.localeCompare(right.id)
    ));
}
