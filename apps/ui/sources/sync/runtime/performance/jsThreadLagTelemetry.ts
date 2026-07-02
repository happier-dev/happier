import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

export type JsThreadLagTelemetrySummary = Readonly<{
    count: number;
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
    thresholdExceededCount: number;
    lastSampleAtMs: number;
}>;

export type JsThreadLagTelemetryOptions = Readonly<{
    telemetry: SyncPerformanceTelemetry;
    sampleIntervalMs?: number;
    flushIntervalMs?: number;
    thresholdMs?: number;
    maxSamples?: number;
    now?: () => number;
}>;

export type JsThreadLagTelemetry = Readonly<{
    start(): boolean;
    stop(): void;
    reset(): void;
    isRunning(): boolean;
    recordSample(lagMs: number, sampledAtMs?: number): void;
    snapshot(): JsThreadLagTelemetrySummary;
    flushSummary(): JsThreadLagTelemetrySummary;
}>;

const DEFAULT_SAMPLE_INTERVAL_MS = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_THRESHOLD_MS = 50;
const DEFAULT_MAX_SAMPLES = 512;

function defaultNow(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function percentile(sortedValues: readonly number[], percentileValue: number): number {
    if (sortedValues.length === 0) return 0;
    const index = Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1);
    return sortedValues[Math.min(index, sortedValues.length - 1)] ?? 0;
}

export function createJsThreadLagTelemetry(options: JsThreadLagTelemetryOptions): JsThreadLagTelemetry {
    const sampleIntervalMs = normalizePositiveInteger(options.sampleIntervalMs, DEFAULT_SAMPLE_INTERVAL_MS, 1, 60_000);
    const flushIntervalMs = normalizePositiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 1_000, 10 * 60_000);
    const thresholdMs = normalizePositiveInteger(options.thresholdMs, DEFAULT_THRESHOLD_MS, 1, 60_000);
    const maxSamples = normalizePositiveInteger(options.maxSamples, DEFAULT_MAX_SAMPLES, 1, 100_000);
    const now = options.now ?? defaultNow;
    const samples: number[] = [];
    let thresholdExceededCount = 0;
    let lastSampleAtMs = 0;
    let expectedAtMs = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimer(): void {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
    }

    function clearFlushTimer(): void {
        if (!flushTimer) return;
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    function recordSample(lagMs: number, sampledAtMs = now()): void {
        const safeLagMs = Math.max(0, Number.isFinite(lagMs) ? Math.trunc(lagMs) : 0);
        samples.push(safeLagMs);
        if (samples.length > maxSamples) {
            const removed = samples.shift();
            if (typeof removed === 'number' && removed > thresholdMs) {
                thresholdExceededCount = Math.max(0, thresholdExceededCount - 1);
            }
        }
        if (safeLagMs > thresholdMs) {
            thresholdExceededCount += 1;
        }
        lastSampleAtMs = Math.max(0, Number.isFinite(sampledAtMs) ? Math.trunc(sampledAtMs) : 0);
    }

    function scheduleNext(): void {
        timer = setTimeout(() => {
            const sampledAtMs = now();
            recordSample(sampledAtMs - expectedAtMs, sampledAtMs);
            expectedAtMs = sampledAtMs + sampleIntervalMs;
            scheduleNext();
        }, sampleIntervalMs);
    }

    function flushSummary(): JsThreadLagTelemetrySummary {
        const summary = snapshot();
        options.telemetry.count('sync.runtime.jsThreadLag.summary', summary);
        return summary;
    }

    function flushAndResetIfSamples(): void {
        if (samples.length === 0 || !options.telemetry.isEnabled()) return;
        flushSummary();
        samples.length = 0;
        thresholdExceededCount = 0;
        lastSampleAtMs = 0;
    }

    function scheduleFlush(): void {
        flushTimer = setTimeout(() => {
            flushAndResetIfSamples();
            scheduleFlush();
        }, flushIntervalMs);
    }

    function snapshot(): JsThreadLagTelemetrySummary {
        const sorted = [...samples].sort((a, b) => a - b);
        return {
            count: sorted.length,
            p50Ms: percentile(sorted, 50),
            p99Ms: percentile(sorted, 99),
            maxMs: sorted[sorted.length - 1] ?? 0,
            thresholdExceededCount,
            lastSampleAtMs,
        };
    }

    return {
        start(): boolean {
            if (timer) return false;
            if (!options.telemetry.isEnabled()) return false;
            expectedAtMs = now() + sampleIntervalMs;
            scheduleNext();
            scheduleFlush();
            return true;
        },
        stop(): void {
            clearTimer();
            clearFlushTimer();
        },
        reset(): void {
            samples.length = 0;
            thresholdExceededCount = 0;
            lastSampleAtMs = 0;
            if (timer) {
                expectedAtMs = now() + sampleIntervalMs;
            }
        },
        isRunning(): boolean {
            return timer !== null;
        },
        recordSample,
        snapshot,
        flushSummary,
    };
}
