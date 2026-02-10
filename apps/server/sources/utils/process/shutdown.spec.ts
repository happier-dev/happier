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

    it("runs keepAlive handlers before non-keepAlive shutdown handlers (ordering)", async () => {
        const { initiateShutdown, keepAlive, onShutdown } = await loadShutdownModule();

        const order: string[] = [];

        // Register a normal shutdown handler first (so insertion order would normally run it first).
        onShutdown("db", async () => {
            order.push("db:start");
        });

        let resolveWork: () => void = () => {
            throw new Error("Expected keepAlive work resolver to be set");
        };
        const work = new Promise<void>((resolve) => {
            resolveWork = () => resolve();
        });

        // Start a keepAlive operation that won't complete until we release it.
        // We do not await it yet; shutdown should first wait for keepAlive ops to finish.
        void keepAlive("op", async () => {
            order.push("keepAlive:work:start");
            await work;
            order.push("keepAlive:work:done");
        });

        await Promise.resolve(); // allow keepAlive to register its onShutdown handler

        // Trigger shutdown. The keepAlive shutdown handler should run before "db".
        const shutdown = initiateShutdown("test");
        // Unblock the keepAlive operation.
        resolveWork();
        await shutdown;

        expect(order[0]).toBe("keepAlive:work:start");
        // Ensure keepAlive operation finishes before db handler runs.
        expect(order).toEqual(["keepAlive:work:start", "keepAlive:work:done", "db:start"]);
    });
});
