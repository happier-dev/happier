import { inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { warn } from "@/utils/logging/log";

import { rejoinAutomationOccurrenceInsertRace } from "./automationOccurrencePersistence";
import { admitDueAutomationScheduleTriggerTx } from "./automationRunQueueService";
import { subscribeAutomationScheduleWake } from "./automationScheduleWake";

/** Durable indexed restart recovery for missed process-local wake hints. */
export const DEFAULT_AUTOMATION_SCHEDULE_IDLE_POLL_MS = 10_000;
/** Node clamps larger timeout delays to 1ms, so long cron horizons need a bounded wake. */
export const MAX_AUTOMATION_SCHEDULE_TIMER_DELAY_MS = 2_147_483_647;
/** Private query-memory budget; it does not cap due work in one pass. */
const AUTOMATION_SCHEDULE_SCAN_PAGE_SIZE = 128;

async function findNextScheduleTrigger() {
    return await db.automationTrigger.findFirst({
        where: {
            kind: "schedule",
            enabled: true,
            deletedAt: null,
            nextRunAt: { not: null },
            automation: { enabled: true, deletedAt: null },
        },
        orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
        select: { id: true, revision: true, nextRunAt: true, automation: { select: { accountId: true } } },
    });
}

type AutomationScheduleScanCursor = Readonly<{ nextRunAt: Date; id: string }>;

async function findDueScheduleTriggers(
    now: Date,
    cursor: AutomationScheduleScanCursor | null,
) {
    return await db.automationTrigger.findMany({
        where: {
            kind: "schedule",
            enabled: true,
            deletedAt: null,
            nextRunAt: { lte: now },
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

export async function runAutomationScheduleWorkerPass(params: Readonly<{
    now: Date;
    shouldStop?: () => boolean;
}>): Promise<Readonly<{ progressed: boolean; nextDueAt: Date | null }>> {
    let progressed = false;
    let scanCursor: AutomationScheduleScanCursor | null = null;
    while (!params.shouldStop?.()) {
        const candidates = await findDueScheduleTriggers(params.now, scanCursor);
        for (const candidate of candidates) {
            if (params.shouldStop?.()) break;
            if (!candidate.nextRunAt) continue;
            try {
                const admitted = await rejoinAutomationOccurrenceInsertRace(async () => await inTx(async (tx) => {
                    const accountFence = await acquireAccountEncryptionTransitionFenceInTx(
                        tx,
                        candidate.automation.accountId,
                    );
                    if (accountFence.status !== "ready") return null;
                    return await admitDueAutomationScheduleTriggerTx({
                        tx,
                        triggerId: candidate.id,
                        expectedRevision: candidate.revision,
                        expectedNextRunAt: candidate.nextRunAt,
                        now: params.now,
                    });
                }));
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
        if (params.shouldStop?.() || candidates.length < AUTOMATION_SCHEDULE_SCAN_PAGE_SIZE) break;
        const last = candidates.at(-1);
        if (!last?.nextRunAt) break;
        scanCursor = { nextRunAt: last.nextRunAt, id: last.id };
    }
    const next = await findNextScheduleTrigger();
    return { progressed, nextDueAt: next?.nextRunAt ?? null };
}

export function startAutomationScheduleWorker(params: Readonly<{
    idlePollMs?: number;
}> = {}): Readonly<{ stop: () => Promise<void> }> {
    const idlePollMs = Number.isSafeInteger(params.idlePollMs) && params.idlePollMs! > 0
        ? params.idlePollMs!
        : DEFAULT_AUTOMATION_SCHEDULE_IDLE_POLL_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: Promise<void> | null = null;

    const schedule = async (lastProgressed: boolean): Promise<void> => {
        if (stopped) return;
        let nextDueAt: Date | null = null;
        try {
            nextDueAt = (await findNextScheduleTrigger())?.nextRunAt ?? null;
        } catch {
            warn({ module: "automation-schedule-worker" }, "Automation schedule due scan failed");
        }
        if (stopped) return;
        const now = Date.now();
        const unboundedDelay = nextDueAt === null
            ? idlePollMs
            : nextDueAt.getTime() <= now && !lastProgressed
                ? idlePollMs
                : Math.max(0, nextDueAt.getTime() - now);
        const delay = Math.min(unboundedDelay, MAX_AUTOMATION_SCHEDULE_TIMER_DELAY_MS);
        timer = setTimeout(() => {
            timer = null;
            void trigger();
        }, delay);
        timer.unref?.();
    };

    const trigger = async (): Promise<void> => {
        if (stopped || active) return;
        active = (async () => {
            let progressed = false;
            try {
                progressed = (await runAutomationScheduleWorkerPass({
                    now: new Date(),
                    shouldStop: () => stopped,
                })).progressed;
            } catch {
                warn({ module: "automation-schedule-worker" }, "Automation schedule worker pass failed");
            } finally {
                active = null;
                await schedule(progressed);
            }
        })();
        await active;
    };

    const unsubscribeWake = subscribeAutomationScheduleWake(() => {
        if (stopped || active) return;
        if (timer) clearTimeout(timer);
        timer = null;
        void trigger();
    });

    void trigger();
    return {
        stop: async () => {
            if (stopped) return;
            stopped = true;
            unsubscribeWake();
            if (timer) clearTimeout(timer);
            timer = null;
            await active;
        },
    };
}
