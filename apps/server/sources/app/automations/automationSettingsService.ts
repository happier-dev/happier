import {
    AutomationV3SettingsSchema,
    type AutomationV3Settings,
} from "@happier-dev/protocol";
import type { Prisma } from "@prisma/client";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { emitAutomationAssignmentUpdated } from "@/app/automations/automationChangePublisher";
import { afterTx, inTx } from "@/storage/inTx";
import { db } from "@/storage/db";

const automationSettingsSelect = {
    automationMaxActiveRunsPerMachine: true,
    automationRunRetention: true,
} satisfies Prisma.AccountSelect;

type AutomationSettingsRow = Readonly<{
    automationMaxActiveRunsPerMachine: number;
    automationRunRetention: string;
}>;

function toAutomationSettings(row: AutomationSettingsRow): AutomationV3Settings {
    return AutomationV3SettingsSchema.parse({
        maxActiveRunsPerMachine: row.automationMaxActiveRunsPerMachine,
        runRetention: row.automationRunRetention,
    });
}

/** The one server-readable Account owner for Automation operational policy. */
export async function getAutomationSettings(params: Readonly<{
    accountId: string;
}>): Promise<AutomationV3Settings | null> {
    const row = await db.account.findUnique({
        where: { id: params.accountId },
        select: automationSettingsSelect,
    });
    return row ? toAutomationSettings(row) : null;
}

/**
 * Persists the complete bounded settings record, then reuses the existing
 * machine-scoped assignment invalidation to make every affected worker reread
 * its authoritative assignment projection. The event is a wake only; it does
 * not become a second settings owner.
 */
export async function updateAutomationSettings(params: Readonly<{
    accountId: string;
    settings: AutomationV3Settings;
}>): Promise<AutomationV3Settings | null> {
    const settings = AutomationV3SettingsSchema.parse(params.settings);
    return await inTx(async (tx) => {
        const updated = await tx.account.updateMany({
            where: { id: params.accountId },
            data: {
                automationMaxActiveRunsPerMachine: settings.maxActiveRunsPerMachine,
                automationRunRetention: settings.runRetention,
            },
        });
        if (updated.count !== 1) return null;

        const cursor = await markAccountChanged(tx, {
            accountId: params.accountId,
            kind: "automation",
            entityId: "automation-settings",
        });
        const assignments = await tx.automationAssignment.findMany({
            where: {
                automation: { accountId: params.accountId },
            },
            select: {
                machineId: true,
                automationId: true,
                enabled: true,
                updatedAt: true,
            },
            orderBy: [{ machineId: "asc" }, { automationId: "asc" }],
        });
        const assignmentByMachineId = new Map<string, typeof assignments[number]>();
        for (const assignment of assignments) {
            if (!assignmentByMachineId.has(assignment.machineId)) {
                assignmentByMachineId.set(assignment.machineId, assignment);
            }
        }
        afterTx(tx, () => {
            for (const assignment of assignmentByMachineId.values()) {
                emitAutomationAssignmentUpdated({
                    accountId: params.accountId,
                    machineId: assignment.machineId,
                    automationId: assignment.automationId,
                    enabled: assignment.enabled,
                    cursor,
                    updatedAt: assignment.updatedAt,
                });
            }
        });
        return settings;
    });
}
