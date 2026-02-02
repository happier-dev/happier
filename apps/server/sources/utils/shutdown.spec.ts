import { describe, expect, it } from "vitest";

describe("shutdown", () => {
    it("awaitShutdown resolves when shutdown is initiated programmatically", async () => {
        const { awaitShutdown, initiateShutdown, isShutdown } = await import("./shutdown");

        const p = awaitShutdown();
        await initiateShutdown("test");

        await p;
        expect(isShutdown()).toBe(true);
    });
});

