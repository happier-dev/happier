import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

import type { BrowserDiagnosticsDaemonStore } from '../../diagnostics/store';

/**
 * Projects retained view diagnostics into value-free agent context. The diagnostics store owns
 * retention; this owner presents all eligible safe evidence chronologically.
 * Raw event size does not constrain its safe projection.
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
}>;

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
        case 'network.response':
        case 'network.finished': {
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
            const lines: string[] = [];
            for (const event of retained) {
                if (event.family !== family) continue;
                if (event.navigationGeneration !== request.navigationGeneration) continue;
                const line = serialize(request.kind, event);
                if (line === null) continue;
                lines.push(line);
            }
            return { summary: lines.join('\n') };
        },
    };
}
