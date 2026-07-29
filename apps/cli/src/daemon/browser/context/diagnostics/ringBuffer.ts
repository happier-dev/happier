import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

/**
 * Offline diagnostics bundle (Part 2). A capped (size + time) daemon-side ring buffer over the
 * sidecar diagnostics event stream. Every event recorded here is ALREADY redacted by
 * `mapEvents.ts` (cdp fidelity, trusted, url/headers/values redacted) — the ring never sees raw
 * bodies, cookies, tokens, or storage values. On demand it serializes the most recent in-window
 * console/network events into the existing context summary kinds for the agent/human.
 */
export type BrowserContextDiagnosticsSummaryKind = 'browserNetworkSummary' | 'browserConsoleSummary';

export type BrowserContextDiagnosticsSummaryRequest = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    kind: BrowserContextDiagnosticsSummaryKind;
}>;

export type BrowserContextDiagnosticsSummary = Readonly<{
    summary: string;
    truncated?: boolean;
}>;

export type BrowserContextDiagnosticsRingBuffer = Readonly<{
    record(event: BrowserDiagnosticEventV1): void;
    summarize(request: BrowserContextDiagnosticsSummaryRequest): BrowserContextDiagnosticsSummary | null;
    clearView(input: Readonly<{ browserSessionId: string; viewId: string }>): void;
    clearSession(input: Readonly<{ browserSessionId: string }>): void;
}>;

export type BrowserContextDiagnosticsRingBufferOptions = Readonly<{
    now?: () => number;
    /** Time window (ms) of events serialized into a summary. Older events are dropped. */
    windowMs?: number;
    /** Hard cap on retained events per view; oldest are evicted first. */
    maxEvents?: number;
    /** Cap on serialized summary characters (defence-in-depth on top of the protocol cap). */
    maxSummaryChars?: number;
    /** Max serialized lines per summary. */
    maxLines?: number;
    /**
     * Per-event byte cap (B3 bound). An individual recorded event whose serialized size exceeds
     * this is dropped at record time (it cannot fit any honest local-fidelity budget). Mirrors the
     * `attachJsonlLineReader` `maxLineBytes` byte-budget idea.
     */
    maxEventBytes?: number;
    /**
     * Aggregate retained-byte budget per view (B3 bound). When exceeded, oldest events are evicted
     * (and the view is flagged truncated) so the in-memory owner store can never grow unbounded.
     */
    maxAggregateBytes?: number;
}>;

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_SUMMARY_CHARS = 8_000;
const DEFAULT_MAX_LINES = 200;
const DEFAULT_MAX_EVENT_BYTES = 16_384;
const DEFAULT_MAX_AGGREGATE_BYTES = 2_097_152;

function eventByteSize(event: BrowserDiagnosticEventV1): number {
    try {
        return Buffer.byteLength(JSON.stringify(event), 'utf8');
    } catch {
        // Circular/oversized serialization → treat as over-budget so it is dropped.
        return Number.MAX_SAFE_INTEGER;
    }
}

function viewKey(input: Readonly<{ browserSessionId: string; viewId: string }>): string {
    return `${input.browserSessionId}\u0000${input.viewId}`;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function redactedUrlText(value: unknown): string {
    if (typeof value === 'string') return value;
    const r = record(value);
    if (!r) return '';
    const origin = typeof r.origin === 'string' ? r.origin : '';
    const path = typeof r.path === 'string' ? r.path : '';
    const base = `${origin}${path}`;
    const queryKeys = Array.isArray(r.queryKeys)
        ? r.queryKeys.filter((key): key is string => typeof key === 'string')
        : [];
    return queryKeys.length > 0 ? `${base}?${queryKeys.join('&')}` : base;
}

function serializeNetworkEvent(event: BrowserDiagnosticEventV1): string | null {
    if (event.family !== 'network') return null;
    const data = event.data ?? {};
    const url = redactedUrlText((data as Record<string, unknown>).url);
    switch (event.kind) {
        case 'network.requestStarted': {
            const method = typeof (data as Record<string, unknown>).method === 'string'
                ? (data as Record<string, unknown>).method as string
                : 'REQUEST';
            return `${method} ${url}`.trim();
        }
        case 'network.response': {
            const status = typeof (data as Record<string, unknown>).statusCode === 'number'
                ? (data as Record<string, unknown>).statusCode as number
                : typeof (data as Record<string, unknown>).status === 'number'
                    ? (data as Record<string, unknown>).status as number
                : '';
            return `RESPONSE ${status} ${url}`.trim();
        }
        case 'network.failed':
            return `FAILED ${url}`.trim();
        case 'network.websocketSummary':
            return `WEBSOCKET ${url}`.trim();
        default:
            return null;
    }
}

function serializeConsoleEvent(event: BrowserDiagnosticEventV1): string | null {
    if (event.family !== 'console' || event.kind !== 'console.entry') return null;
    const level = typeof (event.data as Record<string, unknown>)?.level === 'string'
        ? (event.data as Record<string, unknown>).level as string
        : 'log';
    // Console values are redacted upstream (textAvailable only); we surface level + availability,
    // never the message text.
    const textAvailable = (event.data as Record<string, unknown>)?.textAvailable === true;
    return `[${level}]${textAvailable ? ' (text redacted)' : ''}`;
}

export function createBrowserContextDiagnosticsRingBuffer(
    options: BrowserContextDiagnosticsRingBufferOptions = {},
): BrowserContextDiagnosticsRingBuffer {
    const now = options.now ?? (() => Date.now());
    const windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    const maxEvents = Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    const maxSummaryChars = Math.max(1, Math.trunc(options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS));
    const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_MAX_LINES));
    const maxEventBytes = Math.max(1, Math.trunc(options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES));
    const maxAggregateBytes = Math.max(1, Math.trunc(options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES));

    const eventsByView = new Map<string, BrowserDiagnosticEventV1[]>();
    // Per-view retained byte total, kept in lock-step with `eventsByView` so the aggregate budget is
    // O(1) to enforce on record.
    const aggregateBytesByView = new Map<string, number>();
    // Tracks whether any event was evicted by the size cap for a view, so a serialized summary can
    // honestly flag that it is a partial (capped) window rather than the full history.
    const evictedByView = new Set<string>();

    function familyForKind(kind: BrowserContextDiagnosticsSummaryKind): BrowserDiagnosticEventV1['family'] {
        return kind === 'browserNetworkSummary' ? 'network' : 'console';
    }

    function serialize(kind: BrowserContextDiagnosticsSummaryKind, event: BrowserDiagnosticEventV1): string | null {
        return kind === 'browserNetworkSummary' ? serializeNetworkEvent(event) : serializeConsoleEvent(event);
    }

    return {
        record(event) {
            const key = viewKey(event);
            // Per-event byte cap: an oversized single event cannot fit any honest budget — drop it
            // and flag the view as truncated rather than letting one event blow the aggregate budget.
            const bytes = eventByteSize(event);
            if (bytes > maxEventBytes) {
                evictedByView.add(key);
                return;
            }

            const existing = eventsByView.get(key) ?? [];
            existing.push(event);
            let aggregate = (aggregateBytesByView.get(key) ?? 0) + bytes;

            // Cap by event count first (evict oldest); the time window is applied at read time.
            if (existing.length > maxEvents) {
                evictedByView.add(key);
                while (existing.length > maxEvents) {
                    const removed = existing.shift();
                    if (removed) aggregate -= eventByteSize(removed);
                }
            }
            // Then enforce the aggregate byte budget (evict oldest until within budget). Always keep
            // at least the just-recorded event so a single in-budget event is never lost.
            while (existing.length > 1 && aggregate > maxAggregateBytes) {
                const removed = existing.shift();
                if (!removed) break;
                aggregate -= eventByteSize(removed);
                evictedByView.add(key);
            }

            eventsByView.set(key, existing);
            aggregateBytesByView.set(key, Math.max(0, aggregate));
        },

        summarize(request) {
            const key = viewKey(request);
            const events = eventsByView.get(key) ?? [];
            const family = familyForKind(request.kind);
            const cutoff = now() - windowMs;

            const lines: string[] = [];
            let truncated = evictedByView.has(key);
            for (const event of events) {
                if (event.family !== family) continue;
                if (event.navigationGeneration !== request.navigationGeneration) continue;
                if (event.capturedAtMs < cutoff) continue;
                const line = serialize(request.kind, event);
                if (line === null) continue;
                if (lines.length >= maxLines) {
                    truncated = true;
                    break;
                }
                lines.push(line);
            }

            let summary = lines.join('\n');
            if (summary.length > maxSummaryChars) {
                summary = `${summary.slice(0, maxSummaryChars)}...`;
                truncated = true;
            }

            return { summary, ...(truncated ? { truncated: true } : {}) };
        },

        clearView(input) {
            const key = viewKey(input);
            eventsByView.delete(key);
            aggregateBytesByView.delete(key);
            evictedByView.delete(key);
        },

        clearSession(input) {
            for (const key of [...eventsByView.keys()]) {
                if (key.startsWith(`${input.browserSessionId}\u0000`)) {
                    eventsByView.delete(key);
                    aggregateBytesByView.delete(key);
                    evictedByView.delete(key);
                }
            }
        },
    };
}
