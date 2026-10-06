import { BrowserDiagnosticEventBatchV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticCollectorV1 } from '@happier-dev/protocol';

export const COOPERATIVE_COLLECTOR_QUERY = '__happierCollector';
export const COOPERATIVE_COLLECTOR_STATE_QUERY = '__happierCollectorState';
export const COOPERATIVE_COLLECTOR_LOADER_PATH = '/__happier/collector-loader.js';

/** Document-scoped transport configuration, not an access grant. Preview authorization is separate. */
export type CooperativeCollectorConfig = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    collector: BrowserDiagnosticCollectorV1;
    webPostMessageTargetOrigin: string;
    ownerConsoleValueCapture?: boolean;
    ownerDiagnosticsValueCapture?: boolean;
}>;

/** Strip only our transport fields; application query bytes may be signed. */
export function stripCooperativeCollectorQuery(search: string): string {
    const retained = search.replace(/^\?/, '').split('&').filter((part) => {
        const params = new URLSearchParams(part);
        return !params.has(COOPERATIVE_COLLECTOR_QUERY) && !params.has(COOPERATIVE_COLLECTOR_STATE_QUERY);
    }).join('&');
    return retained ? `?${retained}` : '';
}

export function buildCooperativeCollectorNavigationUrl(rawUrl: string, config: CooperativeCollectorConfig): string {
    const url = new URL(rawUrl);
    url.search = stripCooperativeCollectorQuery(url.search);
    url.search += `${url.search ? '&' : '?'}${new URLSearchParams({ [COOPERATIVE_COLLECTOR_QUERY]: JSON.stringify(config) })}`;
    return url.href;
}

export function parseCooperativeCollectorConfig(raw: string | null): CooperativeCollectorConfig | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const config = value as Record<string, unknown>;
        const keys = ['browserSessionId', 'viewId', 'navigationGeneration', 'collector', 'webPostMessageTargetOrigin', 'ownerConsoleValueCapture', 'ownerDiagnosticsValueCapture'];
        if (Object.keys(config).some((key) => !keys.includes(key))) return null;
        if (typeof config.webPostMessageTargetOrigin !== 'string') return null;
        const origin = new URL(config.webPostMessageTargetOrigin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.webPostMessageTargetOrigin) return null;
        for (const key of ['ownerConsoleValueCapture', 'ownerDiagnosticsValueCapture']) {
            if (config[key] !== undefined && typeof config[key] !== 'boolean') return null;
        }
        // Reuse the existing collector identity and generation boundary, including its bounds.
        const identity = BrowserDiagnosticEventBatchV1Schema.safeParse({
            v: 1, kind: 'browser.diagnostics.events', browserSessionId: config.browserSessionId,
            viewId: config.viewId, navigationGeneration: config.navigationGeneration, collector: config.collector, events: [],
        });
        if (!identity.success) return null;
        return {
            browserSessionId: identity.data.browserSessionId, viewId: identity.data.viewId,
            navigationGeneration: identity.data.navigationGeneration, collector: identity.data.collector,
            webPostMessageTargetOrigin: origin.origin,
            ...(config.ownerConsoleValueCapture === true ? { ownerConsoleValueCapture: true } : {}),
            ...(config.ownerDiagnosticsValueCapture === true ? { ownerDiagnosticsValueCapture: true } : {}),
        };
    } catch { return null; }
}

export function cooperativeCollectorIdentity(config: CooperativeCollectorConfig) {
    return { browserSessionId: config.browserSessionId, viewId: config.viewId,
        navigationGeneration: config.navigationGeneration, collectorId: config.collector.collectorId, nonce: config.collector.nonce };
}

export function isCooperativeCollectorMessage(value: unknown, kind: 'browser.collector.ready' | 'browser.collector.retire', config: CooperativeCollectorConfig): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as Record<string, unknown>;
    const identity = cooperativeCollectorIdentity(config);
    return message.v === 1 && message.kind === kind
        && Object.keys(message).length === Object.keys(identity).length + 2
        && Object.entries(identity).every(([key, expected]) => message[key] === expected);
}
