import type { ServerResponse } from "node:http";
import { constants, monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import type { Socket } from "socket.io";

import { Counter, Gauge } from "prom-client";
import { trimProcessAllocator } from "@happier-dev/iroh-native/node";
import { onShutdown } from "@/utils/process/shutdown";
import { readMetricsServerConfigFromEnv } from "@/config/monitoring";
import { log } from "@/utils/logging/log";

import { getOrCreateMetric, register } from "./registry";

type RuntimeGcKind = "major" | "minor" | "incremental" | "weakcb";

const RUNTIME_GC_KINDS: readonly RuntimeGcKind[] = [
    "major",
    "minor",
    "incremental",
    "weakcb",
];

const runtimeMetricsEnabled = readMetricsServerConfigFromEnv(process.env).enabled;

const EVENT_LOOP_SAMPLE_MS = 20;
const LONG_BLOCK_MS = 1000;
const inFlightHttpRoutes = new Map<ServerResponse, { route: string; startedAtMs: number }>();
const inFlightSocketEvents = new Set<{ event: string; startedAtMs: number }>();
let lastSampleAt = performance.now();

function reportLongBlock(now: number): void {
    // Measuring from the last sample avoids missing a full second of blocking
    // just after a tick. The estimate can include up to one sampling interval.
    const durationMs = now - lastSampleAt;
    if (durationMs < LONG_BLOCK_MS) return;
    lastSampleAt = now;
    log({
        module: "runtime-metrics",
        level: "warn",
        durationMs: Math.round(durationMs),
        httpRoutes: Array.from(inFlightHttpRoutes.values()),
        socketEvents: Array.from(inFlightSocketEvents),
    }, "Long event-loop block");
}

export function trackRuntimeHttpRequest(response: ServerResponse, route: string, startedAtMs: number): void {
    inFlightHttpRoutes.set(response, { route, startedAtMs });
    // A closed client may never produce a Fastify onResponse callback.
    response.on("close", finishClosedHttpRequest);
}

function finishClosedHttpRequest(this: ServerResponse): void {
    finishRuntimeHttpRequest(this);
}

export function finishRuntimeHttpRequest(response: ServerResponse): string | undefined {
    const request = inFlightHttpRoutes.get(response);
    if (!request) return;
    // Recovery can finish the blocking request before the timer callback runs.
    reportLongBlock(performance.now());
    inFlightHttpRoutes.delete(response);
    response.removeListener("close", finishClosedHttpRequest);
    return request.route;
}

export function trackRuntimeSocketHandlers(socket: Socket): void {
    const registerHandler = socket.on;
    socket.on = function (event, handler) {
        // The application's registration supplies the template. Lifecycle listeners
        // such as disconnect retain their original registration and removal behavior.
        if (typeof event !== "string" || event === "disconnect" || event === "disconnecting"
            || event === "error" || event === "newListener" || event === "removeListener") {
            return registerHandler.call(this, event, handler);
        }
        const trackedHandler = function (this: Socket, ...args: unknown[]) {
            const work = { event, startedAtMs: Date.now() };
            inFlightSocketEvents.add(work);
            let result: unknown;
            try {
                result = Reflect.apply(handler, this, args);
            } catch (error) {
                finishRuntimeSocketEvent(work);
                throw error;
            }
            if (result instanceof Promise) {
                return result.finally(() => finishRuntimeSocketEvent(work));
            }
            finishRuntimeSocketEvent(work);
            return result;
        };
        return registerHandler.call(this, event, Object.assign(trackedHandler, { listener: handler }));
    };
}

function finishRuntimeSocketEvent(work: { event: string; startedAtMs: number }): void {
    reportLongBlock(performance.now());
    inFlightSocketEvents.delete(work);
}

export const runtimeEventLoopLagSecondsGauge = getOrCreateMetric("runtime_event_loop_lag_seconds", () => {
    const timer = setInterval(() => {
        const now = performance.now();
        reportLongBlock(now);
        lastSampleAt = now;
    }, EVENT_LOOP_SAMPLE_MS).unref();
    const eventLoopDelayMonitor = runtimeMetricsEnabled
        ? monitorEventLoopDelay({ resolution: EVENT_LOOP_SAMPLE_MS })
        : undefined;
    eventLoopDelayMonitor?.enable();
    onShutdown("runtime-metrics", async () => {
        clearInterval(timer);
        eventLoopDelayMonitor?.disable();
    });
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
if ((runtimeMetricsEnabled || process.platform === "linux") && !runtimeGcMetricsAlreadyRegistered) {
    let allocatorReleasePending = false;
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
            if (kind && runtimeMetricsEnabled) recordRuntimeGcEvent({ kind, durationMs: entry.duration });
            // glibc can keep freed native pages resident after allocation churn.
            // Reuse collection delivery rather than adding a maintenance timer.
            // The native owner runs malloc_trim on Node's existing worker pool.
            if (kind === "major" && process.platform === "linux" && !allocatorReleasePending) {
                allocatorReleasePending = true;
                void trimProcessAllocator().catch(() => {
                    log({ module: "runtime-metrics", level: "warn" }, "Native allocator release unavailable");
                }).finally(() => {
                    allocatorReleasePending = false;
                });
            }
        }
    });
    observer.observe({ entryTypes: ["gc"] });
    onShutdown("runtime-metrics", async () => {
        observer.disconnect();
    });
}
