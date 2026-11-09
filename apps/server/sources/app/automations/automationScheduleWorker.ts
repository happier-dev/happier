import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { acquireWorkflowPublicationLocksInTx } from "@/app/workflows/acquireWorkflowPublicationLocksInTx";
import { warn } from "@/utils/logging/log";
import { withWebLatencyProducerTrace } from "@/utils/webLatencyTrace";
import { armDeadlineTimer } from "@happier-dev/protocol/common/deadlineTimer";

import { rejoinAutomationOccurrenceInsertRace } from "./automationOccurrencePersistence";
import { admitDueAutomationScheduleTriggerTx } from "./automationRunQueueService";
import { AUTOMATION_RUN_TERMINAL_STATES } from "./automationTypes";
import { subscribeAutomationScheduleWake } from "./automationScheduleWake";

/** Existing liveness fallback for cross-API writes without push and DB-only recovery without reconnect. */
export const DEFAULT_AUTOMATION_SCHEDULE_IDLE_POLL_MS = 10_000;
/** Private query-memory budget; it does not cap due work in one pass. */
const AUTOMATION_SCHEDULE_SCAN_PAGE_SIZE = 128;

async function findNextScheduleTrigger() {
    let scanCursor: AutomationScheduleScanCursor | null = null;
    do {
        const page = await findEligibleDueScheduleTriggerPage({ scanCursor });
        if (page.eligible[0]) return page.eligible[0];
        scanCursor = page.continuationCursor;
    } while (scanCursor !== null);
    return null;
}

export type AutomationScheduleScanCursor = Readonly<{ nextRunAt: Date; id: string }>;

async function findDueScheduleTriggers(
    now: Date | undefined,
    cursor: AutomationScheduleScanCursor | null,
) {
    return await db.automationTrigger.findMany({
        where: {
            kind: "schedule",
            enabled: true,
            deletedAt: null,
            nextRunAt: now ? { lte: now } : { not: null },
            automation: { enabled: true, deletedAt: null },
            ...(cursor === null
                ? {}
                : {
                    OR: [
                        { nextRunAt: { gt: cursor.nextRunAt } },
                        { nextRunAt: cursor.nextRunAt, id: { gt: cursor.id } },
                    ],
                }),
        },
        orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
        take: AUTOMATION_SCHEDULE_SCAN_PAGE_SIZE,
        select: { id: true, revision: true, nextRunAt: true, automation: { select: { accountId: true } } },
    });
}

/**
 * Reads exactly one query page without coupling immutable Run provenance to a
 * mutable trigger through a database foreign key. The page is joined to the
 * incumbent Run owner by the already-indexed scalar `triggerId`; open schedule
 * Runs are then removed in memory. A full page returns an ephemeral cursor so
 * the process-local worker can yield before continuing.
 */
async function findEligibleDueScheduleTriggerPage(params: Readonly<{
    now?: Date;
    scanCursor?: AutomationScheduleScanCursor | null;
    shouldStop?: () => boolean;
}>) {
    if (params.shouldStop?.()) return { eligible: [], continuationCursor: null };
    const candidates = await findDueScheduleTriggers(
        params.now,
        params.scanCursor ?? null,
    );
    if (candidates.length === 0 || params.shouldStop?.()) {
        return { eligible: [], continuationCursor: null };
    }
    const openRuns = await db.automationRun.findMany({
        where: {
            triggerId: { in: candidates.map((candidate) => candidate.id) },
            causeKind: "trigger",
            causeTriggerKind: "schedule",
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
            // Scoped firings belong to the canonical latest-pending coalescer.
            automation: { scopeSessionId: null },
        },
        select: { triggerId: true },
        distinct: ["triggerId"],
    });
    const openTriggerIds = new Set(openRuns.flatMap((run) => (
        run.triggerId === null ? [] : [run.triggerId]
    )));
    const last = candidates.at(-1);
    return {
        eligible: candidates.filter((candidate) => !openTriggerIds.has(candidate.id)),
        continuationCursor: candidates.length === AUTOMATION_SCHEDULE_SCAN_PAGE_SIZE
            && last?.nextRunAt
            ? { nextRunAt: last.nextRunAt, id: last.id }
            : null,
    };
}

export async function runAutomationScheduleWorkerPass(params: Readonly<{
    now: Date;
    scanCursor?: AutomationScheduleScanCursor | null;
    shouldStop?: () => boolean;
}>): Promise<Readonly<{
    progressed: boolean;
    nextDueAt: Date | null;
    continuationCursor: AutomationScheduleScanCursor | null;
}>> {
    let progressed = false;
    const page = await findEligibleDueScheduleTriggerPage(params);
    for (const candidate of page.eligible) {
        if (params.shouldStop?.()) break;
        if (!candidate.nextRunAt) continue;
        const expectedNextRunAt = candidate.nextRunAt;
        try {
            const admitted = await rejoinAutomationOccurrenceInsertRace(async () => await inTx(async (tx) => {
                await acquireWorkflowPublicationLocksInTx(tx, { accountId: candidate.automation.accountId, triggerIds: [candidate.id] });
                const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
                    tx,
                    candidate.automation.accountId, "content",
                );
                if (accountFence.status !== "ready") return null;
                return await admitDueAutomationScheduleTriggerTx({
                    tx,
                    triggerId: candidate.id,
                    expectedRevision: candidate.revision,
                    expectedNextRunAt,
                    now: params.now,
                });
            }, { transactionClass: "automation-schedule-admit" }));
            // A rejoined open occurrence intentionally leaves the cursor parked.
            // It is durable progress only after its canonical terminal transition.
            progressed ||= admitted?.kind === "admitted";
        } catch {
            warn(
                { module: "automation-schedule-worker", triggerId: candidate.id },
                "Automation schedule occurrence admission failed",
            );
        }
    }
    const next = await findNextScheduleTrigger();
    return {
        progressed,
        nextDueAt: next?.nextRunAt ?? null,
        continuationCursor: page.continuationCursor,
    };
}

export function startAutomationScheduleWorker(): Readonly<{ stop: () => Promise<void> }> {
    let stopped = false;
    let cancelTimer: (() => void) | null = null;
    let active: Promise<void> | null = null;
    let scanCursor: AutomationScheduleScanCursor | null = null;

    const schedule = async (lastPass: Readonly<{
        progressed: boolean;
        nextDueAt: Date | null;
        continuationCursor: AutomationScheduleScanCursor | null;
    }>): Promise<void> => {
        if (stopped) return;
        if (lastPass.continuationCursor !== null) {
            scanCursor = lastPass.continuationCursor;
            cancelTimer = armDeadlineTimer(Date.now(), () => {
                cancelTimer = null;
                void trigger();
            }, { unref: true });
            return;
        }
        scanCursor = null;
        const nextDueAt = lastPass.nextDueAt;
        if (stopped) return;
        const now = Date.now();
        const nextDeadline = nextDueAt === null || (nextDueAt.getTime() <= now && !lastPass.progressed)
            ? now + DEFAULT_AUTOMATION_SCHEDULE_IDLE_POLL_MS
            : Math.min(nextDueAt.getTime(), now + DEFAULT_AUTOMATION_SCHEDULE_IDLE_POLL_MS);
        cancelTimer = armDeadlineTimer(nextDeadline, () => {
            cancelTimer = null;
            void trigger();
        }, { unref: true });
    };

    const trigger = async (): Promise<void> => {
        if (stopped || active) return;
        active = withWebLatencyProducerTrace('producer.automation-schedule', async () => {
            let pass = { progressed: false, nextDueAt: null as Date | null,
                continuationCursor: null as AutomationScheduleScanCursor | null };
            try {
                pass = await runAutomationScheduleWorkerPass({
                    now: new Date(),
                    scanCursor,
                    shouldStop: () => stopped,
                });
            } catch {
                warn({ module: "automation-schedule-worker" }, "Automation schedule worker pass failed");
            } finally {
                await schedule(pass);
            }
        });
        try {
            await active;
        } finally {
            active = null;
        }
    };

    const unsubscribeWake = subscribeAutomationScheduleWake(() => {
        if (stopped || active) return;
        cancelTimer?.();
        cancelTimer = null;
        scanCursor = null;
        void trigger();
    });

    void trigger();
    return {
        stop: async () => {
            if (stopped) return;
            stopped = true;
            unsubscribeWake();
            cancelTimer?.();
            cancelTimer = null;
            await active;
        },
    };
}
