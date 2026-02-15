import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

import { emitAutomationRunUpdated } from "./automationChangePublisher";
import { enqueueNextScheduledRunIfMissingTx } from "./automationRunQueueService";
import { shouldEnqueueNextRunForTerminalState } from "./automationSchedulingService";
import { sanitizeAutomationErrorMessage, sanitizeAutomationSummaryCiphertext } from "./automationSummaryService";
import type { AutomationRunItem } from "./automationTypes";

async function appendRunEventTx(params: {
    tx: any;
    runId: string;
    type: string;
    payload?: Record<string, unknown>;
    now: Date;
}): Promise<void> {
    await params.tx.automationRunEvent.create({
        data: {
            runId: params.runId,
            ts: params.now,
            type: params.type,
            payload: params.payload ?? null,
        },
    });
}

async function fetchRunForAccount(params: { tx: any; accountId: string; runId: string }) {
    return await params.tx.automationRun.findFirst({
        where: {
            id: params.runId,
            accountId: params.accountId,
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

async function markRunAutomationChanged(params: { tx: any; accountId: string; automationId: string }) {
    return await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: params.automationId,
    });
}

async function resolveProducedSessionIdTx(params: {
    tx: any;
    accountId: string;
    producedSessionId: string | null | undefined;
}): Promise<string | null> {
    const candidate = typeof params.producedSessionId === "string" ? params.producedSessionId.trim() : "";
    if (!candidate) return null;

    const session = await params.tx.session.findFirst({
        where: {
            id: candidate,
            accountId: params.accountId,
        },
        select: { id: true },
    });
    return session ? session.id : null;
}

async function maybeEnqueueFollowUpRun(params: { tx: any; run: AutomationRunItem; now: Date }) {
    if (!shouldEnqueueNextRunForTerminalState(params.run.state)) {
        return null;
    }
    return await enqueueNextScheduledRunIfMissingTx({
        tx: params.tx,
        automationId: params.run.automationId,
        now: params.now,
    });
}

export async function startAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const now = new Date();
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                state: "claimed",
            },
            data: {
                state: "running",
                startedAt: now,
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({ tx, accountId: params.accountId, runId: params.runId });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_started",
            now,
            payload: { machineId: params.machineId },
        });

        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });
        afterTx(tx, () => {
            emitAutomationRunUpdated({ accountId: params.accountId, run: run as AutomationRunItem, cursor });
        });

        return run as AutomationRunItem;
    });
}

export async function succeedAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    producedSessionId?: string | null;
    summaryCiphertext?: string | null;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const now = new Date();
        const producedSessionId = await resolveProducedSessionIdTx({
            tx,
            accountId: params.accountId,
            producedSessionId: params.producedSessionId,
        });
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                state: { in: ["claimed", "running"] },
            },
            data: {
                state: "succeeded",
                finishedAt: now,
                summaryCiphertext: sanitizeAutomationSummaryCiphertext(params.summaryCiphertext),
                producedSessionId,
                errorCode: null,
                errorMessage: null,
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({ tx, accountId: params.accountId, runId: params.runId });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_succeeded",
            now,
            payload: {
                machineId: params.machineId,
                producedSessionId: producedSessionId ?? null,
            },
        });

        await tx.automation.update({
            where: { id: run.automationId },
            data: { lastRunAt: now },
        });

        const nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });

        afterTx(tx, () => {
            emitAutomationRunUpdated({ accountId: params.accountId, run: run as AutomationRunItem, cursor });
            if (nextRun) {
                emitAutomationRunUpdated({ accountId: params.accountId, run: nextRun as AutomationRunItem, cursor });
            }
        });

        return run as AutomationRunItem;
    });
}

export async function failAutomationRun(params: {
    accountId: string;
    runId: string;
    machineId: string;
    errorCode?: string | null;
    errorMessage?: string | null;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const now = new Date();
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                claimedByMachineId: params.machineId,
                state: { in: ["claimed", "running"] },
            },
            data: {
                state: "failed",
                finishedAt: now,
                errorCode: typeof params.errorCode === "string" && params.errorCode.trim().length > 0
                    ? params.errorCode.trim().slice(0, 128)
                    : null,
                errorMessage: sanitizeAutomationErrorMessage(params.errorMessage),
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({ tx, accountId: params.accountId, runId: params.runId });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_failed",
            now,
            payload: {
                machineId: params.machineId,
                errorCode: run.errorCode,
            },
        });

        const nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });

        afterTx(tx, () => {
            emitAutomationRunUpdated({ accountId: params.accountId, run: run as AutomationRunItem, cursor });
            if (nextRun) {
                emitAutomationRunUpdated({ accountId: params.accountId, run: nextRun as AutomationRunItem, cursor });
            }
        });

        return run as AutomationRunItem;
    });
}

export async function cancelAutomationRun(params: {
    accountId: string;
    runId: string;
}): Promise<AutomationRunItem | null> {
    return await inTx(async (tx) => {
        const now = new Date();
        const updated = await tx.automationRun.updateMany({
            where: {
                id: params.runId,
                accountId: params.accountId,
                state: { in: ["queued", "claimed", "running"] },
            },
            data: {
                state: "cancelled",
                finishedAt: now,
                updatedAt: now,
            },
        });
        if (updated.count !== 1) {
            return null;
        }

        const run = await fetchRunForAccount({ tx, accountId: params.accountId, runId: params.runId });
        if (!run) return null;
        await appendRunEventTx({
            tx,
            runId: run.id,
            type: "run_cancelled",
            now,
        });

        const nextRun = await maybeEnqueueFollowUpRun({ tx, run: run as AutomationRunItem, now });
        const cursor = await markRunAutomationChanged({ tx, accountId: params.accountId, automationId: run.automationId });

        afterTx(tx, () => {
            emitAutomationRunUpdated({ accountId: params.accountId, run: run as AutomationRunItem, cursor });
            if (nextRun) {
                emitAutomationRunUpdated({ accountId: params.accountId, run: nextRun as AutomationRunItem, cursor });
            }
        });

        return run as AutomationRunItem;
    });
}
