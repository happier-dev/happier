import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserContextDiagnosticsSummarySource } from './summary';

const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3 } as const;

type SummaryHarnessOptions = Omit<
    Parameters<typeof createBrowserContextDiagnosticsSummarySource>[0],
    'store'
>;

/**
 * SB-G: the summary source no longer retains anything, so a test drives it by publishing into the
 * daemon diagnostics store — the single retainer — and reading the summary back out. `clearView`
 * goes to the store for the same reason: there is only one buffer to prune now.
 */
function summaryHarness(options: SummaryHarnessOptions) {
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1' });
    const source = createBrowserContextDiagnosticsSummarySource({ store, ...options });
    return {
        record: (event: BrowserDiagnosticEventV1) => { store.publishEvent(event); },
        clearView: (input: Readonly<{ browserSessionId: string; viewId: string }>) => store.clearView(input),
        clearSession: (input: Readonly<{ browserSessionId: string }>) => store.clearSession(input),
        summarize: source.summarize,
    };
}


function networkEvent(input: Readonly<{
    ordinal: number;
    capturedAtMs: number;
    method?: string;
    status?: number;
    url?: string;
}>): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: `sidecar_diag_${VIEW.viewId}_${VIEW.navigationGeneration}_${input.ordinal}`,
        browserSessionId: VIEW.browserSessionId,
        viewId: VIEW.viewId,
        navigationGeneration: VIEW.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        family: 'network',
        kind: input.status === undefined ? 'network.requestStarted' : 'network.response',
        fidelity: 'cdp',
        trusted: true,
        data: {
            requestId: 'sidecar_request_abc',
            ...(input.method ? { method: input.method } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            url: { origin: 'https://api.test', path: input.url ?? '/items', queryKeys: [] },
        },
        redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false },
    });
}

function consoleEvent(input: Readonly<{ ordinal: number; capturedAtMs: number; level: 'error' | 'log' }>): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: `sidecar_diag_${VIEW.viewId}_${VIEW.navigationGeneration}_${input.ordinal}`,
        browserSessionId: VIEW.browserSessionId,
        viewId: VIEW.viewId,
        navigationGeneration: VIEW.navigationGeneration,
        capturedAtMs: input.capturedAtMs,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'cdp',
        trusted: true,
        data: { level: input.level, textAvailable: true },
        redaction: { level: 'valuesRedacted', queryRedacted: true, headersRedacted: true, truncated: false },
    });
}

describe('browser context diagnostics summary source (SB-G: reads the daemon diagnostics store)', () => {
    it('serializes the recent network events into a network summary', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 5_000 });

        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_800, method: 'GET' }));
        summaries.record(networkEvent({ ordinal: 2, capturedAtMs: 9_900, status: 200 }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary).not.toBeNull();
        expect(summary?.summary).toContain('https://api.test');
        expect(summary?.summary).toContain('200');
    });

    it('serializes console events into a console summary including levels', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 5_000 });

        summaries.record(consoleEvent({ ordinal: 1, capturedAtMs: 9_800, level: 'error' }));
        summaries.record(consoleEvent({ ordinal: 2, capturedAtMs: 9_900, level: 'log' }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserConsoleSummary' });
        expect(summary).not.toBeNull();
        expect(summary?.summary).toContain('error');
    });

    it('drops events older than the time window', () => {
        let nowMs = 100_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 5_000 });

        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 10_000, method: 'GET' }));
        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        // Only stale events present -> empty (but non-null) summary, truncated flag false.
        expect(summary).not.toBeNull();
        expect(summary?.summary).not.toContain('/items');
    });

    it('caps the buffer size and keeps only the most recent events (truncated flagged)', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000, maxEvents: 3 });

        for (let i = 1; i <= 10; i += 1) {
            summaries.record(networkEvent({ ordinal: i, capturedAtMs: 9_000 + i, method: 'GET', url: `/p${i}` }));
        }

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary).not.toBeNull();
        // Oldest entries evicted: /p1 gone, newest /p10 retained.
        expect(summary?.summary).not.toContain('/p1 ');
        expect(summary?.summary).toContain('/p10');
        expect(summary?.truncated).toBe(true);
    });

    it('isolates summaries to the requested view and navigation generation', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000 });

        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET', url: '/owned' }));
        const otherView = BrowserDiagnosticEventV1Schema.parse({
            ...networkEvent({ ordinal: 2, capturedAtMs: 9_950, method: 'GET', url: '/other' }),
            viewId: 'view_other',
            eventId: 'sidecar_diag_view_other_3_2',
        });
        summaries.record(otherView);

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary?.summary).toContain('/owned');
        expect(summary?.summary).not.toContain('/other');
    });

    it('clears events for a view', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000 });
        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET' }));
        summaries.clearView(VIEW);
        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary?.summary).not.toContain('/items');
    });

    // B4: the agent-context summarize() is an egress chokepoint. Even though events are redacted at
    // capture, the chokepoint must surface query-param NAMES only (never values) and never console text.
    it('serializes only safe query-key names and redacted console availability (no egress of values)', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000 });
        summaries.record(BrowserDiagnosticEventV1Schema.parse({
            v: 1,
            eventId: `sidecar_diag_${VIEW.viewId}_${VIEW.navigationGeneration}_77`,
            browserSessionId: VIEW.browserSessionId,
            viewId: VIEW.viewId,
            navigationGeneration: VIEW.navigationGeneration,
            capturedAtMs: 9_900,
            family: 'network',
            kind: 'network.requestStarted',
            fidelity: 'cdp',
            trusted: true,
            data: {
                requestId: 'sidecar_request_abc',
                method: 'GET',
                // Redacted upstream to key-names-only; the value 'secrettokenvalue' must never appear.
                url: { origin: 'https://api.test', path: '/login', queryKeys: ['page'] },
            },
            redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false },
        }));
        summaries.record(consoleEvent({ ordinal: 78, capturedAtMs: 9_950, level: 'error' }));

        const network = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(network?.summary).toContain('/login?page');
        expect(network?.summary).not.toContain('secrettokenvalue');

        const consoleSummary = summaries.summarize({ ...VIEW, kind: 'browserConsoleSummary' });
        expect(consoleSummary?.summary).toContain('(text redacted)');
    });

    it('does not serialize owner-only network bodies, headers, storage values, or console text into agent summaries', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000 });
        summaries.record(BrowserDiagnosticEventV1Schema.parse({
            v: 1,
            eventId: `sidecar_diag_${VIEW.viewId}_${VIEW.navigationGeneration}_88`,
            browserSessionId: VIEW.browserSessionId,
            viewId: VIEW.viewId,
            navigationGeneration: VIEW.navigationGeneration,
            capturedAtMs: 9_900,
            family: 'network',
            kind: 'network.response',
            fidelity: 'injectedPage',
            trusted: false,
            collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
            data: {
                requestId: 'req_1',
                method: 'POST',
                url: '/items?page',
                statusCode: 201,
                requestHeaders: { 'content-type': 'application/json' },
                responseHeaders: { 'x-request-id': 'res-1' },
                requestBodyText: 'agent-summary-request-secret',
                responseBodyText: 'agent-summary-response-secret',
            },
            redaction: { level: 'none', queryRedacted: true, headersRedacted: false, truncated: false },
        }));
        summaries.record(BrowserDiagnosticEventV1Schema.parse({
            ...consoleEvent({ ordinal: 89, capturedAtMs: 9_950, level: 'log' }),
            data: { level: 'log', textAvailable: true, text: 'agent-summary-console-secret' },
            redaction: { level: 'none', queryRedacted: true, headersRedacted: true, truncated: false },
        }));

        const network = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        const consoleSummary = summaries.summarize({ ...VIEW, kind: 'browserConsoleSummary' });
        const serialized = JSON.stringify([network, consoleSummary]);

        expect(serialized).not.toContain('agent-summary-request-secret');
        expect(serialized).not.toContain('agent-summary-response-secret');
        expect(serialized).not.toContain('content-type');
        expect(serialized).not.toContain('agent-summary-console-secret');
        expect(network?.summary).toContain('/items?page');
        expect(consoleSummary?.summary).toContain('(text redacted)');
    });

    // B3 bounds: full local fidelity must stay BOUNDED (per-event byte cap + aggregate byte budget).
    it('drops an over-sized single event (per-event byte cap) and flags the view truncated', () => {
        let nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000, maxEventBytes: 700 });
        // A normal event (~450 bytes) is kept.
        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET', url: '/ok' }));
        // An event padded past the per-event byte cap is dropped.
        summaries.record(networkEvent({ ordinal: 2, capturedAtMs: 9_950, method: 'GET', url: `/${'x'.repeat(800)}` }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary?.summary).toContain('/ok');
        expect(summary?.summary).not.toContain('xxxxxxxx');
        expect(summary?.truncated).toBe(true);
    });

    it('evicts oldest events once the aggregate byte budget is exceeded', () => {
        let nowMs = 10_000;
        // Budget only large enough for ~2 small events.
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000, maxAggregateBytes: 600 });
        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET', url: '/first' }));
        summaries.record(networkEvent({ ordinal: 2, capturedAtMs: 9_910, method: 'GET', url: '/second' }));
        summaries.record(networkEvent({ ordinal: 3, capturedAtMs: 9_920, method: 'GET', url: '/third' }));
        summaries.record(networkEvent({ ordinal: 4, capturedAtMs: 9_930, method: 'GET', url: '/fourth' }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        // The newest event always survives; the oldest is evicted under budget pressure.
        expect(summary?.summary).toContain('/fourth');
        expect(summary?.summary).not.toContain('/first');
        expect(summary?.truncated).toBe(true);
    });

    // The storeTap wrapper that used to keep a second buffer in lockstep with the store is gone
    // (SB-G). Clearing the store IS clearing the summary source, for the whole session and for a
    // single view, because there is only one retainer left.
    it('drops every view of a closed or purged session because the store is the only retainer', () => {
        const nowMs = 10_000;
        const summaries = summaryHarness({ now: () => nowMs, windowMs: 60_000 });

        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET', url: '/owned' }));
        summaries.record(BrowserDiagnosticEventV1Schema.parse({
            ...networkEvent({ ordinal: 2, capturedAtMs: 9_950, method: 'GET', url: '/sibling' }),
            viewId: 'view_other',
            eventId: 'sidecar_diag_view_other_3_2',
        }));

        summaries.clearSession({ browserSessionId: VIEW.browserSessionId });

        expect(summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' })?.summary).toBe('');
        expect(summaries.summarize({
            ...VIEW,
            viewId: 'view_other',
            kind: 'browserNetworkSummary',
        })?.summary).toBe('');
    });
});
