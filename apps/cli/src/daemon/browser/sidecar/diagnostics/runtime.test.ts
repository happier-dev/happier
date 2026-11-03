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
import { createSurfaceInputControl } from '../../../surfaces/inputControl';

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
    it('correlates independent ExtraInfo streams across redirects without retaining a provisional wrong-hop header', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine' });
        const surface = fakeContextCapture();
        const runtime = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: OWNER, store, contextCapture: surface.contextCapture, isEnabled: () => true });
        surface.bindView();
        const emit = (method: string, params: Record<string, unknown>) => surface.emitCdp({ method, params, sessionId: HANDLE.sessionId });
        emit('Network.requestWillBeSent', { requestId: 'r', timestamp: 1, request: { method: 'GET', url: 'https://example.test/a' } });
        emit('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { 'X-Request-Id': 'final-hop' } });
        emit('Network.requestWillBeSent', { requestId: 'r', timestamp: 2, redirectHasExtraInfo: false,
            redirectResponse: { url: 'https://example.test/a', status: 302 }, request: { method: 'GET', url: 'https://example.test/b' },
            initiator: { type: 'script', stack: { callFrames: [{ functionName: 'load', url: 'https://example.test/app.js?token=secret', lineNumber: 4, columnNumber: 2 }] } } });
        emit('Network.responseReceivedExtraInfo', { requestId: 'r', statusCode: 200, headers: { 'Content-Type': 'text/plain' } });
        emit('Network.responseReceived', { requestId: 'r', timestamp: 2.1, hasExtraInfo: true,
            response: { url: 'https://example.test/b', status: 200, securityDetails: { protocol: 'TLS 1.3', cipher: 'AES_128_GCM', issuer: 'Example CA' } } });
        emit('Network.loadingFinished', { requestId: 'r', timestamp: 2.5, encodedDataLength: 20 });
        const event = store.getSnapshot().events.find(event => event.kind === 'network.finished')!;
        expect(event.data).toMatchObject({ requestHeaders: { 'x-request-id': 'final-hop' }, durationMs: 500,
            securityDetails: { protocol: 'TLS 1.3', cipher: 'AES_128_GCM', issuer: 'Example CA' },
            initiator: { type: 'script', stackFrames: [{ functionName: 'load', url: { path: '/app.js', queryKeys: [] }, lineNumber: 4, columnNumber: 2 }] } });
        expect(event.data.redirects).toEqual([expect.objectContaining({ status: 302, durationMs: 1000, requestHeaders: {} })]);
        expect(JSON.stringify(event)).not.toContain('secret');
        runtime.dispose();
    });
    it('correlates ExtraInfo before a request, response and completion into one request with timing and bytes', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine' });
        const surface = fakeContextCapture();
        const runtime = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: OWNER, store,
            contextCapture: surface.contextCapture, isEnabled: () => true });
        surface.bindView();
        const emit = (method: string, params: Record<string, unknown>) => surface.emitCdp({ method, params, sessionId: HANDLE.sessionId });
        emit('Network.responseReceivedExtraInfo', { requestId: 'r1', statusCode: 304, headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'secret' } });
        emit('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { Accept: 'text/plain', Cookie: 'secret' } });
        emit('Network.requestWillBeSent', { requestId: 'r1', timestamp: 10, request: { method: 'GET', url: 'https://example.test/a?search=x' } });
        emit('Network.responseReceived', { requestId: 'r1', timestamp: 10.1, hasExtraInfo: true,
            response: { status: 200, url: 'https://example.test/a', mimeType: 'text/plain', protocol: 'h2', fromDiskCache: true,
                timing: { requestTime: 10, receiveHeadersEnd: 100 } } });
        emit('Network.loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 512 });
        const events = store.getSnapshot().events.filter(event => event.family === 'network' && event.kind !== 'diagnostics.available');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'network.finished', data: { method: 'GET', status: 200, statusCode: 304,
            durationMs: 250, responseBytes: 512, requestHeaders: { accept: 'text/plain' },
            responseHeaders: { 'content-type': 'text/plain' }, transportProtocol: 'h2', fromDiskCache: true } });
        expect(JSON.stringify(events)).not.toContain('secret');
        emit('Network.requestWillBeSent', { requestId: 'r2', timestamp: 11, request: { method: 'POST', url: 'https://example.test/b' } });
        emit('Network.loadingFailed', { requestId: 'r2', timestamp: 11.5, errorText: 'net::ERR_CONNECTION_RESET' });
        expect(store.getSnapshot().events.find(event => event.kind === 'network.failed')?.data)
            .toMatchObject({ method: 'POST', durationMs: 500, errorText: 'net::ERR_CONNECTION_RESET' });
        runtime.dispose();
    });
    it('does not retain console or network observations during the confidential source hold', async () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 9_000 });
        const surface = fakeContextCapture();
        const control = createSurfaceInputControl();
        const runtime = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: OWNER, store,
            contextCapture: surface.contextCapture, isEnabled: () => true, resolveInputControl: () => control });
        surface.bindView();
        await control.beginConfidentialityHold();
        surface.emitCdp({ method: 'Runtime.consoleAPICalled', sessionId: HANDLE.sessionId,
            params: { type: 'log', args: [{ type: 'string', value: 'fixture-secret' }] } });
        surface.emitCdp({ method: 'Network.requestWillBeSent', sessionId: HANDLE.sessionId,
            params: { requestId: 'r1', request: { url: 'https://example.test/fixture-secret', method: 'GET' } } });
        expect(store.getSnapshot().events).toEqual([]);
        runtime.dispose();
    });

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
        expect(snapshot.events.map((event) => [event.kind, event.fidelity, event.trusted])).toEqual(expect.arrayContaining([
            ['network.requestStarted', 'cdp', true],
            ['console.entry', 'cdp', true],
        ]));
        expect(snapshot.events.find(event => event.family === 'network')?.data).toMatchObject({
            method: 'GET',
            url: { origin: 'https://example.test', path: '/api', queryKeys: ['ok'] },
            headers: { accept: 'application/json' },
        });
        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('raw_cdp_request_secret');
        expect(serialized).not.toContain('Bearer secret');
        expect(snapshot.events.find(event => event.family === 'console')?.data.text).toBe('token=secret should not leave the daemon');

        // The store is now non-empty: the context captureSummary path returns a redacted network summary.
        const networkSummary = await summaryContextSource(createBrowserContextDiagnosticsSummarySource({ store })).captureSummary({
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
        expect(createBrowserContextDiagnosticsSummarySource({ store })
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
