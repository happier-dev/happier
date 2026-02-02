import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initiateShutdown = vi.fn(async () => {});
vi.mock("./shutdown", () => ({ initiateShutdown }));

vi.mock("@/utils/log", () => ({ log: vi.fn() }));

beforeEach(() => {
    initiateShutdown.mockClear();
});

function registerAndCaptureNewListeners() {
    const events = ["uncaughtException", "unhandledRejection", "warning", "exit"] as const;
    const beforeByEvent = new Map<string, any[]>();
    for (const ev of events) {
        beforeByEvent.set(ev, process.listeners(ev as any));
    }

    return {
        events,
        beforeByEvent,
        afterCapture: () => {
            const added: Array<{ event: string; handler: any }> = [];
            for (const ev of events) {
                const before = beforeByEvent.get(ev) ?? [];
                const after = process.listeners(ev as any);
                for (const fn of after) {
                    if (!before.includes(fn)) {
                        added.push({ event: ev, handler: fn });
                    }
                }
            }
            return added;
        },
    };
}

describe("registerProcessHandlers", () => {
    let addedListeners: Array<{ event: string; handler: any }> = [];

    afterEach(() => {
        for (const { event, handler } of addedListeners) {
            process.off(event as any, handler);
        }
        addedListeners = [];
        (globalThis as any).__HAPPY_PROCESS_HANDLERS_INSTALLED = false;
        process.exitCode = undefined;
    });

    it("initiates shutdown and exits on uncaughtException", async () => {
        const capture = registerAndCaptureNewListeners();

        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            // do nothing
            return undefined as never;
        }) as any);

        const originalNodeEnv = process.env.NODE_ENV;
        const originalExitOnFatal = process.env.HAPPY_EXIT_ON_FATAL;
        process.env.NODE_ENV = "production";
        process.env.HAPPY_EXIT_ON_FATAL = "1";

        vi.resetModules();
        const { registerProcessHandlers } = await import("./processHandlers");
        registerProcessHandlers();

        addedListeners = capture.afterCapture();
        const handler = addedListeners.find((v) => v.event === "uncaughtException")?.handler;
        expect(typeof handler).toBe("function");

        handler!(new Error("boom"));
        await new Promise((r) => setImmediate(r));

        expect(initiateShutdown).toHaveBeenCalledWith("fatal:uncaughtException");
        expect(process.exitCode).toBe(1);
        expect(exitSpy).toHaveBeenCalledWith(1);
        exitSpy.mockRestore();
        process.env.NODE_ENV = originalNodeEnv;
        process.env.HAPPY_EXIT_ON_FATAL = originalExitOnFatal;
    });

    it("initiates shutdown and does not hard-exit in test mode", async () => {
        const capture = registerAndCaptureNewListeners();

        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            return undefined as never;
        }) as any);

        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "test";

        vi.resetModules();
        const { registerProcessHandlers } = await import("./processHandlers");
        registerProcessHandlers();

        addedListeners = capture.afterCapture();
        const handler = addedListeners.find((v) => v.event === "unhandledRejection")?.handler;
        expect(typeof handler).toBe("function");

        handler!("nope", Promise.resolve());
        await new Promise((r) => setImmediate(r));

        expect(initiateShutdown).toHaveBeenCalledWith("fatal:unhandledRejection");
        expect(process.exitCode).toBe(1);
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockRestore();
        process.env.NODE_ENV = originalNodeEnv;
    });
});
