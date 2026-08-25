import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from '../../diagnostics/store';

/**
 * Offline diagnostics bundle (Part 2). Serializes the most recent in-window console/network events
 * for a view into the existing context summary kinds for the agent/human.
 *
 * SB-G: this used to be a second per-view ring buffer. It retained the *same* redacted event stream
 * as `daemon/browser/diagnostics/store.ts`, under the same view key, with its own eviction and its
 * own `clearView`/`clearSession` — kept in lockstep by a `storeTap` wrapper that existed solely to
 * fan every publish and every clear into both. Two owners of one stream, and the duplicate was the
 * larger share of the daemon's per-view diagnostics memory.
 *
 * It now reads `store.getViewSnapshot(...)` on demand. The store is the single retainer, so the two
 * buffers cannot diverge, a view's diagnostics are pruned exactly once by the bridge's view-close /
 * session-close clears, and nothing has to be kept in lockstep.
 *
 * The B3 bounds are kept, and land where they matter more. They used to bound a private duplicate
 * while the store — the copy that actually dominates daemon memory — retained the same events with
 * only a per-view *count* cap and no byte budget, so they were never the binding constraint on
 * memory. They are now applied at this egress chokepoint: an oversized event, or the oldest events
 * once the aggregate serialized budget is exceeded, never reach an agent summary, and the summary
 * says so via `truncated`.
 *
 * Everything the summary is allowed to expose is unchanged: events reaching the store are already
 * redacted by `mapEvents.ts` (cdp fidelity, trusted, url/headers/values redacted), so a summary
 * never sees raw bodies, cookies, tokens, or storage values.
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

export type BrowserContextDiagnosticsSummarySource = Readonly<{
    summarize(request: BrowserContextDiagnosticsSummaryRequest): BrowserContextDiagnosticsSummary | null;
}>;

export type BrowserContextDiagnosticsSummarySourceOptions = Readonly<{
    /** The single retainer of the redacted diagnostics event stream. */
    store: BrowserDiagnosticsDaemonStore;
    now?: () => number;
    /** Time window (ms) of events serialized into a summary. Older events are dropped. */
    windowMs?: number;
    /** Cap on events considered per summary; the newest are kept. */
    maxEvents?: number;
    /** Cap on serialized summary characters (defence-in-depth on top of the protocol cap). */
    maxSummaryChars?: number;
    /** Max serialized lines per summary. */
    maxLines?: number;
    /**
     * Per-event byte cap (B3 bound). An individual event whose serialized size exceeds this is
     * never serialized into a summary — it cannot fit any honest local-fidelity budget.
     */
    maxEventBytes?: number;
    /**
     * Aggregate serialized-byte budget per summary (B3 bound). The newest events are kept; older
     * ones are dropped once the budget is exceeded, and the summary is flagged truncated.
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

export function createBrowserContextDiagnosticsSummarySource(
    options: BrowserContextDiagnosticsSummarySourceOptions,
): BrowserContextDiagnosticsSummarySource {
    const store = options.store;
    const now = options.now ?? (() => Date.now());
    const windowMs = Math.max(1, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
    const maxEvents = Math.max(1, Math.trunc(options.maxEvents ?? DEFAULT_MAX_EVENTS));
    const maxSummaryChars = Math.max(1, Math.trunc(options.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS));
    const maxLines = Math.max(1, Math.trunc(options.maxLines ?? DEFAULT_MAX_LINES));
    const maxEventBytes = Math.max(1, Math.trunc(options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES));
    const maxAggregateBytes = Math.max(1, Math.trunc(options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES));

    function familyForKind(kind: BrowserContextDiagnosticsSummaryKind): BrowserDiagnosticEventV1['family'] {
        return kind === 'browserNetworkSummary' ? 'network' : 'console';
    }

    function serialize(kind: BrowserContextDiagnosticsSummaryKind, event: BrowserDiagnosticEventV1): string | null {
        return kind === 'browserNetworkSummary' ? serializeNetworkEvent(event) : serializeConsoleEvent(event);
    }

    return {
        summarize(request) {
            // The store returns this view's retained events oldest-first.
            const retained = store.getViewSnapshot({
                browserSessionId: request.browserSessionId,
                viewId: request.viewId,
            }).events;

            const family = familyForKind(request.kind);
            const cutoff = now() - windowMs;
            let truncated = false;

            const eligible: BrowserDiagnosticEventV1[] = [];
            for (const event of retained) {
                if (event.family !== family) continue;
                if (event.navigationGeneration !== request.navigationGeneration) continue;
                if (event.capturedAtMs < cutoff) continue;
                // B3 per-event byte cap: an oversized single event never reaches a summary.
                if (eventByteSize(event) > maxEventBytes) {
                    truncated = true;
                    continue;
                }
                eligible.push(event);
            }

            // B3 count + aggregate-byte budgets, applied newest-first so the newest event always
            // survives and the oldest are the ones dropped under pressure.
            const bounded: BrowserDiagnosticEventV1[] = [];
            let aggregate = 0;
            for (let index = eligible.length - 1; index >= 0; index -= 1) {
                const event = eligible[index];
                if (!event) continue;
                if (bounded.length >= maxEvents) {
                    truncated = true;
                    break;
                }
                const bytes = eventByteSize(event);
                if (bounded.length > 0 && aggregate + bytes > maxAggregateBytes) {
                    truncated = true;
                    break;
                }
                aggregate += bytes;
                bounded.push(event);
            }
            bounded.reverse();

            const lines: string[] = [];
            for (const event of bounded) {
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
    };
}
