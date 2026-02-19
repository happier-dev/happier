import type { Tx } from "@/storage/inTx";
import { db } from "@/storage/db";

import type { AutomationAssignmentInput } from "./automationTypes";
import { AutomationValidationError } from "./automationValidation";

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
}) {
    return await db.automationAssignment.findMany({
        where: {
            machineId: params.machineId,
            enabled: true,
            automation: {
                accountId: params.accountId,
                enabled: true,
            },
        },
        select: {
            id: true,
            machineId: true,
            enabled: true,
            priority: true,
            updatedAt: true,
            automation: {
                select: {
                    id: true,
                    name: true,
                    enabled: true,
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
                },
            },
        },
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    });
}
