import { describe, expect, it, vi } from "vitest";

import { createBackoff } from "./backoff";

describe("createBackoff", () => {
    it("increases the wait after each consecutive failure", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let attempts = 0;

        const run = createBackoff({ minDelay: 100, maxDelay: 1_000, factor: 0 })(
            async () => {
                attempts += 1;
                throw new Error("boom");
            },
            controller.signal,
        ).catch((error: unknown) => error);

        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(attempts).toBe(1);

            await vi.advanceTimersByTimeAsync(99);
            expect(attempts).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(2);

            await vi.advanceTimersByTimeAsync(199);
            expect(attempts).toBe(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(attempts).toBe(3);
        } finally {
            controller.abort();
            await run;
            vi.useRealTimers();
        }
    });
});
