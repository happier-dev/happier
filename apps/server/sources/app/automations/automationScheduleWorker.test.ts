import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    findOpenRuns: vi.fn(),
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
    db: {
        automationTrigger: { findMany: mocks.findMany, findFirst: mocks.findFirst },
        automationRun: { findMany: mocks.findOpenRuns },
    },
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
        mocks.findOpenRuns.mockResolvedValue([]);
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

    it("admits one saturated page per pass and yields the rest to the next pass", async () => {
        const firstPage = Array.from({ length: 128 }, (_, index) => ({
            ...dueCandidate(`schedule-${String(index).padStart(3, "0")}`, "account"),
            nextRunAt: new Date(`2026-08-27T12:00:${String(Math.floor(index / 100)).padStart(2, "0")}.${String(index % 100).padStart(3, "0")}Z`),
        }));
        const secondPage = [dueCandidate("schedule-next", "account")];
        mocks.findMany
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(secondPage);

        const firstPass = await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
        });
        expect(firstPass).toMatchObject({ progressed: true });
        expect(mocks.findMany).toHaveBeenCalledTimes(1);
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            take: 128,
        }));
        expect(mocks.admit).toHaveBeenCalledTimes(128);

        const secondPass = await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
        });
        expect(secondPass).toMatchObject({ progressed: true });
        expect(mocks.admit).toHaveBeenCalledTimes(129);
        expect(mocks.admit).toHaveBeenLastCalledWith(expect.objectContaining({ triggerId: "schedule-next" }));
    });

    it("excludes triggers with open schedule work through the incumbent Run index", async () => {
        mocks.findMany.mockResolvedValue([
            dueCandidate("blocked", "account"),
            dueCandidate("eligible", "account"),
        ]);
        mocks.findOpenRuns.mockResolvedValue([{ triggerId: "blocked" }]);

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
        });

        expect(mocks.findOpenRuns).toHaveBeenCalledWith({
            where: {
                triggerId: { in: ["blocked", "eligible"] },
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                state: {
                    notIn: [
                        "succeeded", "failed", "cancelled", "expired",
                        "dispatch_failed", "skipped", "missed", "outcome_uncertain",
                    ],
                },
            },
            select: { triggerId: true },
            distinct: ["triggerId"],
        });
        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({ triggerId: "eligible" }));
    });

    it("yields after one parked query page and resumes from its process-local continuation", async () => {
        const parked = Array.from({ length: 128 }, (_, index) => ({
            ...dueCandidate(`parked-${index}`, "account"),
            nextRunAt: new Date(`2026-08-27T12:00:00.${String(index).padStart(3, "0")}Z`),
        }));
        const eligible = [dueCandidate("eligible-after-parked", "account")];
        mocks.findMany.mockResolvedValueOnce(parked).mockResolvedValueOnce(eligible);
        mocks.findOpenRuns
            .mockResolvedValueOnce(parked.map((candidate) => ({ triggerId: candidate.id })))
            .mockResolvedValueOnce([]);

        const firstPass = await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
        });

        expect(mocks.findMany).toHaveBeenCalledTimes(1);
        expect(mocks.admit).not.toHaveBeenCalled();
        expect(firstPass.continuationCursor).toEqual({
            nextRunAt: parked[127]!.nextRunAt,
            id: parked[127]!.id,
        });

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
            scanCursor: firstPass.continuationCursor,
        });

        expect(mocks.findMany).toHaveBeenCalledTimes(2);
        expect(mocks.admit).toHaveBeenCalledTimes(1);
        expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({
            triggerId: "eligible-after-parked",
        }));
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

    it("stops between parked scan pages before issuing another query", async () => {
        const parked = Array.from(
            { length: 128 },
            (_, index) => dueCandidate(`parked-${index}`, "account"),
        );
        mocks.findMany.mockResolvedValue(parked);
        mocks.findOpenRuns.mockResolvedValue(parked.map((candidate) => ({
            triggerId: candidate.id,
        })));

        await runAutomationScheduleWorkerPass({
            now: new Date("2026-08-27T12:01:00.000Z"),
            shouldStop: () => mocks.findOpenRuns.mock.calls.length >= 1,
        });

        expect(mocks.findMany).toHaveBeenCalledTimes(1);
        expect(mocks.findOpenRuns).toHaveBeenCalledTimes(1);
        expect(mocks.admit).not.toHaveBeenCalled();
    });

    it("cooperatively continues a full parked page from process-local worker state", async () => {
        const parked = Array.from(
            { length: 128 },
            (_, index) => dueCandidate(`parked-${index}`, "account"),
        );
        mocks.findMany
            .mockResolvedValueOnce(parked)
            .mockResolvedValueOnce([dueCandidate("eligible-next-page", "account")])
            .mockResolvedValue([]);
        mocks.findOpenRuns
            .mockResolvedValueOnce(parked.map((candidate) => ({ triggerId: candidate.id })))
            .mockResolvedValueOnce([]);

        const worker = startAutomationScheduleWorker({ idlePollMs: 60_000 });
        await vi.waitFor(() => {
            expect(mocks.admit).toHaveBeenCalledWith(expect.objectContaining({
                triggerId: "eligible-next-page",
            }));
        });

        expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: expect.objectContaining({
                OR: [
                    { nextRunAt: { gt: parked[127]!.nextRunAt } },
                    { nextRunAt: parked[127]!.nextRunAt, id: { gt: parked[127]!.id } },
                ],
            }),
        }));
        await worker.stop();
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
