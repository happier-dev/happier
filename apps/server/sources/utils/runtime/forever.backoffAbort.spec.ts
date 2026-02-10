import { describe, expect, it, vi } from "vitest";

describe("forever", () => {
    it("does not block shutdown while waiting in backoff delay", async () => {
        vi.resetModules();

        const shutdown = await import("../process/shutdown");

        const { forever } = await import("./forever");

        // Start a background task that will immediately fail and enter the backoff delay.
        void forever("test-forever-backoff-abort", async () => {
            throw new Error("boom");
        });

        // Allow the keepAlive handler registration + first backoff iteration to start.
        await new Promise((r) => setTimeout(r, 0));

        const result = await Promise.race([
            shutdown.initiateShutdown("test").then(() => "done" as const),
            new Promise((r) => setTimeout(() => r("timeout" as const), 50)),
        ]);

        expect(result).toBe("done");
    });
});
