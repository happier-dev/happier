import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants, type PerformanceEntry, type PerformanceObserverCallback } from "node:perf_hooks";

const boundary = vi.hoisted(() => ({
    trim: vi.fn<() => Promise<boolean>>(),
    observers: [] as Array<{ callback: PerformanceObserverCallback; active: boolean }>,
}));

// GC delivery and native allocation are OS boundaries; metric and shutdown owners stay real.
vi.mock("node:perf_hooks", async (importOriginal) => {
    const native = await importOriginal<typeof import("node:perf_hooks")>();
    return {
        ...native,
        PerformanceObserver: class {
            private readonly state;
            constructor(callback: PerformanceObserverCallback) {
                this.state = { callback, active: false };
                boundary.observers.push(this.state);
            }
            observe() { this.state.active = true; }
            disconnect() { this.state.active = false; }
        },
    };
});
vi.mock("@happier-dev/iroh-native/node", () => ({ trimProcessAllocator: boundary.trim }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

function collect(kind: number): void {
    const entry: PerformanceEntry & { detail: { kind: number } } = {
        name: "gc", entryType: "gc", startTime: 0, duration: 1,
        detail: { kind }, toJSON: () => ({}),
    };
    for (const observer of boundary.observers) {
        if (observer.active) observer.callback({
            getEntries: () => [entry],
            getEntriesByName: () => [entry],
            getEntriesByType: () => [entry],
        }, {} as InstanceType<typeof import("node:perf_hooks").PerformanceObserver>);
    }
}

async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
    vi.stubEnv("METRICS_ENABLED", "false");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    boundary.trim.mockReset().mockResolvedValue(false);
    boundary.observers.length = 0;
});

afterEach(async () => {
    const { initiateShutdown } = await import("@/utils/process/shutdown");
    await initiateShutdown("allocator-maintenance-test");
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("server allocator maintenance", () => {
    it("releases free native pages after major GC even without a metrics exporter", async () => {
        await import("./runtimeMetrics");
        collect(constants.NODE_PERFORMANCE_GC_MINOR);
        await settle();
        expect(boundary.trim).not.toHaveBeenCalled();
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        expect(boundary.trim).toHaveBeenCalledTimes(1);
    });

    it("keeps one native release in flight across repeated collections", async () => {
        let complete!: (released: boolean) => void;
        boundary.trim.mockReturnValueOnce(new Promise<boolean>((resolve) => { complete = resolve; }));
        await import("./runtimeMetrics");
        for (let i = 0; i < 100; i++) collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        expect(boundary.trim).toHaveBeenCalledTimes(1);
        complete(true);
        await settle();
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        expect(boundary.trim).toHaveBeenCalledTimes(2);
    });

    it("continues serving and permits a later release when the optional native addon fails", async () => {
        boundary.trim.mockRejectedValueOnce(new Error("native addon unavailable"));
        await import("./runtimeMetrics");
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        expect(boundary.trim).toHaveBeenCalledTimes(2);
    });

    it("stops maintenance at server shutdown", async () => {
        await import("./runtimeMetrics");
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("allocator-maintenance-test");
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        expect(boundary.trim).toHaveBeenCalledTimes(1);
    });

    it.each(["darwin", "win32"])("does not load native maintenance on %s", async (value) => {
        Object.defineProperty(process, "platform", { ...platform, value });
        await import("./runtimeMetrics");
        collect(constants.NODE_PERFORMANCE_GC_MAJOR);
        await settle();
        expect(boundary.trim).not.toHaveBeenCalled();
    });
});
