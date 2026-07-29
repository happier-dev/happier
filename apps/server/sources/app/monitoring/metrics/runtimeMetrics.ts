import { monitorEventLoopDelay } from "node:perf_hooks";

import { Counter, Gauge } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type RuntimeGcKind = "major" | "minor" | "incremental" | "weakcb";

const RUNTIME_GC_KINDS: readonly RuntimeGcKind[] = [
    "major",
    "minor",
    "incremental",
    "weakcb",
];

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

export const runtimeEventLoopLagSecondsGauge = getOrCreateMetric("runtime_event_loop_lag_seconds", () => new Gauge({
    name: "runtime_event_loop_lag_seconds",
    help: "Observed event loop lag in seconds",
    labelNames: ["stat"] as const,
    registers: [register],
    collect() {
        this.set({ stat: "mean" }, eventLoopDelayMonitor.mean / 1_000_000_000);
        this.set({ stat: "max" }, eventLoopDelayMonitor.max / 1_000_000_000);
    },
}));

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
