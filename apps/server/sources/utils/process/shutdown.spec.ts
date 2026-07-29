import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadShutdownModule() {
    vi.resetModules();
    return await import("./shutdown");
}

describe("shutdown", () => {
    const originalShutdownDeadlineMs = process.env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS;

    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        if (originalShutdownDeadlineMs === undefined) {
            delete process.env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS;
        } else {
            process.env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS = originalShutdownDeadlineMs;
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
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

    it("forces process exit when shutdown handlers exceed the configured deadline", async () => {
        vi.useFakeTimers();
        process.env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS = "25";
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        const { initiateShutdown, onShutdown } = await loadShutdownModule();
        onShutdown("hung", async () => {
            await new Promise(() => {});
        });

        void initiateShutdown("test");
        await vi.advanceTimersByTimeAsync(24);
        expect(exitSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("clears the shutdown deadline when handlers finish before it fires", async () => {
        vi.useFakeTimers();
        process.env.HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS = "50";
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        const { initiateShutdown, onShutdown } = await loadShutdownModule();
        onShutdown("fast", async () => {});

        await initiateShutdown("test");
        await vi.advanceTimersByTimeAsync(50);

        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("runs api socket shutdown before api http shutdown and database teardown", async () => {
        const { initiateShutdown, onShutdown } = await loadShutdownModule();
        const order: string[] = [];

        onShutdown("db", async () => {
            order.push("db");
        });
        onShutdown("api:http", async () => {
            order.push("api:http");
        });
        onShutdown("api:socket", async () => {
            order.push("api:socket");
        });

        await initiateShutdown("test");

        expect(order).toEqual(["api:socket", "api:http", "db"]);
    });
});
