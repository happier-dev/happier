import { persistentMachineWhere } from "@/app/machines/machineSelection";
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { beforeAccountChangePublication } from "@/app/changes/markAccountChanged";
import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

import {
    AUTOMATION_RUN_STATES,
    isAutomationRunState,
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
import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { parseAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';

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
    originKind: true,
    automationId: true,
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
 * schedule cursors and open-Run state — with no private definition envelopes,
 * assignments or trigger
 * status state.
 */
const automationAssignmentWakeTriggerSelect = {
    id: true, kind: true, enabled: true, scheduleKind: true, scheduleExpr: true,
    everyMs: true, timezone: true, nextRunAt: true,
} satisfies Prisma.AutomationTriggerSelect;

function automationDaemonWakeAutomationSelect(
    machineId: string,
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
                originKind: "automation",
                automationId: { not: null },
                causeKind: { not: null },
                state: { in: [...AUTOMATION_RUN_STATES] },
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

async function assertMachineAssignmentsCanBeWritten(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    machineIds: string[];
    requestedEnabledByMachineId: ReadonlyMap<string, boolean>;
}): Promise<(tx: Tx) => Promise<void>> {
    if (params.machineIds.length === 0) return async () => {};

    const readMachines = (tx: Tx) => tx.machine.findMany({
        where: { accountId: params.accountId, id: { in: params.machineIds }, ...persistentMachineWhere },
        select: { id: true, revokedAt: true, replacedByMachineId: true },
    });
    const [rows, existingAssignments] = await Promise.all([
        readMachines(params.tx),
        params.tx.automationAssignment.findMany({
            where: {
                automationId: params.automationId,
                machineId: { in: params.machineIds },
            },
            select: { machineId: true, enabled: true },
        }),
    ]);

    const existingByMachineId = new Map(
        existingAssignments.map((assignment) => [assignment.machineId, assignment] as const),
    );
    const assertAvailable = (machines: typeof rows) => {
        const machinesById = new Map(machines.map((row) => [row.id, row] as const));
        const unknown: string[] = [];
        const unavailable: string[] = [];
        for (const machineId of params.machineIds) {
            const machine = machinesById.get(machineId) ?? null;
            const availability = classifyMachineAvailabilityState(machine);
            if (availability === "available") continue;
            // Missing/permanently revoked authority keeps the public unknown
            // Machine refusal; reversible replacement remains distinct.
            if (availability !== "replaced") {
                unknown.push(machineId);
                continue;
            }
            // Preserve only a genuinely incumbent assignment. The terminal
            // recheck must not mistake this transaction's new rows for incumbents.
            const existing = existingByMachineId.get(machineId);
            if (!existing || (!existing.enabled && params.requestedEnabledByMachineId.get(machineId) === true)) {
                unavailable.push(machineId);
            }
        }
        if (unknown.length > 0) throw new AutomationValidationError(`Unknown machine assignments: ${unknown.join(", ")}`);
        if (unavailable.length > 0) throw new AutomationValidationError(`Unavailable machine assignments: ${unavailable.join(", ")}`);
    };
    assertAvailable(rows);
    return async tx => { assertAvailable(await readMachines(tx)); };
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
    observationOnly?: boolean;
}>): void {
    if (params.observationOnly) {
        if (params.assignments.length > 0) throw new AutomationValidationError("Observation-only Automations have no execution assignments");
        return;
    }
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
    const recheckAdmission = await assertMachineAssignmentsCanBeWritten({
        tx: params.tx,
        accountId: params.accountId,
        automationId: params.automationId,
        machineIds: normalizedAssignments.map((item) => item.machineId),
        requestedEnabledByMachineId: new Map(normalizedAssignments.map((item) => [
            item.machineId,
            item.enabled ?? true,
        ])),
    });
    if (normalizedAssignments.length > 0) {
        beforeAccountChangePublication(params.tx, [params.accountId], async tx => {
            try { await recheckAdmission(tx); }
            catch (error) {
                if (error instanceof AutomationValidationError) {
                    throw new TransactionReplayRequiredError("automation-assignment-admission-changed");
                }
                throw error;
            }
        });
    }

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
                    ),
                },
            },
            orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        }),
        db.automationRunAssignment.findMany({
            where: {
                machineId: params.machineId,
                run: {
                    originKind: "automation",
                    automationId: { not: null },
                    causeKind: { not: null },
                    state: { in: [...AUTOMATION_RUN_STATES] },
                    accountId: params.accountId,
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
        .map((row) => {
            const runs: AutomationAssignmentWakeRun[] = row.automation.runs.map((run) => {
                if (run.causeKind === null || !isAutomationRunState(run.state)) {
                    throw new Error("Stored Automation assignment Run has invalid origin correspondence");
                }
                return {
                    ...run,
                    state: run.state,
                    causeKind: run.causeKind,
                    assignedToMachine: run.assignments.length > 0,
                };
            });
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
        if (
            assignment.run.automationId === null
            || assignment.run.causeKind === null
            || !isAutomationRunState(assignment.run.state)
        ) {
            throw new Error("Stored Automation assignment Run has invalid origin correspondence");
        }
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
        const runs: AutomationAssignmentWakeRun[] = assignments.map((assignment) => {
            if (assignment.run.causeKind === null || !isAutomationRunState(assignment.run.state)) {
                throw new Error("Stored Automation assignment Run has invalid origin correspondence");
            }
            return {
                ...assignment.run,
                state: assignment.run.state,
                causeKind: assignment.run.causeKind,
                assignedToMachine: true,
            };
        });
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
    )).map((assignment) => ({
        ...assignment,
        executionRecipeVersion: parseAutomationStoredWorkflowDefinitionRecipeV2(assignment.automation.templateCiphertext).kind === "available"
            ? 2 as const : null,
    }));
}
