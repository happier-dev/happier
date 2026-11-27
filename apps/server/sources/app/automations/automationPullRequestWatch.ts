import { createHash } from "node:crypto";

import { afterTx, type Tx } from "@/storage/inTx";

import { emitAutomationScheduleWake } from "./automationScheduleWake";
import type { AutomationListItem, AutomationTriggerItem } from "./automationTypes";

const deadlinePrefix = "pr-watch-deadline:";

export function isPullRequestWatchDeadlineId(id: string): boolean {
    return id.startsWith(deadlinePrefix);
}

export function automationPullRequestWatchDeadlineId(triggerId: string): string {
    return deadlinePrefix + createHash("sha256").update(triggerId).digest("hex");
}

export function projectAutomationPullRequestWatches(item: AutomationListItem): AutomationListItem {
    const deadlines = new Map(item.triggers.filter(trigger => isPullRequestWatchDeadlineId(trigger.id))
        .map(trigger => [trigger.id, trigger]));
    if (!deadlines.size) return item;
    const triggers = item.triggers.flatMap((trigger): AutomationTriggerItem[] => {
        if (isPullRequestWatchDeadlineId(trigger.id)) return [];
        if (trigger.kind !== "prComment" && trigger.kind !== "ciFailed") return [trigger];
        const deadline = deadlines.get(automationPullRequestWatchDeadlineId(trigger.id));
        return deadline?.scheduledAt && deadline.remainingOccurrences !== null
            ? [{ ...trigger, watchDeadline: {
                scheduledAt: deadline.scheduledAt,
                nextRunAt: deadline.nextRunAt,
                remainingOccurrences: deadline.remainingOccurrences,
            } }]
            : [trigger];
    });
    return { ...item, triggers };
}

/** Store the deadline using the same checked schedule arm as a standalone once trigger. */
export async function writeAutomationPullRequestWatchDeadlineTx(params: Readonly<{
    tx: Tx;
    automationId: string;
    triggerId: string;
    revision: number;
    enabled: boolean;
    scheduledAt: Date | null;
    existing?: AutomationTriggerItem;
}>): Promise<void> {
    const where = {
        id: automationPullRequestWatchDeadlineId(params.triggerId),
        automationId: params.automationId,
    };
    const previous = params.existing?.watchDeadline;
    if (params.scheduledAt === null) {
        if (previous) {
            // Keep the trigger foreign key for historical deadline Runs.
            await params.tx.automationTrigger.updateMany({
                where, data: { enabled: false, deletedAt: new Date(), scheduleKind: null,
                    scheduledAt: null, nextRunAt: null, remainingOccurrences: null },
            });
            afterTx(params.tx, emitAutomationScheduleWake);
        }
        return;
    }
    const sameDeadline = previous !== undefined && previous.scheduledAt.getTime() === params.scheduledAt.getTime();
    const data = {
        kind: "schedule" as const,
        scheduleKind: "once" as const,
        revision: params.revision,
        scheduledAt: params.scheduledAt,
        enabled: params.enabled,
        deletedAt: null,
        remainingOccurrences: sameDeadline ? previous.remainingOccurrences : 1,
        nextRunAt: params.enabled && sameDeadline ? previous.nextRunAt : null,
    };
    const updated = await params.tx.automationTrigger.updateMany({ where, data });
    if (!updated.count) await params.tx.automationTrigger.create({ data: { ...where, ...data } });
    afterTx(params.tx, emitAutomationScheduleWake);
}
