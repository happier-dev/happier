import { afterEach, describe, expect, it, vi } from "vitest";
import type { monitorEventLoopDelay } from "node:perf_hooks";

const monitors = vi.hoisted(() => [] as ReturnType<typeof monitorEventLoopDelay>[]);

// Observe the native sampling boundary; the histogram and GC observer stay real.
vi.mock("node:perf_hooks", async (importOriginal) => {
    const native = await importOriginal<typeof import("node:perf_hooks")>();
    return {
        ...native,
        monitorEventLoopDelay: (options: Parameters<typeof monitorEventLoopDelay>[0]) => {
            const monitor = native.monitorEventLoopDelay(options);
            monitors.push(monitor);
            return monitor;
        },
    };
});

afterEach(async () => {
    const { initiateShutdown } = await import("@/utils/process/shutdown");
    await initiateShutdown("runtime-metrics-exporter-test");
    monitors.length = 0;
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("runtime metric sampling demand", () => {
    it("installs zero native event-loop samplers when the exporter is disabled", async () => {
        vi.stubEnv("METRICS_ENABLED", "false");
        await import("./runtimeMetrics");
        expect(monitors).toHaveLength(0);
    });

    it("samples for an enabled exporter and stops at shutdown", async () => {
        vi.stubEnv("METRICS_ENABLED", "true");
        const { runtimeEventLoopLagSecondsGauge } = await import("./runtimeMetrics");
        expect(monitors).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 80));
        const metric = await runtimeEventLoopLagSecondsGauge.get();
        expect(metric.values.find(value => value.labels.stat === "max")?.value).toBeGreaterThan(0);
        const { initiateShutdown } = await import("@/utils/process/shutdown");
        await initiateShutdown("runtime-metrics-exporter-test");
        const samples = monitors[0]!.count;
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(monitors[0]!.count).toBe(samples);
    });
});
