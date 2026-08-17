import { describe, expect, it, vi } from "vitest";

import { AsyncLock } from "./lock";

describe("AsyncLock bounded admission", () => {
    it("removes an expired waiter without starting it later or blocking its ordinary neighbor", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        try {
            const lock = new AsyncLock();
            let releaseFirst!: () => void;
            const first = lock.inLock(async () => await new Promise<void>((resolve) => { releaseFirst = resolve; }));
            await vi.advanceTimersByTimeAsync(0);

            const expiredOperation = vi.fn();
            const nextOperation = vi.fn(() => "next");
            const expired = lock.inLock(expiredOperation, { deadlineAtMs: 1_025 });
            const next = lock.inLock(nextOperation);

            await vi.advanceTimersByTimeAsync(25);
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
