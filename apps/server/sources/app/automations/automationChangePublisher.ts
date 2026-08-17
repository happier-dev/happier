import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { eventRouter } from "@/app/events/eventRouter";

import type {
    AutomationListItem,
    AutomationRunItem,
    AutomationRunState,
    AutomationRunWithAutomation,
} from "./automationTypes";

export function emitAutomationUpsert(params: {
    accountId: string;
    automation: Pick<AutomationListItem, "id" | "templateVersion" | "enabled" | "updatedAt">;
    cursor: number;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-upsert",
                automationId: params.automation.id,
                version: params.automation.templateVersion,
                enabled: params.automation.enabled,
                updatedAt: params.automation.updatedAt.getTime(),
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "user-scoped-only" },
    });
}

export function emitAutomationDelete(params: {
    accountId: string;
    automationId: string;
    cursor: number;
    deletedAt: Date;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-delete",
                automationId: params.automationId,
                deletedAt: params.deletedAt.getTime(),
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "user-scoped-only" },
    });
}

export function emitAutomationRunUpdated(params: {
    accountId: string;
    run: AutomationRunItem | AutomationRunWithAutomation;
    cursor: number;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-run-updated",
                runId: params.run.id,
                automationId: params.run.automationId,
                state: params.run.state,
                scheduledAt: params.run.scheduledAt.getTime(),
                startedAt: params.run.startedAt ? params.run.startedAt.getTime() : null,
                finishedAt: params.run.finishedAt ? params.run.finishedAt.getTime() : null,
                updatedAt: params.run.updatedAt.getTime(),
                machineId: params.run.claimedByMachineId,
                attempt: params.run.attempt,
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "user-scoped-only" },
    });
}

/**
 * Publishes the two post-commit views of one persisted Run transition. The
 * existing update remains the worker/UI invalidation path; the separate
 * lifecycle carrier is daemon-only and observational.
 */
export function emitAutomationRunTransition(params: {
    accountId: string;
    run: AutomationRunItem | AutomationRunWithAutomation;
    previousState: AutomationRunState | null;
    cursor: number;
}): void {
    let legacyFailed = false;
    let legacyError: unknown;
    try {
        emitAutomationRunUpdated(params);
    } catch (error) {
        legacyFailed = true;
        legacyError = error;
    }
    // Some post-settlement updates retain canonical Run metadata without
    // changing its lifecycle state. Keep their incumbent invalidation, but do
    // not manufacture a public lifecycle edge from identical states.
    if (params.previousState === params.run.state) {
        if (legacyFailed) throw legacyError;
        return;
    }
    // New Runs are born queued. A null predecessor is never a valid later
    // transition, and this lossy observer must not manufacture that history.
    if (params.previousState === null && params.run.state !== "queued") {
        if (legacyFailed) throw legacyError;
        return;
    }
    try {
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: {
                id: randomKeyNaked(12),
                seq: params.cursor,
                body: {
                    t: "automation-run-state-changed",
                    runId: params.run.id,
                    automationId: params.run.automationId,
                    originKind: params.run.originKind,
                    previousState: params.previousState,
                    currentState: params.run.state,
                    transitionedAt: params.run.updatedAt.getTime(),
                    claimedByMachineId: params.run.claimedByMachineId,
                },
                createdAt: Date.now(),
            },
            recipientFilter: { type: "user-machine-scoped-only" },
        });
    } catch (error) {
        if (!legacyFailed) throw error;
    }
    if (legacyFailed) throw legacyError;
}

export function emitAutomationRunUpdatedToMachineOnly(params: {
    accountId: string;
    machineId: string;
    run: AutomationRunItem | AutomationRunWithAutomation;
    cursor: number;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-run-updated",
                runId: params.run.id,
                automationId: params.run.automationId,
                state: params.run.state,
                scheduledAt: params.run.scheduledAt.getTime(),
                startedAt: params.run.startedAt ? params.run.startedAt.getTime() : null,
                finishedAt: params.run.finishedAt ? params.run.finishedAt.getTime() : null,
                updatedAt: params.run.updatedAt.getTime(),
                machineId: params.run.claimedByMachineId,
                attempt: params.run.attempt,
                targetMachineId: params.machineId,
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "machine-only", machineId: params.machineId },
    });
}

export function emitAutomationAssignmentUpdated(params: {
    accountId: string;
    machineId: string;
    automationId: string;
    enabled: boolean;
    cursor: number;
    updatedAt: Date;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-assignment-updated",
                machineId: params.machineId,
                automationId: params.automationId,
                enabled: params.enabled,
                updatedAt: params.updatedAt.getTime(),
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "machine-scoped-only", machineId: params.machineId },
    });
}

/**
 * Invalidate the built-in Automation projection after a committed source-status
 * or watcher-catalog status write. The payload intentionally carries no source,
 * provider, or definition facts; the authenticated Automation query remains the
 * sole reader for those fields.
 */
export function emitAutomationSourceStatusUpdated(params: {
    accountId: string;
    cursor: number;
}): void {
    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: {
            id: randomKeyNaked(12),
            seq: params.cursor,
            body: {
                t: "automation-source-status-updated",
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "user-scoped-only" },
    });
}
