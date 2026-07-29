import { describe, expect, it, vi } from 'vitest';

import type { BrowserSidecarCdpEventSubscriber } from '../controlAdapter';
import type { SidecarDiagnosticsEventSourceSubscriber } from './eventSource';
import {
    createSidecarCdpDiagnosticsEventSource,
    translateSidecarCdpNotification,
} from './cdpEventSource';

function captureSubscriber() {
    const events: Array<{ capturedAtMs?: number; event: unknown }> = [];
    const subscriber: SidecarDiagnosticsEventSourceSubscriber = {
        onCdpEvent: (event) => {
            events.push({ capturedAtMs: event.capturedAtMs, event: event.event });
        },
        onUnavailable: vi.fn(),
    };
    return { events, subscriber };
}

type FakePageCommandInput = Readonly<{
    targetId: string;
    sessionId?: string;
    method: string;
    params?: Record<string, unknown>;
}>;

function fakeEventTransport() {
    let listener: BrowserSidecarCdpEventSubscriber | null = null;
    return {
        dispatchPageCommand: vi.fn(async (_input: FakePageCommandInput) => ({})),
        subscribeCdpEvents: vi.fn((next: BrowserSidecarCdpEventSubscriber) => {
            listener = next;
            return () => {
                listener = null;
            };
        }),
        emit: (notification: Parameters<BrowserSidecarCdpEventSubscriber>[0]) => listener?.(notification),
        hasListener: () => listener !== null,
    };
}

describe('translateSidecarCdpNotification', () => {
    it('maps live CDP wire events to the intermediate diagnostics shape, carrying raw fields for downstream redaction', () => {
        expect(translateSidecarCdpNotification({
            method: 'Network.requestWillBeSent',
            params: {
                requestId: 'raw_request_secret',
                request: {
                    url: 'https://example.test/api?ok=1&token=secret',
                    method: 'GET',
                    headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
                },
                type: 'XHR',
            },
        })).toEqual({
            kind: 'network.requestWillBeSent',
            requestId: 'raw_request_secret',
            method: 'GET',
            url: 'https://example.test/api?ok=1&token=secret',
            headers: { Authorization: 'Bearer secret', Accept: 'application/json' },
            resourceType: 'XHR',
        });

        expect(translateSidecarCdpNotification({
            method: 'Network.responseReceived',
            params: {
                requestId: 'raw_request_secret',
                response: { url: 'https://example.test/api', status: 200, mimeType: 'application/json' },
                type: 'XHR',
            },
        })).toMatchObject({ kind: 'network.responseReceived', status: 200, mimeType: 'application/json' });

        expect(translateSidecarCdpNotification({
            method: 'Network.loadingFailed',
            params: { requestId: 'raw_request_secret', errorText: 'net::ERR_FAILED' },
        })).toEqual({
            kind: 'network.loadingFailed',
            requestId: 'raw_request_secret',
            errorText: 'net::ERR_FAILED',
        });

        expect(translateSidecarCdpNotification({
            method: 'Runtime.consoleAPICalled',
            params: { type: 'error', args: [{ type: 'string', value: 'token=secret should not leak' }, { type: 'number', value: 1 }] },
        })).toMatchObject({ kind: 'runtime.consoleEntry', level: 'error', argCount: 2 });

        expect(translateSidecarCdpNotification({
            method: 'Runtime.exceptionThrown',
            params: { exceptionDetails: { text: 'Uncaught TypeError', stackTrace: { callFrames: [] } } },
        })).toMatchObject({ kind: 'runtime.exceptionThrown', message: 'Uncaught TypeError' });

        expect(translateSidecarCdpNotification({
            method: 'Page.frameNavigated',
            params: { frame: { id: 'frame_1', url: 'https://example.test/next' } },
        })).toMatchObject({ kind: 'page.info', url: 'https://example.test/next' });
    });

    it('returns null for unhandled CDP methods and subframe navigations', () => {
        expect(translateSidecarCdpNotification({ method: 'Target.targetInfoChanged', params: {} })).toBeNull();
        expect(translateSidecarCdpNotification({
            method: 'Page.frameNavigated',
            params: { frame: { id: 'sub', parentId: 'frame_1', url: 'https://ads.test/x' } },
        })).toBeNull();
    });
});

describe('createSidecarCdpDiagnosticsEventSource', () => {
    const pageHandle = { targetId: 'target_1', sessionId: 'cdp_session_1' } as const;

    it('enables CDP diagnostics domains on the bound page session when started', async () => {
        const transport = fakeEventTransport();
        const source = createSidecarCdpDiagnosticsEventSource({
            sourceId: 'src_1',
            pageHandle,
            transport,
        });
        const { subscriber } = captureSubscriber();
        source.start(subscriber);
        await Promise.resolve();
        await Promise.resolve();

        const methods = transport.dispatchPageCommand.mock.calls.map((call) => call[0].method);
        expect(methods).toEqual(expect.arrayContaining(['Network.enable', 'Runtime.enable', 'Page.enable']));
        for (const call of transport.dispatchPageCommand.mock.calls) {
            expect(call[0]).toMatchObject({ targetId: 'target_1', sessionId: 'cdp_session_1' });
        }
    });

    it('translates live CDP notifications for the bound session and emits them to the subscriber', () => {
        const transport = fakeEventTransport();
        const source = createSidecarCdpDiagnosticsEventSource({
            sourceId: 'src_1',
            pageHandle,
            transport,
            now: () => 4_242,
        });
        const { events, subscriber } = captureSubscriber();
        const subscription = source.start(subscriber);

        transport.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r1', request: { url: 'https://example.test/a', method: 'GET' }, type: 'Document' },
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ capturedAtMs: 4_242, event: expect.objectContaining({ kind: 'network.requestWillBeSent' }) });

        // A notification scoped to a different CDP page session is ignored (per-view isolation).
        transport.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'other_session',
            params: { requestId: 'r2', request: { url: 'https://other.test/a', method: 'GET' } },
        });
        expect(events).toHaveLength(1);

        // Unhandled methods do not emit.
        transport.emit({ method: 'Target.targetInfoChanged', sessionId: 'cdp_session_1', params: {} });
        expect(events).toHaveLength(1);

        subscription.stop();
        expect(transport.hasListener()).toBe(false);
        transport.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r3', request: { url: 'https://example.test/b', method: 'GET' } },
        });
        expect(events).toHaveLength(1);
    });

    it('fails closed per event when the live gate reports disabled', () => {
        const transport = fakeEventTransport();
        let enabled = true;
        const source = createSidecarCdpDiagnosticsEventSource({
            sourceId: 'src_1',
            pageHandle,
            transport,
            isEnabled: () => enabled,
        });
        const { events, subscriber } = captureSubscriber();
        source.start(subscriber);

        enabled = false;
        transport.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r1', request: { url: 'https://example.test/a', method: 'GET' } },
        });
        expect(events).toHaveLength(0);

        enabled = true;
        transport.emit({
            method: 'Network.requestWillBeSent',
            sessionId: 'cdp_session_1',
            params: { requestId: 'r2', request: { url: 'https://example.test/b', method: 'GET' } },
        });
        expect(events).toHaveLength(1);
    });
});
