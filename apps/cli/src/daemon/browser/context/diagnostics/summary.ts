import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';
import { BROWSER_CONTEXT_SUMMARY_MAX_CHARS } from '@happier-dev/protocol/browser/context/v1';

import type { BrowserDiagnosticsDaemonStore } from '../../diagnostics/store';

/**
 * Projects retained view diagnostics into value-free agent context. The diagnostics store owns
 * retention; this owner selects newest useful evidence under the context protocol's output budget
 * before presenting it chronologically. Raw event size does not constrain its safe projection.
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
            let truncated = false;
            const lines: string[] = [];
            let chars = 0;
            for (let index = retained.length - 1; index >= 0; index -= 1) {
                const event = retained[index];
                if (!event) continue;
                if (event.family !== family) continue;
                if (event.navigationGeneration !== request.navigationGeneration) continue;
                const line = serialize(request.kind, event);
                if (line === null) continue;
                const required = line.length + (lines.length > 0 ? 1 : 0);
                if (chars + required > BROWSER_CONTEXT_SUMMARY_MAX_CHARS) {
                    truncated = true;
                    // Even an oversized newest event retains useful evidence, with incompleteness
                    // explicit in the wire result. Older events never displace newer material.
                    if (lines.length === 0) lines.push(line.slice(0, BROWSER_CONTEXT_SUMMARY_MAX_CHARS));
                    break;
                }
                lines.push(line);
                chars += required;
            }
            return { summary: lines.reverse().join('\n'), ...(truncated ? { truncated: true } : {}) };
        },
    };
}
