import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";

import { Counter, Gauge } from "prom-client";
import { onShutdown } from "@/utils/process/shutdown";
import { readMetricsServerConfigFromEnv } from "@/config/monitoring";

import { getOrCreateMetric, register } from "./registry";

type RuntimeGcKind = "major" | "minor" | "incremental" | "weakcb";

const RUNTIME_GC_KINDS: readonly RuntimeGcKind[] = [
    "major",
    "minor",
    "incremental",
    "weakcb",
];

const runtimeMetricsEnabled = readMetricsServerConfigFromEnv(process.env).enabled;

export const runtimeEventLoopLagSecondsGauge = getOrCreateMetric("runtime_event_loop_lag_seconds", () => {
    // The exporter is the only consumer; a disabled exporter needs no sampler.
    const eventLoopDelayMonitor = runtimeMetricsEnabled ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
    if (eventLoopDelayMonitor) {
        eventLoopDelayMonitor.enable();
        onShutdown("runtime-metrics", async () => {
            eventLoopDelayMonitor.disable();
        });
    }
    return new Gauge({
        name: "runtime_event_loop_lag_seconds",
        help: "Observed event loop lag in seconds",
        labelNames: ["stat"] as const,
        registers: [register],
        collect() {
            if (!eventLoopDelayMonitor) return;
            this.set({ stat: "mean" }, eventLoopDelayMonitor.mean / 1_000_000_000);
            this.set({ stat: "max" }, eventLoopDelayMonitor.max / 1_000_000_000);
        },
    });
});

export const runtimeHeapUsedBytesGauge = getOrCreateMetric("runtime_heap_used_bytes", () => new Gauge({
    name: "runtime_heap_used_bytes",
    help: "Current Node.js heap used in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().heapUsed);
    },
}));

export const runtimeHeapTotalBytesGauge = getOrCreateMetric("runtime_heap_total_bytes", () => new Gauge({
    name: "runtime_heap_total_bytes",
    help: "Current Node.js heap total in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().heapTotal);
    },
}));

export const runtimeRssBytesGauge = getOrCreateMetric("runtime_rss_bytes", () => new Gauge({
    name: "runtime_rss_bytes",
    help: "Current process RSS in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().rss);
    },
}));

export const runtimeExternalBytesGauge = getOrCreateMetric("runtime_external_bytes", () => new Gauge({
    name: "runtime_external_bytes",
    help: "Current external memory in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().external);
    },
}));

const runtimeGcMetricsAlreadyRegistered = register.getSingleMetric("runtime_gc_events_total") !== undefined;

export const runtimeGcEventsCounter = getOrCreateMetric("runtime_gc_events_total", () => new Counter({
    name: "runtime_gc_events_total",
    help: "Cumulative Node.js GC events by kind",
    labelNames: ["kind"] as const,
    registers: [register],
}));

export const runtimeGcDurationSecondsCounter = getOrCreateMetric("runtime_gc_duration_seconds_total", () => new Counter({
    name: "runtime_gc_duration_seconds_total",
    help: "Cumulative Node.js GC duration in seconds by kind",
    labelNames: ["kind"] as const,
    registers: [register],
}));

function initializeRuntimeGcMetrics(): void {
    for (const kind of RUNTIME_GC_KINDS) {
        runtimeGcEventsCounter.inc({ kind }, 0);
        runtimeGcDurationSecondsCounter.inc({ kind }, 0);
    }
}

export function resetRuntimeMetricsTrackingState(): void {
    runtimeGcEventsCounter.reset();
    runtimeGcDurationSecondsCounter.reset();
    initializeRuntimeGcMetrics();
}

export function recordRuntimeGcEvent(params: Readonly<{
    kind: RuntimeGcKind;
    durationMs: number;
}>): void {
    runtimeGcEventsCounter.inc({ kind: params.kind });
    runtimeGcDurationSecondsCounter.inc(
        { kind: params.kind },
        Math.max(0, params.durationMs) / 1000,
    );
}

initializeRuntimeGcMetrics();

// Metric-module re-evaluation reuses the same registry and its existing observer.
if (runtimeMetricsEnabled && !runtimeGcMetricsAlreadyRegistered) {
    const kinds = new Map<number, RuntimeGcKind>([
        [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
        [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
        [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
        [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
    ]);
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            const detail: unknown = "detail" in entry ? entry.detail : undefined;
            if (typeof detail !== "object" || detail === null || !("kind" in detail) || typeof detail.kind !== "number") continue;
            const kind = kinds.get(detail.kind);
            if (kind) recordRuntimeGcEvent({ kind, durationMs: entry.duration });
        }
    });
    observer.observe({ entryTypes: ["gc"] });
    onShutdown("runtime-metrics", async () => {
        observer.disconnect();
    });
}
