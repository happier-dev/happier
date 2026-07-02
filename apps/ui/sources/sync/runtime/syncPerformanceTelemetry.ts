export type SyncPerformanceTelemetryFields = Readonly<Record<string, unknown>>;

export type SyncPerformanceTelemetryFieldStat = Readonly<{
    sum: number;
    min: number;
    max: number;
    last: number;
}>;

export type SyncPerformanceTelemetryDurationBuckets = Readonly<Record<string, number>>;

export type SyncPerformanceTelemetryEvent = Readonly<{
    name: string;
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    slowCount: number;
    durationBuckets: SyncPerformanceTelemetryDurationBuckets;
    fields: Readonly<Record<string, number>>;
    fieldStats: Readonly<Record<string, SyncPerformanceTelemetryFieldStat>>;
}>;

export type SyncPerformanceTelemetrySummary = Readonly<{
    events: SyncPerformanceTelemetryEvent[];
}>;

type SyncPerformanceTelemetryOptions = Readonly<{
    enabled?: boolean;
    slowThresholdMs?: number;
    flushIntervalMs?: number;
    now?: () => number;
    emitSummary?: (summary: SyncPerformanceTelemetrySummary) => void;
}>;

type SyncPerformanceTelemetryGlobalLifecycleHooks = Readonly<{
    telemetry?: SyncPerformanceTelemetry;
    beforeCollect?: () => void;
    reset?: () => void;
}>;

type SyncPerformanceTelemetryGlobalConfigureOptions = Readonly<{
    enabled?: boolean;
    flushIntervalMs?: number;
    slowThresholdMs?: number;
}>;

type RegisteredSyncPerformanceTelemetryLifecycleHook = Readonly<{
    telemetry: SyncPerformanceTelemetry;
    hook: () => void;
}>;

type MutableTelemetryEvent = {
    name: string;
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    slowCount: number;
    durationBuckets: Record<string, number>;
    fields: Record<string, number>;
    fieldStats: Record<string, SyncPerformanceTelemetryFieldStat>;
};

const DEFAULT_SLOW_THRESHOLD_MS = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DURATION_BUCKETS_MS = [1, 4, 16, 64, 256, 1024, 4096, 16384] as const;
const DURATION_BUCKET_OVERFLOW = 'inf';
const globalBeforeCollectHooks = new Set<RegisteredSyncPerformanceTelemetryLifecycleHook>();
const globalResetHooks = new Set<RegisteredSyncPerformanceTelemetryLifecycleHook>();
const telemetryInstancesCollectingHooks = new Set<SyncPerformanceTelemetry>();

function defaultNow(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function readDevFlag(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : fallback;
}

function sanitizeFields(fields: SyncPerformanceTelemetryFields | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    if (!fields) return out;
    for (const [key, value] of Object.entries(fields)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        out[key] = value;
    }
    return out;
}

function getDurationBucketKey(durationMs: number): string {
    for (const bucketMs of DURATION_BUCKETS_MS) {
        if (durationMs <= bucketMs) {
            return String(bucketMs);
        }
    }
    return DURATION_BUCKET_OVERFLOW;
}

function readDurationBucketValue(bucketKey: string, fallbackMaxMs: number): number {
    if (bucketKey === DURATION_BUCKET_OVERFLOW) {
        return fallbackMaxMs;
    }
    const value = Number(bucketKey);
    return Number.isFinite(value) ? value : fallbackMaxMs;
}

function sanitizeScenarioName(name: string): string {
    const sanitized = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
    return sanitized.length > 0 ? sanitized : 'unnamed';
}

function sortedDurationBucketKeys(durationBuckets: SyncPerformanceTelemetryDurationBuckets): string[] {
    return Object.keys(durationBuckets).sort((left, right) => {
        if (left === DURATION_BUCKET_OVERFLOW) return 1;
        if (right === DURATION_BUCKET_OVERFLOW) return -1;
        return Number(left) - Number(right);
    });
}

function approximatePercentileFromBuckets(
    durationBuckets: SyncPerformanceTelemetryDurationBuckets,
    percentile: number,
    maxMs: number,
): number {
    const total = Object.values(durationBuckets).reduce((sum, count) => sum + count, 0);
    if (total <= 0) return 0;
    const target = Math.max(1, Math.ceil((total * percentile) / 100));
    let seen = 0;
    for (const bucketKey of sortedDurationBucketKeys(durationBuckets)) {
        seen += durationBuckets[bucketKey] ?? 0;
        if (seen >= target) {
            return readDurationBucketValue(bucketKey, maxMs);
        }
    }
    return maxMs;
}

export class SyncPerformanceTelemetry {
    private enabled: boolean;
    private slowThresholdMs: number;
    private flushIntervalMs: number;
    private lastFlushAtMs: number;
    private readonly now: () => number;
    private emitSummary: ((summary: SyncPerformanceTelemetrySummary) => void) | null;
    private readonly events = new Map<string, MutableTelemetryEvent>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options?: SyncPerformanceTelemetryOptions) {
        this.enabled = options?.enabled === true;
        this.slowThresholdMs = normalizePositiveNumber(options?.slowThresholdMs, DEFAULT_SLOW_THRESHOLD_MS);
        this.flushIntervalMs = normalizePositiveNumber(options?.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
        this.now = options?.now ?? defaultNow;
        this.emitSummary = options?.emitSummary ?? null;
        this.lastFlushAtMs = this.now();
    }

    configure(options: SyncPerformanceTelemetryOptions): void {
        this.clearFlushTimer();
        this.enabled = options.enabled === true;
        this.slowThresholdMs = normalizePositiveNumber(options.slowThresholdMs, this.slowThresholdMs);
        this.flushIntervalMs = normalizePositiveNumber(options.flushIntervalMs, this.flushIntervalMs);
        this.emitSummary = options.emitSummary ?? this.emitSummary;
        this.lastFlushAtMs = this.now();
        if (!this.enabled) {
            this.reset();
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    measure<T>(name: string, fields: SyncPerformanceTelemetryFields | undefined, fn: () => T): T {
        if (!this.enabled) {
            return fn();
        }
        const startedAt = this.now();
        try {
            return fn();
        } finally {
            this.recordDuration(name, this.now() - startedAt, fields);
        }
    }

    async measureAsync<T>(name: string, fields: SyncPerformanceTelemetryFields | undefined, fn: () => Promise<T>): Promise<T> {
        if (!this.enabled) {
            return fn();
        }
        const startedAt = this.now();
        try {
            return await fn();
        } finally {
            this.recordDuration(name, this.now() - startedAt, fields);
        }
    }

    count(name: string, fields?: SyncPerformanceTelemetryFields): void {
        this.recordDuration(name, 0, fields);
    }

    recordDuration(name: string, durationMs: number, fields?: SyncPerformanceTelemetryFields): void {
        if (!this.enabled) return;
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const safeDuration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
        const sanitizedFields = sanitizeFields(fields);
        const existing = this.events.get(trimmedName);
        const event = existing ?? {
            name: trimmedName,
            count: 0,
            totalMs: 0,
            minMs: safeDuration,
            maxMs: safeDuration,
            slowCount: 0,
            durationBuckets: {},
            fields: {},
            fieldStats: {},
        };

        event.count += 1;
        event.totalMs += safeDuration;
        event.minMs = Math.min(event.minMs, safeDuration);
        event.maxMs = Math.max(event.maxMs, safeDuration);
        if (safeDuration >= this.slowThresholdMs) {
            event.slowCount += 1;
        }
        const durationBucketKey = getDurationBucketKey(safeDuration);
        event.durationBuckets[durationBucketKey] = (event.durationBuckets[durationBucketKey] ?? 0) + 1;
        for (const [field, value] of Object.entries(sanitizedFields)) {
            event.fields[field] = (event.fields[field] ?? 0) + value;
            const existingStat = event.fieldStats[field];
            event.fieldStats[field] = existingStat
                ? {
                    sum: existingStat.sum + value,
                    min: Math.min(existingStat.min, value),
                    max: Math.max(existingStat.max, value),
                    last: value,
                }
                : {
                    sum: value,
                    min: value,
                    max: value,
                    last: value,
                };
        }
        if (!existing) {
            this.events.set(trimmedName, event);
        }
        if (!telemetryInstancesCollectingHooks.has(this)) {
            this.flushIfDue();
            this.scheduleFlushIfNeeded();
        }
    }

    snapshot(): SyncPerformanceTelemetrySummary {
        runGlobalBeforeCollectHooks(this);
        return this.createSnapshot();
    }

    private createSnapshot(): SyncPerformanceTelemetrySummary {
        return {
            events: Array.from(this.events.values()).map((event) => ({
                name: event.name,
                count: event.count,
                totalMs: event.totalMs,
                minMs: event.minMs,
                maxMs: event.maxMs,
                p50Ms: approximatePercentileFromBuckets(event.durationBuckets, 50, event.maxMs),
                p90Ms: approximatePercentileFromBuckets(event.durationBuckets, 90, event.maxMs),
                p99Ms: approximatePercentileFromBuckets(event.durationBuckets, 99, event.maxMs),
                slowCount: event.slowCount,
                durationBuckets: { ...event.durationBuckets },
                fields: { ...event.fields },
                fieldStats: Object.fromEntries(
                    Object.entries(event.fieldStats).map(([field, stats]) => [field, { ...stats }]),
                ),
            })),
        };
    }

    flushSummary(): SyncPerformanceTelemetrySummary | null {
        this.clearFlushTimer();
        runGlobalBeforeCollectHooks(this);
        if (this.events.size === 0) return null;
        const summary = this.createSnapshot();
        this.reset();
        this.lastFlushAtMs = this.now();
        return summary;
    }

    reset(): void {
        this.clearFlushTimer();
        this.events.clear();
        runGlobalResetHooks(this);
    }

    private clearFlushTimer(): void {
        if (!this.flushTimer) return;
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
    }

    private scheduleFlushIfNeeded(): void {
        if (!this.emitSummary || this.flushTimer || this.events.size === 0) return;
        const elapsedMs = Math.max(0, this.now() - this.lastFlushAtMs);
        const delayMs = Math.max(0, this.flushIntervalMs - elapsedMs);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            const summary = this.flushSummary();
            if (summary) {
                this.emitSummary?.(summary);
            }
        }, delayMs);
    }

    private flushIfDue(): void {
        if (!this.emitSummary) return;
        if (this.now() - this.lastFlushAtMs < this.flushIntervalMs) return;
        const summary = this.flushSummary();
        if (summary) {
            this.emitSummary(summary);
        }
    }
}

export function createSyncPerformanceTelemetry(options?: SyncPerformanceTelemetryOptions): SyncPerformanceTelemetry {
    return new SyncPerformanceTelemetry(options);
}

export const syncPerformanceTelemetry = createSyncPerformanceTelemetry();

function runGlobalBeforeCollectHooks(telemetry: SyncPerformanceTelemetry): void {
    if (telemetryInstancesCollectingHooks.has(telemetry)) return;
    telemetryInstancesCollectingHooks.add(telemetry);
    try {
        for (const entry of Array.from(globalBeforeCollectHooks)) {
            if (entry.telemetry === telemetry) {
                entry.hook();
            }
        }
    } finally {
        telemetryInstancesCollectingHooks.delete(telemetry);
    }
}

function runGlobalResetHooks(telemetry: SyncPerformanceTelemetry): void {
    for (const entry of Array.from(globalResetHooks)) {
        if (entry.telemetry === telemetry) {
            entry.hook();
        }
    }
}

export function registerSyncPerformanceTelemetryGlobalLifecycleHooks(
    hooks: SyncPerformanceTelemetryGlobalLifecycleHooks,
): () => void {
    const telemetry = hooks.telemetry ?? syncPerformanceTelemetry;
    const beforeCollectEntry = hooks.beforeCollect
        ? { telemetry, hook: hooks.beforeCollect }
        : null;
    const resetEntry = hooks.reset
        ? { telemetry, hook: hooks.reset }
        : null;
    if (beforeCollectEntry) {
        globalBeforeCollectHooks.add(beforeCollectEntry);
    }
    if (resetEntry) {
        globalResetHooks.add(resetEntry);
    }
    return () => {
        if (beforeCollectEntry) {
            globalBeforeCollectHooks.delete(beforeCollectEntry);
        }
        if (resetEntry) {
            globalResetHooks.delete(resetEntry);
        }
    };
}

export function installSyncPerformanceTelemetryGlobal(
    telemetry: SyncPerformanceTelemetry = syncPerformanceTelemetry,
): void {
    const target = globalThis as unknown as {
        __HAPPIER_SYNC_PERFORMANCE__?: {
            configure?: (options: SyncPerformanceTelemetryGlobalConfigureOptions) => void;
            snapshot: () => SyncPerformanceTelemetrySummary;
            flush: () => SyncPerformanceTelemetrySummary | null;
            reset: () => void;
            markScenario: (name: string, fields?: SyncPerformanceTelemetryFields) => void;
        };
    };
    target.__HAPPIER_SYNC_PERFORMANCE__ = {
        snapshot: () => {
            return telemetry.snapshot();
        },
        flush: () => {
            return telemetry.flushSummary();
        },
        reset: () => {
            telemetry.reset();
        },
        markScenario: (name, fields) => {
            telemetry.count(`sync.performance.scenario.${sanitizeScenarioName(name)}`, fields);
        },
    };
    if (readDevFlag()) {
        target.__HAPPIER_SYNC_PERFORMANCE__.configure = (options) => {
            telemetry.configure(options);
        };
    }
}

export function emitSyncPerformanceSummaryToConsole(summary: SyncPerformanceTelemetrySummary): void {
    if (summary.events.length === 0) return;
    const target = globalThis as unknown as {
        nativeLoggingHook?: (message: string, level: number) => void;
    };
    if (typeof target.nativeLoggingHook === 'function') {
        for (const event of summary.events) {
            target.nativeLoggingHook(`[sync-perf] ${JSON.stringify({ events: [event] })}`, 1);
        }
        return;
    }
    console.info('[sync-perf]', JSON.stringify(summary));
}
