import { describe, expect, it, vi } from "vitest";

import { AsyncLock } from "./lock";

type DeadlineBoundLock = <T>(
    operation: () => Promise<T> | T,
    options?: Readonly<{ deadlineAtMs?: number }>,
) => Promise<T>;

describe("AsyncLock deadline admission", () => {
    it("removes a waiter whose deadline expires before admission and never starts it later", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const lock = new AsyncLock();
            let releaseFirst!: () => void;
            const firstStarted = new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
            const first = lock.inLock(async () => {
                await firstStarted;
            });
            await vi.advanceTimersByTimeAsync(0);

            const secondOperation = vi.fn(async () => "started");
            const thirdOperation = vi.fn(async () => "next");
            const boundedInLock = lock.inLock.bind(lock) as DeadlineBoundLock;
            const second = boundedInLock(secondOperation, { deadlineAtMs: 1_025 });
            const third = lock.inLock(thirdOperation);
            let observedSettlement: Readonly<{ status: "fulfilled"; value: unknown }> | Readonly<{ status: "rejected"; reason: unknown }> | null = null;
            void second.then(
                (value) => { observedSettlement = { status: "fulfilled", value }; },
                (reason: unknown) => { observedSettlement = { status: "rejected", reason }; },
            );

            await vi.advanceTimersByTimeAsync(25);
            const settlementAtDeadline = observedSettlement;

            releaseFirst();
            await vi.runAllTimersAsync();
            await Promise.allSettled([first, second, third]);
            expect(settlementAtDeadline).toMatchObject({
                status: "rejected",
                reason: { name: "LockAdmissionDeadlineExceededError" },
            });
            expect(secondOperation).not.toHaveBeenCalled();
            expect(thirdOperation).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects a waiter at its deadline during handoff and admits the next ordinary waiter", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        try {
            const lock = new AsyncLock();
            let releaseFirst!: () => void;
            const first = lock.inLock(async () => {
                await new Promise<void>((resolve) => { releaseFirst = resolve; });
            });
            await vi.advanceTimersByTimeAsync(0);

            const expiredOperation = vi.fn();
            const nextOperation = vi.fn(() => "next");
            const expired = lock.inLock(expiredOperation, { deadlineAtMs: 2_025 });
            const next = lock.inLock(nextOperation);

            vi.setSystemTime(2_025);
            releaseFirst();
            await Promise.allSettled([first, expired, next]);

            await expect(expired).rejects.toMatchObject({ name: "LockAdmissionDeadlineExceededError" });
            expect(expiredOperation).not.toHaveBeenCalled();
            expect(nextOperation).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
