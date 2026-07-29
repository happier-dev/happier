type RequestWithHeaders = Readonly<{
    headers?: Readonly<Record<string, unknown>>;
}>;

type ReplyWithHeaders = {
    header: (name: string, value: string) => unknown;
};

type V2SessionListServerTimingMetric = "cursor" | "query" | "page";

export type V2SessionListInitialPageTiming = Readonly<{
    measureQuery: <T>(fn: () => Promise<T>) => Promise<T>;
    measurePage: <T>(fn: () => T) => T;
}>;

export const V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER = "x-happier-session-list-timing";

const SERVER_TIMING_HEADER = "Server-Timing";
const SERVER_TIMING_NAME_BY_METRIC: Record<V2SessionListServerTimingMetric | "total", string> = {
    cursor: "happier_v2_sessions_cursor",
    query: "happier_v2_sessions_query",
    page: "happier_v2_sessions_page",
    total: "happier_v2_sessions_total",
};

function nowMs(): number {
    const perf = globalThis.performance;
    return typeof perf?.now === "function" ? perf.now() : Date.now();
}

function readHeader(headers: Readonly<Record<string, unknown>> | undefined, name: string): unknown {
    if (!headers) return undefined;
    const direct = headers[name];
    if (direct !== undefined) return direct;
    return headers[name.toLowerCase()];
}

function isTimingRequested(request: RequestWithHeaders): boolean {
    const value = readHeader(request.headers, V2_SESSION_LIST_SERVER_TIMING_REQUEST_HEADER);
    if (Array.isArray(value)) return value.some((entry) => entry === "1" || entry === "true");
    return value === "1" || value === "true";
}

function formatDurationMs(durationMs: number): string {
    return Math.max(0, durationMs).toFixed(3);
}

export function createV2SessionListServerTiming(request: RequestWithHeaders) {
    const enabled = isTimingRequested(request);
    const startedAtMs = nowMs();
    const durations: Record<V2SessionListServerTimingMetric, number> = {
        cursor: 0,
        query: 0,
        page: 0,
    };

    const addDuration = (metric: V2SessionListServerTimingMetric, startedAt: number): void => {
        if (!enabled) return;
        durations[metric] += nowMs() - startedAt;
    };
    const measure = <T>(metric: V2SessionListServerTimingMetric, fn: () => T): T => {
        if (!enabled) return fn();
        const startedAt = nowMs();
        try {
            return fn();
        } finally {
            addDuration(metric, startedAt);
        }
    };
    const measureAsync = async <T>(metric: V2SessionListServerTimingMetric, fn: () => Promise<T>): Promise<T> => {
        if (!enabled) return await fn();
        const startedAt = nowMs();
        try {
            return await fn();
        } finally {
            addDuration(metric, startedAt);
        }
    };

    return {
        enabled,
        measure,
        measureAsync,
        apply(reply: ReplyWithHeaders): void {
            if (!enabled) return;
            const totalMs = nowMs() - startedAtMs;
            reply.header(SERVER_TIMING_HEADER, [
                `${SERVER_TIMING_NAME_BY_METRIC.cursor};dur=${formatDurationMs(durations.cursor)}`,
                `${SERVER_TIMING_NAME_BY_METRIC.query};dur=${formatDurationMs(durations.query)}`,
                `${SERVER_TIMING_NAME_BY_METRIC.page};dur=${formatDurationMs(durations.page)}`,
                `${SERVER_TIMING_NAME_BY_METRIC.total};dur=${formatDurationMs(totalMs)}`,
            ].join(", "));
        },
        initialPageTiming(): V2SessionListInitialPageTiming {
            return {
                measureQuery: (fn) => measureAsync("query", fn),
                measurePage: (fn) => measure("page", fn),
            };
        },
    };
}
