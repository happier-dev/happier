import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    inTx: vi.fn(),
    fence: vi.fn(),
    admit: vi.fn(),
    rejoin: vi.fn(),
    subscribeWake: vi.fn(),
    unsubscribeWake: vi.fn(),
    wakeListener: null as (() => void) | null,
}));

vi.mock("@/storage/db", () => ({
    db: { automationTrigger: { findMany: mocks.findMany, findFirst: mocks.findFirst } },
}));
vi.mock("@/storage/inTx", () => ({ inTx: mocks.inTx }));
vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx: mocks.fence,
}));
vi.mock("@/utils/logging/log", () => ({ warn: vi.fn() }));
vi.mock("./automationOccurrencePersistence", () => ({
    rejoinAutomationOccurrenceInsertRace: mocks.rejoin,
}));
vi.mock("./automationRunQueueService", () => ({
    admitDueAutomationScheduleTriggerTx: mocks.admit,
}));
vi.mock("./automationScheduleWake", () => ({
    subscribeAutomationScheduleWake: mocks.subscribeWake,
}));

import {
    runAutomationScheduleWorkerPass,
    startAutomationScheduleWorker,
} from "./automationScheduleWorker";

function dueCandidate(id: string, accountId: string) {
    return {
        id,
        revision: 1,
        nextRunAt: new Date("2026-08-27T12:00:00.000Z"),
        automation: { accountId },
    };
}

async function flushWorkerMicrotasks(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("Automation schedule worker", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.wakeListener = null;
        mocks.findMany.mockResolvedValue([]);
        mocks.findFirst.mockResolvedValue(null);
        mocks.inTx.mockImplementation(async (operation: (tx: object) => Promise<unknown>) => await operation({}));
        mocks.fence.mockResolvedValue({ status: "ready" });
        mocks.rejoin.mockImplementation(async (operation: () => Promise<unknown>) => await operation());
        mocks.admit.mockImplementation(async ({ triggerId }: { triggerId: string }) => ({
            kind: "admitted",
            run: { id: `run-${triggerId}` },
        }));
        mocks.subscribeWake.mockImplementation((listener: () => void) => {
            mocks.wakeListener = listener;
            return mocks.unsubscribeWake;
        });
    });

    it("admits every due trigger independently without requiring an assignment or daemon claim", async () => {
        mocks.findMany.mockResolvedValue([
            dueCandidate("schedule-one", "account-one"),
            dueCandidate("schedule-two", "account-two"),
        ]);

        const result = await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:00:00.000Z"),
        });

        expect(result.progressed).toBe(true);
        expect(mocks.admit.mock.calls.map((call) => (
            call[0] as { triggerId: string }
        ).triggerId)).toEqual([
            "schedule-one",
            "schedule-two",
        ]);
        expect(mocks.rejoin).toHaveBeenCalledTimes(2);
    });

    it("continues to eligible siblings when one due Account transition is fenced", async () => {
        mocks.findMany.mockResolvedValue([
            dueCandidate("blocked", "account-blocked"),
            dueCandidate("eligible", "account-ready"),
        ]);
        mocks.fence.mockImplementation(async (_tx: object, accountId: string) => (
            accountId === "account-blocked" ? { status: "transitioning" } : { status: "ready" }
        ));

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:00:00.000Z"),
        });

        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ triggerId: "eligible" }));
    });

    it("isolates a failed due transaction from later due triggers", async () => {
        mocks.findMany.mockResolvedValue([
            dueCandidate("failed", "account-failed"),
            dueCandidate("eligible", "account-ready"),
        ]);
        mocks.rejoin
            .mockRejectedValueOnce(new Error("provider transaction failed"))
            .mockImplementationOnce(async (operation: () => Promise<unknown>) => await operation());

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:00:00.000Z"),
        });

        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ triggerId: "eligible" }));
    });

    it("keyset-pages a saturated due scan", async () => {
        const firstPage = Array.from({ length: 128 }, (_, index) => ({
            ...dueCandidate(`schedule-${String(index).padStart(3, "0")}`, "account"),
            nextRunAt: new Date(`2026-08-27T12:00:${String(Math.floor(index / 100)).padStart(2, "0")}.${String(index % 100).padStart(3, "0")}Z`),
        }));
        mocks.findMany
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([dueCandidate("schedule-next", "account")]);

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
        });

        expect(mocks.findMany).toHaveBeenCalledTimes(2);
        expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                OR: [
                    { nextRunAt: { gt: firstPage[127]!.nextRunAt } },
                    { nextRunAt: firstPage[127]!.nextRunAt, id: { gt: firstPage[127]!.id } },
                ],
            }),
            take: 128,
        }));
        expect(mocks.admit).toHaveBeenCalledTimes(129);
    });

    it("stops between candidates without scanning another page", async () => {
        mocks.findMany.mockResolvedValue(Array.from(
            { length: 128 },
            (_, index) => dueCandidate(`schedule-${index}`, "account"),
        ));

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
            shouldStop: () => mocks.admit.mock.calls.length >= 1,
        });

        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.findMany).toHaveBeenCalledTimes(1);
    });

    it("uses a process-local wake to rescan an earlier cursor immediately", async () => {
        mocks.findFirst.mockResolvedValue({
            ...dueCandidate("later", "account"),
            nextRunAt: new Date("2030-08-28T12:00:00.000Z"),
        });
        const worker = startAutomationScheduleWorker({ idlePollMs: 60_000 });
        await flushWorkerMicrotasks();

        mocks.findMany.mockResolvedValue([dueCandidate("earlier", "account")]);
        mocks.findFirst.mockResolvedValue(null);
        mocks.wakeListener?.();
        await flushWorkerMicrotasks();

        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ triggerId: "earlier" }));
        await worker.stop();
        expect(mocks.unsubscribeWake).toHaveBeenCalledTimes(1);
    });
});
