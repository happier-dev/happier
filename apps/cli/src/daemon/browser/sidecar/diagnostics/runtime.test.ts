import { describe, expect, it, vi } from 'vitest';

import type {
    BrowserSidecarCdpEventNotification,
    BrowserSidecarCdpEventSubscriber,
    BrowserSidecarViewLifecycleSubscriber,
} from '../controlAdapter';
import {
    createBrowserContextDiagnosticsSummarySource,
    type BrowserContextDiagnosticsSummarySource,
} from '../../context/diagnostics/summary';
import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createCdpBrowserContextSource } from '../../context/cdp/source';
import { createSidecarCdpDiagnosticsRuntime } from './runtime';

const OWNER = 'machine_owner';
const VIEW = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const HANDLE = { targetId: 'target_1', sessionId: 'cdp_session_1' } as const;

function fakeContextCapture() {
    let cdpListener: BrowserSidecarCdpEventSubscriber | null = null;
    let lifecycleListener: BrowserSidecarViewLifecycleSubscriber | null = null;
    return {
        dispatchPageCommand: vi.fn(async () => ({})),
        contextCapture: {
            transport: {
                dispatchPageCommand: vi.fn(async () => ({})),
            },
            resolvePageHandle: (view: { browserSessionId: string; viewId: string }) =>
                view.browserSessionId === VIEW.browserSessionId && view.viewId === VIEW.viewId ? HANDLE : null,
            subscribeCdpEvents: vi.fn((listener: BrowserSidecarCdpEventSubscriber) => {
                cdpListener = listener;
                return () => {
                    cdpListener = null;
                };
            }),
            subscribeViewLifecycle: vi.fn((listener: BrowserSidecarViewLifecycleSubscriber) => {
                lifecycleListener = listener;
                return () => {
                    lifecycleListener = null;
                };
            }),
        },
        emitCdp: (notification: BrowserSidecarCdpEventNotification) => cdpListener?.(notification),
        bindView: () => lifecycleListener?.({ type: 'bound', ...VIEW }),
        unbindView: () => lifecycleListener?.({ type: 'unbound', ...VIEW }),
        hasCdpListener: () => cdpListener !== null,
    };
}

function summaryContextSource(summaries: BrowserContextDiagnosticsSummarySource) {
    // The summary path only consults the diagnostics summary source; transport/writer are never
    // touched for it.
    return createCdpBrowserContextSource({
        transport: { dispatchPageCommand: vi.fn(async () => { throw new Error('unused'); }) },
        resolveView: () => HANDLE,
        screenshotMediaWriter: { write: vi.fn(async () => ({ ok: false as const, reason: 'capture_failed' as const })) },
        summarizeDiagnostics: (request) => summaries.summarize(request),
    });
}

describe('createSidecarCdpDiagnosticsRuntime', () => {
    it('feeds the diagnostics store from the live CDP stream once a view is bound, redacting raw payloads', async () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 9_000 });
        const surface = fakeContextCapture();

        const runtime = createSidecarCdpDiagnosticsRuntime({
            ownerAccountId: OWNER,
            store,
            contextCapture: surface.contextCapture,
            isEnabled: () => true,
            nowMs: () => 9_000,
        });

        surface.bindView();
        expect(surface.hasCdpListener()).toBe(true);

        surface.emitCdp({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: {
                requestId: 'raw_cdp_request_secret',
                request: {
                    url: 'https://example.test/api?ok=1&token=secret',
                    method: 'GET',
                    headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
                },
                type: 'XHR',
            },
        });
        surface.emitCdp({
            method: 'Runtime.consoleAPICalled',
            sessionId: 'cdp_session_1',
            params: { type: 'error', args: [{ type: 'string', value: 'token=secret should not leave the daemon' }] },
        });

        const snapshot = store.getSnapshot();
        expect(snapshot.events.map((event) => [event.kind, event.fidelity, event.trusted])).toEqual([
            ['network.requestStarted', 'cdp', true],
            ['console.entry', 'cdp', true],
        ]);
        expect(snapshot.events[0]?.data).toMatchObject({
            method: 'GET',
            url: { origin: 'https://example.test', path: '/api', queryKeys: ['ok'] },
            headers: { accept: 'application/json' },
        });
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('raw_cdp_request_secret');
        expect(serialized).not.toContain('Bearer secret');
        expect(serialized).not.toContain('token=secret');

        // The store is now non-empty: the context captureSummary path returns a redacted network summary.
        const networkSummary = await summaryContextSource(createBrowserContextDiagnosticsSummarySource({ store, now: () => 9_000 })).captureSummary({
            kind: 'browserNetworkSummary',
            ...VIEW,
            navigationGeneration: 0,
        });
        expect(networkSummary).toMatchObject({ ok: true });
        if (networkSummary.ok) {
            expect(networkSummary.summary).toContain('GET https://example.test/api');
            expect(networkSummary.summary).not.toContain('token=secret');
        }

        runtime.dispose();
    });

    it('stays empty when the live gate is disabled (fail-closed per event)', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 9_000 });
        const surface = fakeContextCapture();

        const runtime = createSidecarCdpDiagnosticsRuntime({
            ownerAccountId: OWNER,
            store,
            contextCapture: surface.contextCapture,
            isEnabled: () => false,
            nowMs: () => 9_000,
        });

        surface.bindView();
        surface.emitCdp({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r1', request: { url: 'https://example.test/a', method: 'GET' } },
        });

        expect(store.getSnapshot().events).toEqual([]);
        expect(createBrowserContextDiagnosticsSummarySource({ store, now: () => 9_000 })
            .summarize({ ...VIEW, navigationGeneration: 0, kind: 'browserNetworkSummary' })?.summary).toBe('');
        runtime.dispose();
    });

    it('detaches the per-view source on unbind and after dispose', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 9_000 });
        const surface = fakeContextCapture();

        const runtime = createSidecarCdpDiagnosticsRuntime({
            ownerAccountId: OWNER,
            store,
            contextCapture: surface.contextCapture,
            isEnabled: () => true,
            nowMs: () => 9_000,
        });

        surface.bindView();
        surface.unbindView();
        expect(surface.hasCdpListener()).toBe(false);

        surface.emitCdp({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r1', request: { url: 'https://example.test/a', method: 'GET' } },
        });
        expect(store.getSnapshot().events).toEqual([]);

        runtime.dispose();
        expect(surface.contextCapture.subscribeViewLifecycle).toHaveBeenCalledTimes(1);
    });
});
