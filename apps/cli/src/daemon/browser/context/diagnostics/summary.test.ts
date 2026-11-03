import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserContextDiagnosticsSummarySource } from './summary';

const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 3 } as const;

it('includes completed correlated requests in value-free context', () => {
    const harness = summaryHarness();
    harness.record({ ...networkEvent({ ordinal: 1, capturedAtMs: 100, status: 200, url: '/a' }), kind: 'network.finished' });
    expect(harness.summarize({ ...VIEW, kind: 'browserNetworkSummary' })?.summary).toContain('200 https://api.test/a');
});

/**
 * SB-G: the summary source no longer retains anything, so a test drives it by publishing into the
 * daemon diagnostics store — the single retainer — and reading the summary back out. `clearView`
 * goes to the store for the same reason: there is only one buffer to prune now.
 */
function summaryHarness(options: Readonly<{ maxEventsPerView?: number }> = {}) {
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', ...options });
    const source = createBrowserContextDiagnosticsSummarySource({ store });
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
    it('preserves the newest retained event under output pressure before presenting events chronologically', () => {
        const summaries = summaryHarness({});
        const nowMs = Date.now();
        for (let ordinal = 1; ordinal <= 600; ordinal += 1) {
            summaries.record(networkEvent({ ordinal, capturedAtMs: nowMs + ordinal, method: 'GET', url: `/request-${ordinal}` }));
        }
        const result = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        const lines = result?.summary.split('\n') ?? [];
        expect(lines.at(-1)).toBe('GET https://api.test/request-600');
        expect(result?.summary).not.toContain('/request-1\n');
        expect(result?.truncated).toBe(true);
        expect(result?.summary.length).toBeLessThanOrEqual(8192);
        const ordinals = lines.map(line => Number(line.split('request-')[1]));
        expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    });

    it('projects all retained useful evidence without independent age, line, count or raw-event-byte cutoffs', () => {
        const summaries = summaryHarness({});
        for (let ordinal = 1; ordinal <= 250; ordinal += 1) {
            summaries.record(networkEvent({ ordinal, capturedAtMs: ordinal, method: 'GET', url: `/p${ordinal}` }));
        }
        summaries.record(BrowserDiagnosticEventV1Schema.parse({
            ...networkEvent({ ordinal: 251, capturedAtMs: 251, method: 'GET', url: '/latest' }),
            data: { ...networkEvent({ ordinal: 251, capturedAtMs: 251 }).data, method: 'GET',
                url: { origin: 'https://api.test', path: '/latest', queryKeys: [] }, responseBodyText: 'x'.repeat(20_000) },
        }));
        const result = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(result?.summary.split('\n')).toHaveLength(251);
        expect(result?.summary).toContain('GET https://api.test/p1\n');
        expect(result?.summary.endsWith('GET https://api.test/latest')).toBe(true);
        expect(result?.summary).not.toContain('xxxxx');
        expect(result?.truncated).not.toBe(true);
    });

    it.each([0, 1])('uses the context protocol budget and marks an oversized newest projection incomplete (overflow=%s)', overflow => {
        const summaries = summaryHarness();
        const prefix = 'GET https://api.test';
        const path = `/${'x'.repeat(8192 - prefix.length - 1 + overflow)}`;
        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: Date.now(), method: 'GET', url: path }));
        const result = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(result?.summary).toBe(`${prefix}${path}`.slice(0, 8192));
        expect(result?.truncated === true).toBe(overflow > 0);
    });

    it('serializes the recent network events into a network summary', () => {
        const summaries = summaryHarness();

        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_800, method: 'GET' }));
        summaries.record(networkEvent({ ordinal: 2, capturedAtMs: 9_900, status: 200 }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary).not.toBeNull();
        expect(summary?.summary).toContain('https://api.test');
        expect(summary?.summary).toContain('200');
    });

    it('serializes console events into a console summary including levels', () => {
        const summaries = summaryHarness();

        summaries.record(consoleEvent({ ordinal: 1, capturedAtMs: 9_800, level: 'error' }));
        summaries.record(consoleEvent({ ordinal: 2, capturedAtMs: 9_900, level: 'log' }));

        const summary = summaries.summarize({ ...VIEW, kind: 'browserConsoleSummary' });
        expect(summary).not.toBeNull();
        expect(summary?.summary).toContain('error');
    });

    it('projects exactly the events retained by the canonical diagnostics store', () => {
        const summaries = summaryHarness({ maxEventsPerView: 3 });

        for (let i = 1; i <= 10; i += 1) {
            summaries.record(networkEvent({ ordinal: i, capturedAtMs: 9_000 + i, method: 'GET', url: `/p${i}` }));
        }

        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary).not.toBeNull();
        // Oldest entries evicted: /p1 gone, newest /p10 retained.
        expect(summary?.summary).not.toContain('/p1 ');
        expect(summary?.summary).toContain('/p10');
        expect(summary?.summary.split('\n')).toHaveLength(3);
        expect(summary?.truncated).not.toBe(true);
    });

    it('isolates summaries to the requested view and navigation generation', () => {
        const summaries = summaryHarness();

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
        const summaries = summaryHarness();
        summaries.record(networkEvent({ ordinal: 1, capturedAtMs: 9_900, method: 'GET' }));
        summaries.clearView(VIEW);
        const summary = summaries.summarize({ ...VIEW, kind: 'browserNetworkSummary' });
        expect(summary?.summary).not.toContain('/items');
    });

    // B4: the agent-context summarize() is an egress chokepoint. Even though events are redacted at
    // capture, the chokepoint must surface query-param NAMES only (never values) and never console text.
    it('serializes only safe query-key names and redacted console availability (no egress of values)', () => {
        const summaries = summaryHarness();
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
        const summaries = summaryHarness();
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

    // The storeTap wrapper that used to keep a second buffer in lockstep with the store is gone
    // (SB-G). Clearing the store IS clearing the summary source, for the whole session and for a
    // single view, because there is only one retainer left.
    it('drops every view of a closed or purged session because the store is the only retainer', () => {
        const summaries = summaryHarness();

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
