import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

import { emitAutomationAssignmentUpdated, emitAutomationDelete, emitAutomationRunUpdated, emitAutomationUpsert } from "./automationChangePublisher";
import { replaceAutomationAssignmentsTx } from "./automationAssignmentService";
import { enqueueImmediateRunTx, enqueueNextScheduledRunIfMissingTx, resolveScheduledRunDueAt } from "./automationRunQueueService";
import { validateExistingSessionAutomationTargetTx } from "./automationExistingSessionValidation";
import type { AutomationListItem, AutomationPatchInput, AutomationRunItem, AutomationScheduleInput, AutomationUpsertInput } from "./automationTypes";

function resolveScheduleDbFields(schedule: AutomationScheduleInput): Readonly<{
    scheduleKind: "cron" | "interval";
    scheduleExpr: string | null;
    everyMs: number | null;
    timezone: string | null;
}> {
    if (schedule.kind === "interval") {
        return {
            scheduleKind: "interval",
            scheduleExpr: null,
            everyMs: schedule.everyMs,
            timezone: schedule.timezone ?? null,
        };
    }
    return {
        scheduleKind: "cron",
        scheduleExpr: schedule.scheduleExpr,
        everyMs: null,
        timezone: schedule.timezone ?? null,
    };
}

async function loadAutomationTx(tx: Tx, params: { accountId: string; automationId: string }): Promise<AutomationListItem | null> {
    const row = await tx.automation.findFirst({
        where: {
            id: params.automationId,
            accountId: params.accountId,
        },
        select: {
            id: true,
            accountId: true,
            name: true,
            description: true,
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
            createdAt: true,
            updatedAt: true,
            assignments: {
                select: {
                    machineId: true,
                    enabled: true,
                    priority: true,
                    updatedAt: true,
                },
                orderBy: [{ priority: "desc" }, { machineId: "asc" }],
            },
        },
    });

    if (!row) return null;
    return row as AutomationListItem;
}

async function markAutomationChangedTx(tx: Tx, params: { accountId: string; automationId: string }): Promise<number> {
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: params.automationId,
    });
}

function emitAssignmentUpdates(params: {
    accountId: string;
    automationId: string;
    cursor: number;
    assignments: ReadonlyArray<{ machineId: string; enabled: boolean; updatedAt?: Date }>;
}): void {
    for (const assignment of params.assignments) {
        emitAutomationAssignmentUpdated({
            accountId: params.accountId,
            machineId: assignment.machineId,
            automationId: params.automationId,
            enabled: assignment.enabled,
            cursor: params.cursor,
            updatedAt: assignment.updatedAt ?? new Date(),
        });
    }
}

export async function listAutomations(params: { accountId: string }): Promise<AutomationListItem[]> {
    const rows = await db.automation.findMany({
        where: { accountId: params.accountId },
        select: {
            id: true,
            accountId: true,
            name: true,
            description: true,
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
            createdAt: true,
            updatedAt: true,
            assignments: {
                select: {
                    machineId: true,
                    enabled: true,
                    priority: true,
                    updatedAt: true,
                },
                orderBy: [{ priority: "desc" }, { machineId: "asc" }],
            },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });

    return rows as AutomationListItem[];
}

export async function getAutomation(params: { accountId: string; automationId: string }): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        return await loadAutomationTx(tx, params);
    });
}

export async function createAutomation(params: {
    accountId: string;
    input: AutomationUpsertInput;
}): Promise<AutomationListItem> {
    return await inTx(async (tx) => {
        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: params.input.targetType,
            templateCiphertext: params.input.templateCiphertext,
        });

        const now = new Date();
        const scheduleFields = resolveScheduleDbFields(params.input.schedule);
        const created = await tx.automation.create({
            data: {
                accountId: params.accountId,
                name: params.input.name,
                description: params.input.description ?? null,
                enabled: params.input.enabled,
                scheduleKind: scheduleFields.scheduleKind,
                scheduleExpr: scheduleFields.scheduleExpr,
                everyMs: scheduleFields.everyMs,
                timezone: scheduleFields.timezone,
                targetType: params.input.targetType,
                templateCiphertext: params.input.templateCiphertext,
                templateVersion: 1,
            },
            select: { id: true },
        });

        const assignments = await replaceAutomationAssignmentsTx({
            tx,
            accountId: params.accountId,
            automationId: created.id,
            assignments: params.input.assignments ?? [],
        });

        const queued = params.input.enabled
            ? await enqueueNextScheduledRunIfMissingTx({ tx, automationId: created.id, now })
            : null;

        const automation = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: created.id,
        });
        if (!automation) {
            throw new Error("Failed to load created automation");
        }

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: created.id,
        });

        afterTx(tx, () => {
            emitAutomationUpsert({ accountId: params.accountId, automation, cursor });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: automation.id,
                cursor,
                assignments,
            });
            if (queued) {
                emitAutomationRunUpdated({
                    accountId: params.accountId,
                    run: queued,
                    cursor,
                });
            }
        });

        return automation;
    });
}

export async function updateAutomation(params: {
    accountId: string;
    automationId: string;
    input: AutomationPatchInput;
}): Promise<AutomationListItem | null> {
    return await inTx(async (tx) => {
        const existing = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: params.automationId,
        });
        if (!existing) {
            return null;
        }

        const effectiveTargetType = params.input.targetType ?? existing.targetType;
        const effectiveTemplateCiphertext = params.input.templateCiphertext ?? existing.templateCiphertext;
        await validateExistingSessionAutomationTargetTx({
            tx,
            accountId: params.accountId,
            targetType: effectiveTargetType,
            templateCiphertext: effectiveTemplateCiphertext,
        });

        const schedule = params.input.schedule;
        const scheduleFields = schedule ? resolveScheduleDbFields(schedule) : null;
        const templateCiphertextChanged =
            typeof params.input.templateCiphertext === "string"
            && params.input.templateCiphertext !== existing.templateCiphertext;

        await tx.automation.update({
            where: { id: existing.id },
            data: {
                ...(typeof params.input.name === "string" ? { name: params.input.name } : {}),
                ...(params.input.description !== undefined ? { description: params.input.description ?? null } : {}),
                ...(typeof params.input.enabled === "boolean" ? { enabled: params.input.enabled } : {}),
                ...(schedule
                    ? {
                        scheduleKind: scheduleFields!.scheduleKind,
                        scheduleExpr: scheduleFields!.scheduleExpr,
                        everyMs: scheduleFields!.everyMs,
                        timezone: scheduleFields!.timezone,
                    }
                    : {}),
                ...(params.input.targetType ? { targetType: params.input.targetType } : {}),
                ...(typeof params.input.templateCiphertext === "string"
                    ? {
                        templateCiphertext: params.input.templateCiphertext,
                        templateVersion: { increment: 1 },
                    }
                    : {}),
                ...(templateCiphertextChanged ? { nextRunAt: null } : {}),
                ...(params.input.enabled === false ? { nextRunAt: null } : {}),
            },
        });

        // Pausing an automation should prevent already-scheduled queued runs from executing.
        // Claimed/running runs are left intact so in-flight work can complete safely.
        if (params.input.enabled === false) {
            await tx.automationRun.deleteMany({
                where: {
                    automationId: existing.id,
                    state: "queued",
                },
            });
        }

        let assignmentRows = existing.assignments;
        if (params.input.assignments) {
            assignmentRows = await replaceAutomationAssignmentsTx({
                tx,
                accountId: params.accountId,
                automationId: existing.id,
                assignments: params.input.assignments,
            });
        }

        const now = new Date();

        // If the schedule changes while there is still a queued scheduled run, update its dueAt so
        // "next run" reflects the new schedule immediately. (Leave immediate run-now runs intact.)
        if (schedule && params.input.enabled !== false) {
            const nextDueAt = resolveScheduledRunDueAt({
                now,
                scheduleKind: scheduleFields!.scheduleKind,
                everyMs: scheduleFields!.everyMs,
                scheduleExpr: scheduleFields!.scheduleExpr,
                timezone: scheduleFields!.timezone,
                nextRunAt: existing.nextRunAt,
            });

            if (nextDueAt) {
                const scheduledQueued = await tx.automationRun.findFirst({
                    where: {
                        automationId: existing.id,
                        state: "queued",
                        dueAt: { gt: now },
                    },
                    orderBy: [{ dueAt: "desc" }, { createdAt: "desc" }],
                    select: { id: true },
                });
                if (scheduledQueued) {
                    await tx.automationRun.update({
                        where: { id: scheduledQueued.id },
                        data: { dueAt: nextDueAt, updatedAt: now },
                    });
                }

                await tx.automation.update({
                    where: { id: existing.id },
                    data: { nextRunAt: nextDueAt },
                });
            } else {
                await tx.automation.update({
                    where: { id: existing.id },
                    data: { nextRunAt: null },
                });
                await tx.automationRun.deleteMany({
                    where: {
                        automationId: existing.id,
                        state: "queued",
                        dueAt: { gt: now },
                    },
                });
            }
        }

        const nextRun = await enqueueNextScheduledRunIfMissingTx({
            tx,
            automationId: existing.id,
            now,
        });

        const updated = await loadAutomationTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });
        if (!updated) {
            return null;
        }

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });

        afterTx(tx, () => {
            emitAutomationUpsert({ accountId: params.accountId, automation: updated, cursor });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: updated.id,
                cursor,
                assignments: assignmentRows,
            });
            if (nextRun) {
                emitAutomationRunUpdated({
                    accountId: params.accountId,
                    run: nextRun,
                    cursor,
                });
            }
        });

        return updated;
    });
}

export async function deleteAutomation(params: { accountId: string; automationId: string }): Promise<boolean> {
    return await inTx(async (tx) => {
        const existing = await tx.automation.findFirst({
            where: {
                id: params.automationId,
                accountId: params.accountId,
            },
            select: {
                id: true,
                assignments: {
                    select: { machineId: true, enabled: true, updatedAt: true },
                },
            },
        });

        if (!existing) {
            return false;
        }

        await tx.automation.delete({ where: { id: existing.id } });

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: existing.id,
        });

        const deletedAt = new Date();
        afterTx(tx, () => {
            emitAutomationDelete({
                accountId: params.accountId,
                automationId: existing.id,
                cursor,
                deletedAt,
            });
            emitAssignmentUpdates({
                accountId: params.accountId,
                automationId: existing.id,
                cursor,
                assignments: existing.assignments,
            });
        });

        return true;
    });
}

export async function setAutomationEnabled(params: {
    accountId: string;
    automationId: string;
    enabled: boolean;
}): Promise<AutomationListItem | null> {
    return await updateAutomation({
        accountId: params.accountId,
        automationId: params.automationId,
        input: { enabled: params.enabled },
    });
}

export async function runAutomationNow(params: {
    accountId: string;
    automationId: string;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const automation = await tx.automation.findFirst({
            where: {
                id: params.automationId,
                accountId: params.accountId,
            },
            select: { id: true, accountId: true },
        });
        if (!automation) {
            return null;
        }

        const now = new Date();
        const run = await enqueueImmediateRunTx({
            tx,
            automationId: automation.id,
            accountId: automation.accountId,
            now,
        });

        const cursor = await markAutomationChangedTx(tx, {
            accountId: params.accountId,
            automationId: automation.id,
        });

        afterTx(tx, () => {
            emitAutomationRunUpdated({
                accountId: params.accountId,
                run,
                cursor,
            });
        });

        return run as AutomationRunItem;
    });
}

export async function listAutomationRuns(params: {
    accountId: string;
    automationId: string;
    limit: number;
    cursor?: string | null;
}): Promise<{ runs: AutomationRunItem[]; nextCursor: string | null }> {
    const normalizedLimit = Math.min(Math.max(Math.floor(params.limit || 20), 1), 100);
    const rows = await db.automationRun.findMany({
        where: {
            accountId: params.accountId,
            automationId: params.automationId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: normalizedLimit + 1,
        ...(params.cursor
            ? {
                cursor: { id: params.cursor },
                skip: 1,
            }
            : {}),
        select: {
            id: true,
            automationId: true,
            accountId: true,
            state: true,
            scheduledAt: true,
            dueAt: true,
            claimedAt: true,
            startedAt: true,
            finishedAt: true,
            claimedByMachineId: true,
            leaseExpiresAt: true,
            attempt: true,
            summaryCiphertext: true,
            errorCode: true,
            errorMessage: true,
            producedSessionId: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    const hasNext = rows.length > normalizedLimit;
    const resultRows = hasNext ? rows.slice(0, normalizedLimit) : rows;
    const nextCursor = hasNext ? resultRows[resultRows.length - 1]?.id ?? null : null;

    return {
        runs: resultRows as AutomationRunItem[],
        nextCursor,
    };
}
