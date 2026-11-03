import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestMessageChannel } from '@/dev/testkit/mocks/messageChannel';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    applyBrowserDiagnosticEvents,
    createBrowserDiagnosticsUiStore,
    selectBrowserDiagnosticsForView,
} from '@/sync/domains/browser/diagnostics/store';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';

import { WebIframeEngine } from './WebIframeEngine';
import { buildInjectedBrowserDiagnosticsScript } from '../../adapters/diagnostics';
import { buildCooperativeNavigationRuntimeScript, buildInjectedBrowserDiagnosticsRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';

type TestWindow = Window & typeof globalThis;

function installTestWindow(): TestWindow {
    const target = new EventTarget() as TestWindow;
    vi.stubGlobal('window', target);
    return target;
}

function dispatchMessage(
    target: EventTarget,
    input: Readonly<{
        data: unknown;
        origin: string;
        source?: MessageEventSource | null;
        ports?: readonly MessagePort[];
    }>,
): void {
    const event = new Event('message') as MessageEvent;
    Object.defineProperties(event, {
        data: {
            value: input.data,
        },
        origin: {
            value: input.origin,
        },
        source: {
            value: input.source ?? null,
        },
        ports: {
            value: input.ports ?? [],
        },
    });
    target.dispatchEvent(event);
}

function diagnosticBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        v: 1,
        kind: 'browser.diagnostics.events',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 6,
        collector: {
            collectorId: 'collector_1',
            nonce: 'nonce_1',
            version: '1.0.0',
        },
        events: [
            {
                v: 1,
                eventId: 'evt_page_1',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                capturedAtMs: 2_000,
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                fidelity: 'injectedPage',
                trusted: false,
                collector: {
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    version: '1.0.0',
                },
                data: {
                    url: 'https://preview.example.test/app?token=secret#panel',
                },
                redaction: {
                    level: 'metadataOnly',
                },
            },
        ],
        ...overrides,
    };
}

describe('WebIframeEngine diagnostics wiring', () => {
it('admits a diagnostics-only relay collector from its exact-source ready handshake', async () => {
        const host = installTestWindow();
        const frame = { postMessage: vi.fn() };
        const availability = vi.fn();
        const identity = { browserSessionId: 'bs', viewId: 'diagnostics-only', navigationGeneration: 1,
            collectorId: 'collector', nonce: 'nonce' };
        const screen = await renderScreen(<WebIframeEngine title="Preview" url="https://preview.example.test/"
            localPreview sandbox="allow-scripts allow-same-origin" testID="diagnostics-only"
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test',
                webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn(), onAvailability: availability }}
        />, { createNodeMock: node => node.type === 'iframe' ? { contentWindow: frame } : null });
        expect(new URL(screen.findByType('iframe').props.src).searchParams.has('__happierCollector')).toBe(true);
        await act(async () => dispatchMessage(host, { origin: 'https://preview.example.test', source: frame as unknown as WindowProxy,
            data: JSON.stringify({ v: 1, kind: 'browser.collector.ready', ...identity }) }));
        expect(availability).toHaveBeenLastCalledWith({ status: 'available' });
        await screen.unmount();
    });

    it('binds later preview documents to their own embedding pane even when both panes share an origin', async () => {
        const host = installTestWindow();
        const frames: Array<EventTarget & { postMessage: (data: string) => void }> = [];
        const screens: Array<Awaited<ReturnType<typeof renderScreen>>> = [];
        const observed = [vi.fn(), vi.fn()];
        const bindings: unknown[] = [];
        try {
            for (let index = 0; index < 2; index += 1) {
                const frame = Object.assign(new EventTarget(), {
                    parent: { postMessage: (data: string) => queueMicrotask(() => dispatchMessage(host, {
                        data, origin: 'https://preview.example.test', source: frame as unknown as WindowProxy,
                    })) },
                    location: { href: `https://preview.example.test/page-${index}` },
                    navigation: { canGoBack: index === 0, canGoForward: index === 1 },
                    postMessage: (data: string) => {
                        const message = JSON.parse(data);
                        if (message.kind === 'browser.collector.bind') bindings.push(message.config.viewId);
                        queueMicrotask(() => dispatchMessage(frame, {
                            data, origin: 'https://app.example.test', source: frame.parent as unknown as WindowProxy,
                        }));
                    },
                });
                frames.push(frame);
                const identity = { browserSessionId: 'bs', viewId: `pane-${index}`, navigationGeneration: 1,
                    collectorId: `collector-${index}`, nonce: `nonce-${index}` };
                screens.push(await renderScreen(<WebIframeEngine title="Preview" url="https://preview.example.test/" sandbox="allow-scripts allow-same-origin" testID={`preview-pane-${index}`}
                    onNavigationStateChange={observed[index]}
                    diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
                    automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: createBrowserAutomationControlService({ nowMs: Date.now }) }}
                />, { createNodeMock: (node) => node.type === 'iframe' ? { contentWindow: frame } : null }));
            }
            await act(async () => {
                const data = JSON.stringify({ v: 1, kind: 'browser.collector.bind.request' });
                dispatchMessage(host, { data, origin: 'https://evil.example.test', source: frames[0] as unknown as WindowProxy });
                dispatchMessage(host, { data, origin: 'https://preview.example.test', source: host });
            });
            expect(bindings).toEqual([]);
            await act(async () => {
                for (const frame of frames) new Function('window', 'document', buildCooperativeNavigationRuntimeScript('null'))(frame, { readyState: 'complete' });
            });
            expect(observed[0]).toHaveBeenLastCalledWith({ loading: false, canGoBack: true, canGoForward: false,
                url: 'https://preview.example.test/page-0', navigationGeneration: 1 });
            expect(observed[1]).toHaveBeenLastCalledWith({ loading: false, canGoBack: false, canGoForward: true,
                url: 'https://preview.example.test/page-1', navigationGeneration: 1 });
            expect(bindings).toEqual(['pane-0', 'pane-1']);
        } finally { for (const screen of screens) await screen.unmount(); }
    });

    it.each(['pagehide', 'load', 'reload', 'address'] as const)('keeps same-document automation after its exact-source handshake and retires on %s', async (retirement) => {
        const host = installTestWindow();
        const button = Object.assign(new EventTarget(), { getAttribute: () => null, innerText: 'Click' });
        const clicked = vi.fn(); button.addEventListener('click', clicked);
        const keys: string[] = [];
        class TestKeyboardEvent extends Event {
            readonly key: string;
            constructor(type: string, init: KeyboardEventInit = {}) {
                super(type, init);
                this.key = init.key ?? '';
            }
        }
        button.addEventListener('keydown', event => keys.push((event as TestKeyboardEvent).key));
        const document = { title: 'Cooperative preview', readyState: 'complete', documentElement: { nodeType: 1 }, querySelectorAll: (selector: string) => selector === '#button' ? [button] : [] };
        const navigation = Object.assign(new EventTarget(), { canGoBack: false, canGoForward: false });
        const frame = Object.assign(new EventTarget(), {
            location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/' },
            navigation,
            localStorage: { length: 0 }, sessionStorage: { length: 0 },
            parent: host,
            postMessage: (data: string) => queueMicrotask(() => dispatchMessage(frame, { data, origin: 'https://app.example.test', source: host })),
        });
        host.postMessage = (data: string) => queueMicrotask(() => dispatchMessage(host, { data, origin: 'https://preview.example.test', source: frame as unknown as WindowProxy }));
        Object.defineProperty(frame, 'document', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
        const identity = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 6, collectorId: 'collector_1', nonce: 'nonce_1' };
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        const observed = vi.fn();
        const element = (url: string, navigationKey?: string) => <WebIframeEngine title="Cooperative" url={url} navigationKey={navigationKey} sandbox="allow-scripts allow-same-origin" testID="cooperative"
            onNavigationStateChange={observed}
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', adapterKind: 'localPreview', supportedActions: ['click', 'press'], controlService: service }}
        />;
        const screen = await renderScreen(element('https://preview.example.test/?signed=a%20b'), { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: frame } : null });
        const iframe = screen.findByType('iframe');
        const initialSource = iframe.props.src;
        expect(new URL(screen.findByType('iframe').props.src).searchParams.has('__happierCollector')).toBe(true);
        expect(screen.findByType('iframe').props.src).toContain('?signed=a%20b&');
        const ready = { v: 1, kind: 'browser.collector.ready', ...identity };
        await act(async () => {
            dispatchMessage(host, { data: JSON.stringify({ ...ready, nonce: 'wrong' }), origin: 'https://preview.example.test', source: frame as unknown as WindowProxy });
            dispatchMessage(host, { data: JSON.stringify(ready), origin: 'https://evil.example.test', source: frame as unknown as WindowProxy });
            dispatchMessage(host, { data: JSON.stringify(ready), origin: 'https://preview.example.test', source: host });
        });
        const action = { v: 1 as const, ...identity, automationRequestId: 'click_cooperative', actionKind: 'click' as const, requestedBy: 'agent' as const, requesterRef: { kind: 'session' as const, id: 'session_1' }, timeoutMs: 1000, payload: { locator: { kind: 'css', value: '#button' } } };
        expect((await service.executeAction(action)).status).not.toBe('succeeded');
        const config = JSON.parse(new URL(screen.findByType('iframe').props.src).searchParams.get('__happierCollector')!);
        await act(async () => {
            new Function('window', 'document', 'console', 'performance', 'Event', 'KeyboardEvent', buildInjectedBrowserDiagnosticsRuntimeScript(JSON.stringify({ ...config, cooperativePreview: true })))(frame, document, { log() {}, info() {}, warn() {}, error() {}, debug() {} }, { getEntriesByType: () => [] }, Event, TestKeyboardEvent);
        });
        expect((await service.executeAction(action)).status).toBe('succeeded');
        expect(clicked).toHaveBeenCalledOnce();
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect((await service.executeAction({ ...action, automationRequestId: 'after_first_load' })).status).toBe('succeeded');

        // Exercise the generated reporter, then publish its observation through the real provider-preserving update.
        await act(async () => {
            new Function('window', 'document', buildCooperativeNavigationRuntimeScript(JSON.stringify(config)))(frame, document);
        });
        frame.location.href = 'https://preview.example.test/details?tab=2#section';
        await act(async () => { navigation.dispatchEvent(new Event('currententrychange')); });
        expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ url: frame.location.href }));
        await screen.update(element(observed.mock.lastCall![0].url));
        expect(screen.findByType('iframe')).toBe(iframe);
        expect(iframe.props.src).toBe(initialSource);
        expect((await service.executeAction({ ...action, automationRequestId: 'after_observation' })).status).toBe('succeeded');
        expect(clicked).toHaveBeenCalledTimes(3);
        const execute = createBrowserRuntimeActionExecutor({ automation: { controlService: service } });
        expect(await execute({ actionId: 'browser.automation.press', context: { surface: 'agent', authority: 'account_automation' },
            input: { v: 1, browserSessionId: identity.browserSessionId, viewId: identity.viewId,
                navigationGeneration: identity.navigationGeneration, requestedBy: 'agent', requesterRef: action.requesterRef,
                timeoutMs: action.timeoutMs, automationRequestId: 'press_after_observation', actionKind: 'press',
                payload: { locator: { kind: 'css', value: '#button' }, key: 'Enter' } } })).toMatchObject({ status: 'succeeded' });
        expect(keys).toEqual(['Enter']);
        // A repeated address echo must not forget the observation and navigate the document.
        await screen.update(element(frame.location.href));
        expect(screen.findByType('iframe')).toBe(iframe);
        expect(iframe.props.src).toBe(initialSource);
        frame.location.href = 'https://preview.example.test/details?tab=3#next';
        await act(async () => { navigation.dispatchEvent(new Event('currententrychange')); });
        await screen.update(element(observed.mock.lastCall![0].url));
        expect(iframe.props.src).toBe(initialSource);
        await act(async () => {
            if (retirement === 'pagehide') frame.dispatchEvent(new Event('pagehide'));
            else if (retirement === 'reload') await screen.update(element(frame.location.href, 'reload_1'));
            else if (retirement === 'address') await screen.update(element('https://preview.example.test/different-document'));
            else screen.findByType('iframe').props.onLoad();
        });
        if (retirement === 'reload') {
            const reloaded = new URL(screen.findByType('iframe').props.src);
            expect(reloaded.pathname + reloaded.search.split('&__happierCollector=')[0] + reloaded.hash).toBe('/details?tab=3#next');
        }
        expect((await service.executeAction({ ...action, automationRequestId: 'after_navigation' })).status).not.toBe('succeeded');
        await act(async () => dispatchMessage(host, { data: JSON.stringify(ready), origin: 'https://preview.example.test', source: frame as unknown as WindowProxy }));
        expect((await service.executeAction({ ...action, automationRequestId: 'stale_ready' })).status).not.toBe('succeeded');
        await screen.unmount();
        expect(Reflect.get(frame, '__happierBrowserRuntime')).toBeUndefined();
        expect((await service.executeAction({ ...action, automationRequestId: 'retired' })).status).not.toBe('succeeded');
    });

    it('reports a relay preview page history across in-frame navigations, obeys back, forward and stop through its document, and reloads the page it is on', async () => {
        const host = installTestWindow();
        const navigation = Object.assign(new EventTarget(), { canGoBack: false, canGoForward: false });
        const history: string[] = [];
        const posted: string[] = [];
        const frame = Object.assign(new EventTarget(), {
            location: { origin: 'https://preview.example.test', href: 'https://preview.example.test/' },
            navigation, parent: host, stop: () => history.push('stop'),
            // The parent cannot reach a cross-origin frame's history; only its own document can.
            history: { back: () => history.push('back'), forward: () => history.push('forward') },
            postMessage: (data: string) => { posted.push(data); queueMicrotask(() => dispatchMessage(frame, { data, origin: 'https://app.example.test', source: host })); },
        });
        host.postMessage = (data: string) => queueMicrotask(() => dispatchMessage(host, { data, origin: 'https://preview.example.test', source: frame as unknown as WindowProxy }));
        Object.defineProperty(frame, 'document', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
        const identityFor = (navigationGeneration: number) => ({ browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration, collectorId: 'collector_1', nonce: `nonce_${navigationGeneration}` });
        const onNavigationStateChange = vi.fn();
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        const element = (generation: number, extra: Readonly<{ navigationKey?: string; navigationCommand?: { commandId: string; kind: 'goBack' | 'goForward' | 'reload' | 'stop' } }> = {}) => {
            const identity = identityFor(generation);
            return <WebIframeEngine title="Relay" url="https://preview.example.test/?signed=a%20b" sandbox="allow-scripts allow-same-origin" testID="relay"
                onNavigationStateChange={onNavigationStateChange}
                diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
                automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: service }}
                {...extra} />;
        };
        const screen = await renderScreen(element(6), { createNodeMock: (node) => node.type === 'iframe' ? { contentWindow: frame } : null });
        const sourceUrl = new URL(screen.findByType('iframe').props.src);
        // The document the pane loaded with its own identity installs the collector's reporter.
        const install = (href: string) => {
            frame.location.href = href;
            new Function('window', 'document', buildCooperativeNavigationRuntimeScript(JSON.stringify({ ...JSON.parse(sourceUrl.searchParams.get('__happierCollector')!), cooperativePreview: true })))(frame, { readyState: 'complete' });
        };
        await act(async () => { install(sourceUrl.href); });
        expect(onNavigationStateChange).toHaveBeenLastCalledWith({ loading: false, canGoBack: false, canGoForward: false,
            url: 'https://preview.example.test/?signed=a%20b', navigationGeneration: 6 });

        // A report from another pane's identity, window or origin is not navigation truth.
        const report = { v: 1, kind: 'browser.collector.navigation', ...identityFor(6), loading: true, canGoBack: true, canGoForward: true, url: 'https://preview.example.test/' };
        onNavigationStateChange.mockClear();
        await act(async () => {
            dispatchMessage(host, { data: JSON.stringify({ ...report, nonce: 'other_pane' }), origin: 'https://preview.example.test', source: frame as unknown as WindowProxy });
            dispatchMessage(host, { data: JSON.stringify(report), origin: 'https://evil.example.test', source: frame as unknown as WindowProxy });
            dispatchMessage(host, { data: JSON.stringify(report), origin: 'https://preview.example.test', source: host });
            dispatchMessage(host, { data: JSON.stringify({ ...report, url: 'https://evil.example.test/' }), origin: 'https://preview.example.test', source: frame as unknown as WindowProxy });
        });
        expect(onNavigationStateChange).not.toHaveBeenCalled();

        // An in-frame link navigation retires page automation, but the next document still reports history.
        await act(async () => screen.findByType('iframe').props.onLoad());
        await act(async () => screen.findByType('iframe').props.onLoad());
        navigation.canGoBack = true;
        await act(async () => { install('https://preview.example.test/other?x=1'); });
        expect(onNavigationStateChange).toHaveBeenLastCalledWith({ loading: false, canGoBack: true, canGoForward: false,
            url: 'https://preview.example.test/other?x=1', navigationGeneration: 6 });
        await act(async () => { navigation.canGoBack = false; navigation.canGoForward = true; navigation.dispatchEvent(new Event('currententrychange')); });
        expect(onNavigationStateChange).toHaveBeenLastCalledWith({ loading: false, canGoBack: false, canGoForward: true,
            url: 'https://preview.example.test/other?x=1', navigationGeneration: 6 });

        for (const [kind, expected] of [['goBack', 'back'], ['goForward', 'forward'], ['stop', 'stop']] as const) {
            await screen.update(element(6, { navigationCommand: { commandId: `command_${kind}`, kind } }));
            await act(async () => undefined);
            expect(history.at(-1)).toBe(expected);
        }
        expect(posted).toHaveLength(3);

        // Reload keeps the page the preview is on and arrives under the new identity, never at the opening page.
        await screen.update(element(7, { navigationKey: 'reload_1' }));
        const reloaded = new URL(screen.findByType('iframe').props.src);
        expect(reloaded.pathname + reloaded.search.replace(/&__happierCollector=.*/, '')).toBe('/other?x=1');
        expect(JSON.parse(reloaded.searchParams.get('__happierCollector')!).navigationGeneration).toBe(7);

        // The host derives the reload key from its latest effect only, so the next command (Stop) arrives without it.
        // That must not remount the frame at the opening page: the reloaded document is still the current one.
        await screen.update(element(7, { navigationCommand: { commandId: 'command_stop_after_reload', kind: 'stop' } }));
        const afterStop = new URL(screen.findByType('iframe').props.src);
        expect(afterStop.pathname + afterStop.search.replace(/&__happierCollector=.*/, '')).toBe('/other?x=1');
        await screen.unmount();
    });

    it.each(['collector_blocked_by_csp', 'runtime_unavailable'] as const)('reports cooperative refusal %s through the authorized metadata-only probe, without admitting an owner', async (state) => {
        installTestWindow();
        const rejection = vi.fn();
        const fetchBoundary = vi.fn(async (url: string) => ({ ok: true, url, json: async () => ({ state }) }));
        vi.stubGlobal('fetch', fetchBoundary);
        const identity = { browserSessionId: 'bs', viewId: 'v', navigationGeneration: 1, collectorId: 'c', nonce: 'n' };
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        const screen = await renderScreen(<WebIframeEngine title="Blocked" url="https://preview.example.test/" sandbox="allow-scripts allow-same-origin" testID="blocked"
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://preview.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: service, onRegistrationRejected: rejection }}
        />, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: {} } : null });
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect(rejection).toHaveBeenCalledWith(state);
        expect(screen.findAllByType('iframe')).toHaveLength(1);
        expect(screen.findHostByTestId('blocked-unavailable')).toBeNull();
        const probe = new URL(fetchBoundary.mock.calls[0]![0]);
        expect(probe.origin).toBe('https://preview.example.test');
        expect(probe.searchParams.get('__happierCollectorState')).toBe('1');
        expect((await service.executeAction({ v: 1, ...identity, automationRequestId: 'blocked', actionKind: 'click', requestedBy: 'agent', requesterRef: { kind: 'session', id: 's' }, timeoutMs: 1000, payload: { locator: { kind: 'css', value: '#button' } } })).status).not.toBe('succeeded');
        await screen.unmount();
    });

    it('installs the collector in the loaded same-origin document before admitting page actions and retires it on unmount', async () => {
        const host = installTestWindow();
        const page = new EventTarget();
        const clicked = vi.fn();
        const diagnosticEvents = vi.fn();
        const button = Object.assign(new EventTarget(), { getAttribute: () => null, innerText: 'Click' });
        button.addEventListener('click', clicked);
        const scriptNodes: Array<{ textContent: string; remove: () => void }> = [];
        const documentBoundary = {
            title: 'Accessible preview',
            readyState: 'complete',
            documentElement: { nodeType: 1 },
            querySelectorAll: (selector: string) => selector === '#button' ? [button] : [],
            createElement: () => ({ textContent: '', remove: vi.fn() }),
            head: {
                appendChild: (script: { textContent: string; remove: () => void }) => {
                    scriptNodes.push(script);
                    // Browser boundary: inserting a classic script executes it in the guest realm.
                    new Function('window', 'document', 'console', 'performance', 'Event', script.textContent)(
                        frame, documentBoundary, { log() {}, info() {}, warn() {}, error() {}, debug() {} },
                        { getEntriesByType: () => [] }, Event,
                    );
                },
            },
        };
        const frame = Object.assign(page, {
            document: documentBoundary,
            location: { href: 'https://app.example.test/preview', origin: 'https://app.example.test' },
            localStorage: { length: 0 },
            sessionStorage: { length: 0 },
            parent: { postMessage: (data: string, origin: string) => queueMicrotask(() => dispatchMessage(host, {
                data, origin, source: frame as unknown as WindowProxy,
            })) },
            postMessage: (data: string) => queueMicrotask(() => dispatchMessage(frame, {
                data, origin: 'https://app.example.test', source: host,
            })),
        });
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        const identity = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 6, collectorId: 'collector_1', nonce: 'nonce_1' };
        const screen = await renderScreen(<WebIframeEngine
            title="Accessible preview" url="https://app.example.test/preview"
            sandbox="allow-scripts allow-same-origin" testID="accessible-frame"
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://app.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: diagnosticEvents }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://app.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: service }}
        />, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: frame } : null });
        expect(scriptNodes).toHaveLength(0);
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect(scriptNodes).toHaveLength(1);
        expect(diagnosticEvents).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({
            browserSessionId: identity.browserSessionId, viewId: identity.viewId,
            navigationGeneration: identity.navigationGeneration,
            collector: { collectorId: identity.collectorId, nonce: identity.nonce, version: '1.0.0' },
        })]));
        const installedRuntime = Reflect.get(frame, '__happierBrowserRuntime');
        // Routine host rerenders must not reinstall the guest or abandon an active command.
        await screen.update(<WebIframeEngine
            title="Accessible preview" url="https://app.example.test/preview"
            sandbox="allow-scripts allow-same-origin" testID="accessible-frame"
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://app.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: diagnosticEvents }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://app.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: service }}
        />);
        expect(scriptNodes).toHaveLength(1);
        expect(Reflect.get(frame, '__happierBrowserRuntime')).toBe(installedRuntime);
        const result = await service.executeAction({ v: 1, ...identity, automationRequestId: 'click_1', actionKind: 'click', requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' }, timeoutMs: 1_000, payload: { locator: { kind: 'css', value: '#button' } } });
        expect(result.status).toBe('succeeded');
        expect(clicked).toHaveBeenCalledOnce();
        Object.defineProperty(frame, 'document', { value: { ...documentBoundary } });
        const staleDocumentResult = await service.executeAction({ v: 1, ...identity, automationRequestId: 'click_stale', actionKind: 'click', requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' }, timeoutMs: 1_000, payload: { locator: { kind: 'css', value: '#button' } } });
        expect(staleDocumentResult.errorCode).toBe('cross_origin_frame_unavailable');
        expect(clicked).toHaveBeenCalledOnce();
        await screen.unmount();
        expect(Reflect.get(frame, '__happierBrowserRuntime')).toBeUndefined();
        expect((await service.executeAction({ v: 1, ...identity, automationRequestId: 'click_2', actionKind: 'click', requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' }, timeoutMs: 1_000 })).status).not.toBe('succeeded');
    });

    it.each(['opaque sandbox', 'cross-origin document', 'blocked script'] as const)('refuses automation promptly for an unreachable collector: %s', async (failure) => {
        installTestWindow();
        const rejection = vi.fn();
        const frame = { postMessage: vi.fn(), location: { origin: 'https://app.example.test' }, document: {
            createElement: () => ({ textContent: '', remove: vi.fn() }), head: { appendChild() {} },
        } };
        if (failure === 'cross-origin document') Object.defineProperty(frame, 'document', { get: () => { throw new DOMException('Blocked', 'SecurityError'); } });
        const service = createBrowserAutomationControlService({ nowMs: Date.now });
        const identity = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 6, collectorId: 'collector_1', nonce: 'nonce_1' };
        const screen = await renderScreen(<WebIframeEngine title="Unreachable" url="https://app.example.test/preview" sandbox={failure === 'opaque sandbox' ? 'allow-scripts' : 'allow-scripts allow-same-origin'} testID="unreachable-frame"
            diagnostics={{ ...identity, collectorVersion: '1.0.0', sourceOrigin: 'https://app.example.test', webPostMessageTargetOrigin: 'https://app.example.test', onEvents: vi.fn() }}
            automation={{ ...identity, capabilityVersion: '1.0.0', sourceOrigin: 'https://app.example.test', adapterKind: 'localPreview', supportedActions: ['click'], controlService: service, onRegistrationRejected: rejection }}
        />, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: frame } : null });
        await act(async () => screen.findByType('iframe').props.onLoad());
        expect(rejection).toHaveBeenCalledWith(failure === 'blocked script' ? 'runtime_unavailable' : 'cross_origin_frame_unavailable');
        const result = await service.executeAction({ v: 1, ...identity, automationRequestId: 'unreachable_1', actionKind: 'click', requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' }, timeoutMs: 1_000 });
        expect(result.status).not.toBe('timed_out');
        expect(frame.postMessage).not.toHaveBeenCalled();
    });

    it.each(['unmount', 'navigation', 'source replacement'] as const)('does not deliver a pending bridge response after %s retirement', async (retirement) => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        let finish!: (response: unknown) => void;
        const pending = new Promise((resolve) => { finish = resolve; });
        const webMessageBridge = {
            targetOrigin: '*',
            allowWildcardTargetOrigin: true,
            onMessage: () => pending,
        };
        const screen = await renderScreen(
            <WebIframeEngine
                title="Inline"
                {...(retirement === 'navigation' ? { url: 'https://artifact.example.test/inline' } : { html: '<p>Inline</p>' })}
                sandbox="allow-scripts"
                testID="inline-frame"
                revokeOnUnexpectedNavigation={retirement === 'navigation'}
                webMessageBridge={webMessageBridge}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: iframeSource } : null },
        );
        await act(async () => dispatchMessage(testWindow, {
            data: 'request', origin: 'null', source: iframeSource,
        }));
        if (retirement === 'unmount') {
            await screen.unmount();
        } else if (retirement === 'source replacement') {
            await screen.update(<WebIframeEngine title="Inline" html="<p>Replacement</p>" sandbox="allow-scripts" testID="inline-frame" webMessageBridge={webMessageBridge} />);
        } else {
            const iframe = screen.findByType('iframe');
            await act(async () => {
                iframe.props.onLoad();
                iframe.props.onLoad();
            });
        }
        await act(async () => { finish({ result: 'retired-data' }); });
        expect(iframeSource.postMessage).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('accepts injected iframe diagnostics through an explicit-origin postMessage bridge only', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const otherSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const rejectedMessages: string[] = [];
        const collectorScripts: string[] = [];
        let store = createBrowserDiagnosticsUiStore();

        await renderScreen(
            <WebIframeEngine
                title="Preview"
                url="https://preview.example.test/app"
                sandbox="allow-scripts"
                testID="browser-web-frame"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    sourceOrigin: 'https://preview.example.test',
                    webPostMessageTargetOrigin: 'https://app.example.test',
                    onCollectorScriptReady: (script) => {
                        collectorScripts.push(script);
                    },
                    onEvents: (events) => {
                        store = applyBrowserDiagnosticEvents(store, { events });
                    },
                    onRejectedMessage: (reasonCode) => {
                        rejectedMessages.push(reasonCode);
                    },
                }}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            },
        );

        expect(collectorScripts).toHaveLength(1);
        expect(collectorScripts[0]).toContain('"webPostMessageTargetOrigin":"https://app.example.test"');
        expect(collectorScripts[0]).not.toContain("postMessage(serialized, '*')");

        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch()),
            origin: 'https://evil.example.test',
        });
        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch({ navigationGeneration: 5 })),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });
        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch()),
            origin: 'https://preview.example.test',
            source: otherSource,
        });
        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch()),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });

        expect(selectBrowserDiagnosticsForView(store, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).toMatchObject({
            status: 'available',
            eventCount: 1,
            fidelity: 'injectedPage',
            trusted: false,
            events: [
                expect.objectContaining({
                    summary: 'https://preview.example.test/app',
                }),
            ],
        });
        expect(rejectedMessages).toEqual(['origin_mismatch', 'navigation_stale', 'source_mismatch']);
    });

    it('normalizes protocol-shaped iframe source origins for diagnostics messages and commands', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const rejectedMessages: string[] = [];
        let store = createBrowserDiagnosticsUiStore();

        await renderScreen(
            <WebIframeEngine
                title="Preview"
                url="https://preview.example.test/app"
                sandbox="allow-scripts"
                testID="browser-web-frame"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    sourceOrigin: 'https://preview.example.test/',
                    webPostMessageTargetOrigin: 'https://app.example.test/',
                    evalRequest: {
                        v: 1,
                        evalRequestId: 'eval_1',
                        viewId: 'view_1',
                        navigationGeneration: 6,
                        tier: 'injectedPage',
                        expression: 'document.title',
                        timeoutMs: 2_000,
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    onEvents: (events) => {
                        store = applyBrowserDiagnosticEvents(store, { events });
                    },
                    onRejectedMessage: (reasonCode) => {
                        rejectedMessages.push(reasonCode);
                    },
                }}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            },
        );

        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch()),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });

        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            expect.stringContaining('"kind":"browser.diagnostics.evalRequest"'),
            'https://preview.example.test',
        );
        expect(selectBrowserDiagnosticsForView(store, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).toMatchObject({
            status: 'available',
            eventCount: 1,
        });
        expect(rejectedMessages).toEqual([]);
    });

    it('fails closed when iframe diagnostics have no explicit postMessage target origin', async () => {
        const testWindow = installTestWindow();
        const onCollectorScriptReady = vi.fn();
        const onEvents = vi.fn();
        const onRejectedMessage = vi.fn();

        await renderScreen(
            <WebIframeEngine
                title="Preview"
                url="https://preview.example.test/app"
                sandbox="allow-scripts"
                testID="browser-web-frame"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    sourceOrigin: 'https://preview.example.test',
                    onCollectorScriptReady,
                    onEvents,
                    onRejectedMessage,
                }}
            />,
        );

        dispatchMessage(testWindow, {
            data: JSON.stringify(diagnosticBatch()),
            origin: 'https://preview.example.test',
        });

        expect(onCollectorScriptReady).not.toHaveBeenCalled();
        expect(onEvents).not.toHaveBeenCalled();
        expect(onRejectedMessage).toHaveBeenCalledWith('unsupported_web_post_message');
    });

    it('applies local browser navigation commands to the iframe window', async () => {
        const historyBack = vi.fn();
        const historyForward = vi.fn();
        const reload = vi.fn();
        const stop = vi.fn();
        const iframeSource = {
            history: {
                back: historyBack,
                forward: historyForward,
            },
            location: {
                reload,
            },
            stop,
        } as unknown as WindowProxy;

        async function renderCommand(kind: 'goBack' | 'goForward' | 'reload' | 'stop'): Promise<void> {
            await renderScreen(
                <WebIframeEngine
                    title="Preview"
                    url="https://preview.example.test/app"
                    sandbox="allow-scripts"
                    testID={`browser-web-frame-${kind}`}
                    navigationCommand={{
                        commandId: `command_${kind}`,
                        kind,
                    }}
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
        }

        await renderCommand('goBack');
        await renderCommand('goForward');
        await renderCommand('reload');
        await renderCommand('stop');

        expect(historyBack).toHaveBeenCalledTimes(1);
        expect(historyForward).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('permits wildcard bridge delivery only for an explicitly opaque Artifact guest', async () => {
        const testWindow = installTestWindow();
        const ordinaryFrame = { postMessage: vi.fn() } as unknown as WindowProxy;
        const opaqueArtifactFrame = { postMessage: vi.fn() } as unknown as WindowProxy;

        await renderScreen(
            <WebIframeEngine
                title="Ordinary guest"
                url="https://preview.example.test/ordinary"
                sandbox="allow-scripts"
                testID="ordinary-web-frame"
                webMessageBridge={{
                    targetOrigin: '*',
                    onMessage: () => ({ accepted: true }),
                }}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: ordinaryFrame }
                        : null
                ),
            },
        );
        await renderScreen(
            <WebIframeEngine
                title="Opaque Artifact guest"
                url="https://app.example.test/__happier/hosted-artifacts/hwa_token/index.html"
                sandbox="allow-scripts"
                testID="opaque-artifact-web-frame"
                webMessageBridge={{
                    targetOrigin: '*',
                    allowWildcardTargetOrigin: true,
                    onMessage: () => ({ accepted: true }),
                }}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: opaqueArtifactFrame }
                        : null
                ),
            },
        );

        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'ordinary-message',
                origin: 'null',
                source: ordinaryFrame,
            });
            dispatchMessage(testWindow, {
                data: 'artifact-message',
                origin: 'null',
                source: opaqueArtifactFrame,
            });
            await Promise.resolve();
        });

        expect(ordinaryFrame.postMessage).not.toHaveBeenCalled();
        expect(opaqueArtifactFrame.postMessage).toHaveBeenCalledWith(
            { accepted: true },
            '*',
        );
    });

    it('binds an opaque bridge to the admitted document port before host delivery', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const documentChannel = createTestMessageChannel();
        const onMessage = vi.fn((event: MessageEvent) => ({ replyTo: event.data }));
        const onMessageAfterRerender = vi.fn((event: MessageEvent) => ({ replyTo: event.data }));
        let sendHostMessage: ((message: unknown) => void) | null = null;
        const attachHostMessages = (send: (message: unknown) => void) => {
            sendHostMessage = send;
            return () => { sendHostMessage = null; };
        };
        const webMessageBridge = (handleMessage: typeof onMessage) => ({
            targetOrigin: '*',
            allowWildcardTargetOrigin: true,
            exactDocumentChannel: true,
            onMessage: handleMessage,
            attachHostMessages,
        });

        const screen = await renderScreen(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>admitted document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={webMessageBridge(onMessage)}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: iframeSource } : null },
        );

        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'ready',
                origin: 'null',
                source: iframeSource,
                ports: [documentChannel.port1],
            });
            await Promise.resolve();
        });
        expect(documentChannel.port1.postMessage).toHaveBeenCalledWith({ replyTo: 'ready' });

        await screen.update(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>admitted document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={webMessageBridge(onMessageAfterRerender)}
            />,
        );

        await act(async () => {
            documentChannel.port2.postMessage('document request');
            sendHostMessage?.({ push: 'current document only' });
            dispatchMessage(testWindow, { data: 'replacement request', origin: 'null', source: iframeSource });
            await Promise.resolve();
        });

        expect(onMessage.mock.calls.map(([event]) => event.data)).toEqual(['ready']);
        expect(onMessageAfterRerender.mock.calls.map(([event]) => event.data)).toEqual(['document request']);
        expect(documentChannel.port1.postMessage).toHaveBeenCalledWith({ push: 'current document only' });
        expect(iframeSource.postMessage).not.toHaveBeenCalled();
    });

    it('retires an exact-document port when inline document authority changes and requires a fresh handshake', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const incumbentChannel = createTestMessageChannel();
        const replacementChannel = createTestMessageChannel();
        const onMessage = vi.fn((event: MessageEvent) => ({ replyTo: event.data }));
        let sendHostMessage: ((message: unknown) => void) | null = null;
        const webMessageBridge = {
            targetOrigin: '*',
            allowWildcardTargetOrigin: true,
            exactDocumentChannel: true,
            onMessage,
            attachHostMessages: (send: (message: unknown) => void) => {
                sendHostMessage = send;
                return () => { sendHostMessage = null; };
            },
        };
        const screen = await renderScreen(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>incumbent document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={webMessageBridge}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: iframeSource } : null },
        );

        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'incumbent ready',
                origin: 'null',
                source: iframeSource,
                ports: [incumbentChannel.port1],
            });
            await Promise.resolve();
        });
        expect(onMessage.mock.calls.map(([event]) => event.data)).toEqual(['incumbent ready']);

        incumbentChannel.port1PostMessage.mockClear();
        await screen.update(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>replacement document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={webMessageBridge}
            />,
        );

        await act(async () => {
            incumbentChannel.port2.postMessage('retired document request');
            sendHostMessage?.({ push: 'before replacement handshake' });
            dispatchMessage(testWindow, {
                data: 'replacement without port',
                origin: 'null',
                source: iframeSource,
            });
            await Promise.resolve();
        });
        expect(incumbentChannel.port1Close).toHaveBeenCalledOnce();
        expect(incumbentChannel.port1PostMessage).not.toHaveBeenCalled();
        expect(replacementChannel.port1PostMessage).not.toHaveBeenCalled();
        expect(onMessage.mock.calls.map(([event]) => event.data)).toEqual(['incumbent ready']);

        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'replacement ready',
                origin: 'null',
                source: iframeSource,
                ports: [replacementChannel.port1],
            });
            replacementChannel.port2.postMessage('replacement request');
            sendHostMessage?.({ push: 'replacement current' });
            await Promise.resolve();
        });
        expect(onMessage.mock.calls.map(([event]) => event.data)).toEqual([
            'incumbent ready',
            'replacement ready',
            'replacement request',
        ]);
        expect(replacementChannel.port1PostMessage).toHaveBeenCalledWith({ replyTo: 'replacement ready' });
        expect(replacementChannel.port1PostMessage).toHaveBeenCalledWith({ replyTo: 'replacement request' });
        expect(replacementChannel.port1PostMessage).toHaveBeenCalledWith({ push: 'replacement current' });
        expect(iframeSource.postMessage).not.toHaveBeenCalled();
    });

    it('delivers the attachment owner terminal push through an ordinary-origin frame before teardown', async () => {
        installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        let detachCount = 0;
        const screen = await renderScreen(
            <WebIframeEngine
                title="Ordinary guest"
                url="https://guest.example.test/app"
                sandbox="allow-scripts"
                testID="ordinary-web-frame"
                webMessageBridge={{
                    targetOrigin: 'https://guest.example.test',
                    onMessage: () => undefined,
                    attachHostMessages: (send) => () => {
                        detachCount += 1;
                        send({ terminal: 'disconnected' });
                    },
                }}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: iframeSource } : null },
        );

        await screen.unmount();

        // The bridge owner's one terminal packet must reach the incumbent guest.
        // Retiring the delivery primitive first drops it silently.
        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            { terminal: 'disconnected' },
            'https://guest.example.test',
        );
        expect(detachCount).toBe(1);
    });

    it('delivers the attachment owner terminal push over the incumbent document port before it is closed', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const incumbentChannel = createTestMessageChannel();
        const replacementChannel = createTestMessageChannel();
        let detachCount = 0;
        const bridge = (terminal: string) => ({
            targetOrigin: '*',
            allowWildcardTargetOrigin: true,
            exactDocumentChannel: true,
            onMessage: () => undefined,
            attachHostMessages: (send: (message: unknown) => void) => () => {
                detachCount += 1;
                send({ terminal });
            },
        });

        const screen = await renderScreen(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>incumbent document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={bridge('incumbent-disconnected')}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: iframeSource } : null },
        );
        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'incumbent ready',
                origin: 'null',
                source: iframeSource,
                ports: [incumbentChannel.port1],
            });
            await Promise.resolve();
        });

        // A replacement document retires the incumbent transport. The terminal
        // packet must land on the incumbent port while it is still open.
        await screen.update(
            <WebIframeEngine
                title="Opaque Artifact guest"
                html="<p>replacement document</p>"
                sandbox="allow-scripts"
                testID="opaque-document-frame"
                webMessageBridge={bridge('replacement-disconnected')}
            />,
        );
        expect(incumbentChannel.port1PostMessage).toHaveBeenCalledWith({ terminal: 'incumbent-disconnected' });
        expect(incumbentChannel.port1Close).toHaveBeenCalledOnce();
        expect(detachCount).toBe(1);

        await act(async () => {
            dispatchMessage(testWindow, {
                data: 'replacement ready',
                origin: 'null',
                source: iframeSource,
                ports: [replacementChannel.port1],
            });
            await Promise.resolve();
        });
        await screen.unmount();

        // Unmount is the same ordered retirement, and each attachment is
        // disposed exactly once.
        expect(replacementChannel.port1PostMessage).toHaveBeenCalledWith({ terminal: 'replacement-disconnected' });
        expect(detachCount).toBe(2);
        expect(incumbentChannel.port1PostMessage).not.toHaveBeenCalledWith({ terminal: 'replacement-disconnected' });
        expect(iframeSource.postMessage).not.toHaveBeenCalled();
    });

    it('issues one host-owned transient activation only to the exact focused iframe', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const iframeElement = { contentWindow: iframeSource } as unknown as HTMLIFrameElement;
        const otherElement = {} as Element;
        const userActivation = { isActive: true };
        let activeElement: Element | null = otherElement;
        vi.stubGlobal('navigator', { userActivation });
        vi.stubGlobal('document', {
            get activeElement() { return activeElement; },
        });
        const receipts: Array<Readonly<{ consumeTransientActivation(): boolean }>> = [];

        await renderScreen(
            <WebIframeEngine
                title="Inline"
                html="<button>Send</button>"
                sandbox="allow-scripts"
                testID="inline-frame"
                webMessageBridge={{
                    targetOrigin: '*',
                    allowWildcardTargetOrigin: true,
                    onMessage: (...args: unknown[]) => {
                        receipts.push(args[1] as Readonly<{ consumeTransientActivation(): boolean }>);
                    },
                }}
            />,
            { createNodeMock: (element) => element.type === 'iframe' ? iframeElement : null },
        );

        dispatchMessage(testWindow, { data: 'wrong-frame', origin: 'null', source: iframeSource });
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);

        activeElement = iframeElement;
        dispatchMessage(testWindow, { data: 'genuine', origin: 'null', source: iframeSource });
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(true);
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);

        dispatchMessage(testWindow, { data: 'replay', origin: 'null', source: iframeSource });
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);

        userActivation.isActive = false;
        dispatchMessage(testWindow, { data: 'delayed', origin: 'null', source: iframeSource });
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(false);
        userActivation.isActive = true;
        dispatchMessage(testWindow, { data: 'next-genuine-activation', origin: 'null', source: iframeSource });
        expect(receipts.at(-1)?.consumeTransientActivation()).toBe(true);
    });

    it('posts eval requests into the iframe and routes nonce-bound eval results back to diagnostics', async () => {
        const testWindow = installTestWindow();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const onEvalResult = vi.fn();
        const onPropertiesResult = vi.fn();
        const onReleaseObjectGroupResult = vi.fn();
        const onElementPickerResult = vi.fn();

        await renderScreen(
            <WebIframeEngine
                title="Preview"
                url="https://preview.example.test/app"
                sandbox="allow-scripts"
                testID="browser-web-frame"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    collectorVersion: '1.0.0',
                    sourceOrigin: 'https://preview.example.test',
                    webPostMessageTargetOrigin: 'https://app.example.test',
                    evalRequest: {
                        v: 1,
                        evalRequestId: 'eval_1',
                        viewId: 'view_1',
                        navigationGeneration: 6,
                        tier: 'injectedPage',
                        expression: '({ ok: true })',
                        timeoutMs: 2_000,
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    getPropertiesRequest: {
                        v: 1,
                        propertyRequestId: 'props_1',
                        viewId: 'view_1',
                        navigationGeneration: 6,
                        tier: 'injectedPage',
                        objectId: 'obj_1',
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    releaseObjectGroupRequest: {
                        v: 1,
                        releaseRequestId: 'release_1',
                        viewId: 'view_1',
                        navigationGeneration: 6,
                        tier: 'injectedPage',
                        objectGroupId: 'group_1',
                        diagnosticsInteractionEnabled: true,
                    },
                    elementPickerRequest: {
                        v: 1,
                        pickerRequestId: 'picker_1',
                        viewId: 'view_1',
                        navigationGeneration: 6,
                        tier: 'injectedPage',
                        action: 'start',
                        diagnosticsInteractionEnabled: true,
                    },
                    onEvents: vi.fn(),
                    onEvalResult,
                    onPropertiesResult,
                    onReleaseObjectGroupResult,
                    onElementPickerResult,
                }}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            },
        );

        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            expect.stringContaining('"kind":"browser.diagnostics.evalRequest"'),
            'https://preview.example.test',
        );
        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            expect.stringContaining('"kind":"browser.diagnostics.getPropertiesRequest"'),
            'https://preview.example.test',
        );
        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            expect.stringContaining('"kind":"browser.diagnostics.releaseObjectGroupRequest"'),
            'https://preview.example.test',
        );
        expect(iframeSource.postMessage).toHaveBeenCalledWith(
            expect.stringContaining('"kind":"browser.diagnostics.elementPickerRequest"'),
            'https://preview.example.test',
        );

        dispatchMessage(testWindow, {
            data: JSON.stringify({
                v: 1,
                kind: 'browser.diagnostics.evalResult',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                collector: {
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    version: '1.0.0',
                },
                result: {
                    v: 1,
                    evalRequestId: 'eval_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    status: 'completed',
                    tier: 'injectedPage',
                    audited: true,
                    result: {
                        type: 'object',
                        objectId: 'obj_1',
                        className: 'Object',
                        description: 'Object',
                    },
                },
            }),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });

        expect(onEvalResult).toHaveBeenCalledWith(expect.objectContaining({
            evalRequestId: 'eval_1',
            status: 'completed',
        }));

        dispatchMessage(testWindow, {
            data: JSON.stringify({
                v: 1,
                kind: 'browser.diagnostics.getPropertiesResult',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                collector: {
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    version: '1.0.0',
                },
                result: {
                    v: 1,
                    propertyRequestId: 'props_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    tier: 'injectedPage',
                    status: 'completed',
                    audited: true,
                    objectId: 'obj_1',
                    properties: [{ name: 'ok', value: { type: 'boolean', value: true }, enumerable: true }],
                },
            }),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });
        dispatchMessage(testWindow, {
            data: JSON.stringify({
                v: 1,
                kind: 'browser.diagnostics.releaseObjectGroupResult',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                collector: {
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    version: '1.0.0',
                },
                result: {
                    v: 1,
                    releaseRequestId: 'release_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    tier: 'injectedPage',
                    status: 'completed',
                    audited: true,
                    objectGroupId: 'group_1',
                },
            }),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });
        dispatchMessage(testWindow, {
            data: JSON.stringify({
                v: 1,
                kind: 'browser.diagnostics.elementPickerResult',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 6,
                collector: {
                    collectorId: 'collector_1',
                    nonce: 'nonce_1',
                    version: '1.0.0',
                },
                result: {
                    v: 1,
                    pickerRequestId: 'picker_1',
                    viewId: 'view_1',
                    navigationGeneration: 6,
                    tier: 'injectedPage',
                    status: 'selected',
                    audited: true,
                    backendNodeRef: 'node_1',
                    selectorPath: 'html > body > main:nth-of-type(1)',
                    rect: { x: 10, y: 20, width: 300, height: 40 },
                    accessibleName: 'Run',
                },
            }),
            origin: 'https://preview.example.test',
            source: iframeSource,
        });

        expect(onPropertiesResult).toHaveBeenCalledWith(expect.objectContaining({
            propertyRequestId: 'props_1',
            properties: [expect.objectContaining({ name: 'ok' })],
        }));
        expect(onReleaseObjectGroupResult).toHaveBeenCalledWith(expect.objectContaining({
            releaseRequestId: 'release_1',
            objectGroupId: 'group_1',
        }));
        expect(onElementPickerResult).toHaveBeenCalledWith(expect.objectContaining({
            pickerRequestId: 'picker_1',
            backendNodeRef: 'node_1',
            selectorPath: 'html > body > main:nth-of-type(1)',
        }));
    });
});
