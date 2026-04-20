import { monitorEventLoopDelay } from "node:perf_hooks";

import { Gauge } from "prom-client";

import { register } from "./registry";

const eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelayMonitor.enable();

export const runtimeEventLoopLagSecondsGauge = new Gauge({
    name: "runtime_event_loop_lag_seconds",
    help: "Observed event loop lag in seconds",
    labelNames: ["stat"] as const,
    registers: [register],
    collect() {
        this.set({ stat: "mean" }, eventLoopDelayMonitor.mean / 1_000_000_000);
        this.set({ stat: "max" }, eventLoopDelayMonitor.max / 1_000_000_000);
    },
});

export const runtimeHeapUsedBytesGauge = new Gauge({
    name: "runtime_heap_used_bytes",
    help: "Current Node.js heap used in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().heapUsed);
    },
});

export const runtimeHeapTotalBytesGauge = new Gauge({
    name: "runtime_heap_total_bytes",
    help: "Current Node.js heap total in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().heapTotal);
    },
});

export const runtimeRssBytesGauge = new Gauge({
    name: "runtime_rss_bytes",
    help: "Current process RSS in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().rss);
    },
});

export const runtimeExternalBytesGauge = new Gauge({
    name: "runtime_external_bytes",
    help: "Current external memory in bytes",
    registers: [register],
    collect() {
        this.set(process.memoryUsage().external);
    },
});
