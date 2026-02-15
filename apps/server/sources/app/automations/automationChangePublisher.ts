import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { eventRouter } from "@/app/events/eventRouter";

import type { AutomationListItem, AutomationRunItem, AutomationRunWithAutomation } from "./automationTypes";

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
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: "user-scoped-only" },
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
