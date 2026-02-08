import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadShutdownModule() {
    vi.resetModules();
    return await import("./shutdown");
}

describe("shutdown", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("awaitShutdown resolves when shutdown is initiated programmatically", async () => {
        const { awaitShutdown, initiateShutdown, isShutdown } = await loadShutdownModule();

        const p = awaitShutdown();
        await initiateShutdown("test");

        await p;
        expect(isShutdown()).toBe(true);
    });

    it("runs shutdown handlers once even when initiateShutdown is called multiple times", async () => {
        const { initiateShutdown, onShutdown } = await loadShutdownModule();

        const handler = vi.fn(async () => {});
        onShutdown("test", handler);

        await Promise.all([initiateShutdown("first"), initiateShutdown("second")]);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it("supports unsubscribing handlers before shutdown", async () => {
        const { initiateShutdown, onShutdown } = await loadShutdownModule();

        const handler = vi.fn(async () => {});
        const unsubscribe = onShutdown("test", handler);
        unsubscribe();

        await initiateShutdown("test");
        expect(handler).not.toHaveBeenCalled();
    });

    it("executes new handlers immediately after shutdown has started", async () => {
        const { initiateShutdown, onShutdown } = await loadShutdownModule();
        await initiateShutdown("test");

        const handler = vi.fn(async () => {});
        onShutdown("late", handler);
        await Promise.resolve();

        expect(handler).toHaveBeenCalledTimes(1);
    });
});
