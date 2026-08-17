import type { Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";

import {
    isTerminalAutomationRunState,
    type AutomationAssignmentInput,
    type AutomationExecutionDispatchState,
    type AutomationRunOriginKind,
    type AutomationRunState,
    type AutomationTriggerKind,
} from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";
import { isAutomationDefinitionRepresentableInV2 } from "./automationApiProjection";

type AutomationAssignmentWakeRun = Readonly<{
    originKind: AutomationRunOriginKind;
    state: AutomationRunState;
    dueAt: Date;
    leaseExpiresAt: Date | null;
    executionDispatchState: AutomationExecutionDispatchState | null;
}>;

const automationDaemonWakeAutomationSelect = {
    id: true,
    name: true,
    enabled: true,
    triggerKind: true,
    scheduleKind: true,
    scheduleExpr: true,
    everyMs: true,
    timezone: true,
    targetType: true,
    templateCiphertext: true,
    templateVersion: true,
    nextRunAt: true,
    lastRunAt: true,
    updatedAt: true,
    runs: {
        where: {
            OR: [
                { state: "queued" },
                { state: "claimed", leaseExpiresAt: { not: null } },
                { state: "running", leaseExpiresAt: { not: null } },
                { executionDispatchState: "retryWaiting" },
            ],
        },
        select: {
            originKind: true,
            state: true,
            dueAt: true,
            leaseExpiresAt: true,
            executionDispatchState: true,
        },
    },
} satisfies Prisma.AutomationSelect;

/**
 * Canonical durable worker wake projection. It is a minimum of only facts
 * that can make this assignment claimable without relying on a socket hint.
 */
export function resolveAutomationAssignmentNextClaimAt(params: Readonly<{
    nextRunAt: Date | null;
    runs: ReadonlyArray<AutomationAssignmentWakeRun>;
}>): Date | null {
    const candidates: Date[] = [];
    const nextRunAt = params.nextRunAt;
    const nextScheduleIsHeldByLease = nextRunAt !== null && params.runs.some((run) =>
        run.originKind === "scheduled"
        &&
        (run.state === "claimed" || run.state === "running")
        && run.leaseExpiresAt !== null
    );
    if (nextRunAt !== null && !nextScheduleIsHeldByLease) {
        candidates.push(nextRunAt);
    }
    for (const run of params.runs) {
        if (isTerminalAutomationRunState(run.state)) {
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

export async function replaceAutomationAssignmentsTx(params: {
    tx: Tx;
    accountId: string;
    automationId: string;
    assignments: ReadonlyArray<AutomationAssignmentInput>;
}): Promise<Array<{ machineId: string; enabled: boolean; priority: number; updatedAt: Date }>> {
    const deduped = new Map<string, AutomationAssignmentInput>();
    for (const assignment of params.assignments) {
        deduped.set(assignment.machineId, assignment);
    }

    const normalizedAssignments = Array.from(deduped.values());
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
    const now = new Date();
    const [rows, retiredLeaseRuns] = await Promise.all([
        db.automationAssignment.findMany({
            where: {
                machineId: params.machineId,
                enabled: true,
                automation: {
                    accountId: params.accountId,
                    enabled: true,
                    deletedAt: null,
                    ...(params.expectedTriggerKind
                        ? { triggerKind: params.expectedTriggerKind }
                        : {}),
                },
            },
            select: {
                id: true,
                machineId: true,
                enabled: true,
                priority: true,
                updatedAt: true,
                automation: { select: automationDaemonWakeAutomationSelect },
            },
            orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        }),
        db.automationRun.findMany({
            where: {
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                dueAt: { lte: now },
                state: { in: ["claimed", "running"] },
                leaseExpiresAt: { not: null },
                automation: {
                    accountId: params.accountId,
                    ...(params.expectedTriggerKind
                        ? { triggerKind: params.expectedTriggerKind }
                        : {}),
                    OR: [
                        { enabled: false },
                        { deletedAt: { not: null } },
                        {
                            assignments: {
                                none: {
                                    machineId: params.machineId,
                                    enabled: true,
                                },
                            },
                        },
                    ],
                },
            },
            select: {
                id: true,
                originKind: true,
                state: true,
                dueAt: true,
                leaseExpiresAt: true,
                executionDispatchState: true,
                updatedAt: true,
                automation: { select: automationDaemonWakeAutomationSelect },
            },
            orderBy: [{ leaseExpiresAt: "asc" }, { updatedAt: "desc" }],
        }),
    ]);

    const activeAssignments = rows
        .filter((row) => !params.requireV2DefinitionRepresentability
            || isAutomationDefinitionRepresentableInV2(row.automation))
        .map((row) => ({
            ...row,
            nextClaimAt: resolveAutomationAssignmentNextClaimAt({
                nextRunAt: row.automation.nextRunAt,
                runs: row.automation.runs,
            }),
        }));

    // An assignment is ordinarily a current-claim authority. This narrow
    // projection is not: it retains only the incumbent claimant's lease-expiry
    // wake after that authority is retired, so the existing claim transaction
    // can terminalize the durable Run instead of leaving it capacity-counted.
    const retirementWakes = retiredLeaseRuns
        .filter((run) => !params.requireV2DefinitionRepresentability
            || isAutomationDefinitionRepresentableInV2(run.automation))
        .map((run) => {
            const wakeRun: AutomationAssignmentWakeRun = {
                originKind: run.originKind,
                state: run.state,
                dueAt: run.dueAt,
                leaseExpiresAt: run.leaseExpiresAt,
                executionDispatchState: run.executionDispatchState,
            };
            const nextClaimAt = resolveAutomationAssignmentNextClaimAt({
                // Retirement rejects all new work. Only the incumbent lease
                // recovery deadline remains reachable through this row.
                nextRunAt: null,
                runs: [wakeRun],
            });
            return {
                id: run.id,
                machineId: params.machineId,
                enabled: true,
                priority: 0,
                updatedAt: run.updatedAt,
                automation: {
                    ...run.automation,
                    runs: [wakeRun],
                    // Released V2 turns this endpoint's Definition cursor into
                    // its worker wake. The durable Definition is unchanged;
                    // this response-only cursor carries the same lease expiry.
                    ...(params.requireV2DefinitionRepresentability
                        ? { nextRunAt: nextClaimAt }
                        : {}),
                },
                nextClaimAt,
            };
        });

    return [...activeAssignments, ...retirementWakes].sort((left, right) => (
        right.priority - left.priority
        || right.updatedAt.getTime() - left.updatedAt.getTime()
        || left.id.localeCompare(right.id)
    ));
}
