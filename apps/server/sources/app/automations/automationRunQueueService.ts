import type { Tx } from "@/storage/inTx";

import { computeNextDueAtForAutomation } from "./automationSchedulingService";
import type { AutomationScheduleKind } from "./automationTypes";

export function resolveScheduledRunDueAt(params: {
    now: Date;
    scheduleKind: AutomationScheduleKind;
    everyMs: number | null;
    scheduleExpr: string | null;
    timezone: string | null;
    nextRunAt: Date | null;
}): Date | null {
    const computedDueAt = computeNextDueAtForAutomation({
        now: params.now,
        scheduleKind: params.scheduleKind,
        everyMs: params.everyMs,
        scheduleExpr: params.scheduleExpr,
        timezone: params.timezone,
    });
    if (!computedDueAt) {
        return null;
    }

    return computedDueAt;
}

export async function enqueueImmediateRunTx(params: {
    tx: Tx;
    automationId: string;
    accountId: string;
    now: Date;
}) {
    return await params.tx.automationRun.create({
        data: {
            automationId: params.automationId,
            accountId: params.accountId,
            state: "queued",
            scheduledAt: params.now,
            dueAt: params.now,
        },
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
}

export async function enqueueNextScheduledRunIfMissingTx(params: {
    tx: Tx;
    automationId: string;
    now: Date;
}) {
    const automation = await params.tx.automation.findUnique({
        where: { id: params.automationId },
        select: {
            id: true,
            accountId: true,
            enabled: true,
            scheduleKind: true,
            scheduleExpr: true,
            everyMs: true,
            timezone: true,
            nextRunAt: true,
        },
    });

    if (!automation || !automation.enabled) {
        return null;
    }

    const existingOpenRun = await params.tx.automationRun.findFirst({
        where: {
            automationId: automation.id,
            state: { in: ["queued", "claimed", "running"] },
        },
        select: { id: true },
    });
    if (existingOpenRun) {
        return null;
    }

    const dueAt = resolveScheduledRunDueAt({
        now: params.now,
        scheduleKind: automation.scheduleKind,
        everyMs: automation.everyMs,
        scheduleExpr: automation.scheduleExpr,
        timezone: automation.timezone,
        nextRunAt: automation.nextRunAt,
    });
    if (!dueAt) {
        await params.tx.automation.update({
            where: { id: automation.id },
            data: { nextRunAt: null },
        });
        return null;
    }

    const run = await params.tx.automationRun.create({
        data: {
            automationId: automation.id,
            accountId: automation.accountId,
            state: "queued",
            scheduledAt: params.now,
            dueAt,
        },
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

    await params.tx.automation.update({
        where: { id: automation.id },
        data: {
            nextRunAt: dueAt,
        },
    });

    return run;
}
