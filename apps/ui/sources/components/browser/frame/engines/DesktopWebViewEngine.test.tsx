import * as React from 'react';
import { readFileSync } from 'node:fs';
import { act } from 'react-test-renderer';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import type {
    DesktopBrowserCommandResult,
    DesktopBrowserPageInfoResult,
    DesktopBrowserPageInfo,
    DesktopBrowserViewEvent,
} from '@/sync/domains/browser/adapters/desktopWebViewBridge';

import { DesktopWebViewEngine, type DesktopWebViewEngineBridge } from './DesktopWebViewEngine';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { storage } from '@/sync/domains/state/storage';
import { buildInjectedBrowserDiagnosticsScript } from '@/components/browser/adapters/diagnostics';
import { applyBrowserControlEvent, createBrowserControlState } from '@/sync/domains/browser/control/reducer';
import { browserViewLifecycleEvent, type BrowserViewLifecycleSignal } from '@/sync/domains/browser/control/lifecycle';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const availableDesktopWebView = {
    available: true,
    platform: 'macos',
    primitive: 'macosNsViewWebKit',
    renderEngine: 'desktopWebView',
    producer: 'tauriWryNativeChildView',
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: false,
        reload: false,
        stop: false,
        pageInfoDiagnostics: true,
        nativeDevtools: true,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} as const;

function createExternalDesktopView(overrides: Partial<BrowserControlViewState> = {}): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_external_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://example.com/',
            display: { title: 'Example' },
        },
        platform: 'desktop',
        adapterKind: 'externalUrl',
        engineKind: 'desktopWebView',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['desktopWebView'],
            desktopWebViewSupport: availableDesktopWebView.supports,
        }),
        currentUrl: 'https://example.com/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Example',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://example.com',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
        ...overrides,
    };
}

function createBridge() {
    const listeners = new Set<(event: DesktopBrowserViewEvent) => void>();
    const commandResult = { ok: true, availability: availableDesktopWebView } satisfies DesktopBrowserCommandResult;
    const pageInfoResult = {
        ok: true,
        availability: availableDesktopWebView,
        pageInfo: {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            requestedUrl: 'https://example.com/dashboard?token=secret#panel',
            currentUrl: 'https://example.com/dashboard?token=secret#panel',
            title: 'Example dashboard',
            loadingState: 'finished',
            canGoBack: true,
            canGoForward: false,
        },
    } satisfies DesktopBrowserPageInfoResult;
    const readPageInfo = vi.fn<() => Promise<DesktopBrowserPageInfoResult>>(async () => pageInfoResult);
    const publishPageInfo = async () => {
        const result = await readPageInfo();
        if (result.ok && result.pageInfo) for (const listener of listeners) listener({ kind: 'pageInfoChanged', pageInfo: result.pageInfo, lifecycleChanged: true, navigationGeneration: 0 });
    };
    return {
        subscribe: vi.fn<DesktopWebViewEngineBridge['subscribe']>(async (_target, listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }),
        emitNativeEvent: (kind: 'pageInfoChanged' | 'diagnosticsAvailable', changes?: Partial<DesktopBrowserPageInfo>, lifecycleChanged = true, navigationGeneration = 0) => {
            for (const listener of listeners) listener(kind === 'diagnosticsAvailable' ? { kind } : {
                kind, pageInfo: { ...pageInfoResult.pageInfo, ...changes }, lifecycleChanged, navigationGeneration,
            });
        },
        openView: vi.fn<DesktopWebViewEngineBridge['openView']>(async () => { await publishPageInfo(); return commandResult; }),
        navigateView: vi.fn<DesktopWebViewEngineBridge['navigateView']>(async () => { await publishPageInfo(); return commandResult; }),
        setBounds: vi.fn<DesktopWebViewEngineBridge['setBounds']>(async () => commandResult),
        setPointerPassthrough: vi.fn<DesktopWebViewEngineBridge['setPointerPassthrough']>(async () => commandResult),
        closeView: vi.fn<DesktopWebViewEngineBridge['closeView']>(async () => commandResult),
        openDevtools: vi.fn<DesktopWebViewEngineBridge['openDevtools']>(async () => commandResult),
        readPageInfo,
        drainDiagnostics: vi.fn<DesktopWebViewEngineBridge['drainDiagnostics']>(async () => ({ ok: true, availability: availableDesktopWebView, messages: [] })),
        evalScript: vi.fn<DesktopWebViewEngineBridge['evalScript']>(async () => commandResult),
        dispatchNavigation: vi.fn<DesktopWebViewEngineBridge['dispatchNavigation']>(async () => commandResult),
    } satisfies DesktopWebViewEngineBridge & {
        emitNativeEvent: (kind: 'pageInfoChanged' | 'diagnosticsAvailable', changes?: Partial<DesktopBrowserPageInfo>, lifecycleChanged?: boolean, navigationGeneration?: number) => void;
        readPageInfo: typeof readPageInfo;
    };
}

describe('DesktopWebViewEngine', () => {
    it('returns address focus from a guest field through the configured keyboard owner and releases hidden views', async () => {
        const host = new JSDOM('<input id="address">', { url: 'https://host.test' });
        const guest = new JSDOM('<input id="page-field">', { url: 'https://page.test', runScripts: 'outside-only' });
        const originalSettings = storage.getState().settings;
        vi.stubGlobal('window', host.window);
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        vi.stubGlobal('isTauri', true);
        storage.setState({ settings: { ...originalSettings, keyboardShortcutsV2Enabled: true,
            keyboardShortcutOverridesV1: { 'browser.address.focus': [{ binding: 'Mod+Shift+Y' }] },
            keyboardShortcutDisabledCommandIdsV1: [],
        } });
        const address = host.window.document.querySelector('input')!;
        const bridge = createBridge();
        // Wry evaluation and IPC are the OS boundary; the guest reporter, engine and keyboard owner run together.
        Reflect.set(guest.window, 'ipc', { postMessage: (raw: string) => {
            const message = JSON.parse(raw) as Extract<DesktopBrowserViewEvent, { kind: 'keyboardShortcut' }>;
            bridge.subscribe.mock.calls[0]?.[1]({ kind: 'keyboardShortcut', event: message.event });
        } });
        bridge.evalScript.mockImplementation(async ({ script }) => {
            guest.window.eval(script);
            return { ok: true, availability: availableDesktopWebView };
        });
        const element = (lifecycleState: 'visible' | 'hidden') => <KeyboardShortcutProvider handlers={{
            'browser.address.focus': () => { address.focus(); },
        }}><DesktopWebViewEngine view={createExternalDesktopView()} profileId="profile_1"
            testID="native-shortcut" bridge={bridge} lifecycleState={lifecycleState} /></KeyboardShortcutProvider>;
        const press = (key: string, shiftKey = false) => {
            address.blur();
            const event = new guest.window.KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`,
                metaKey: true, shiftKey, bubbles: true, cancelable: true });
            guest.window.document.querySelector('input')!.dispatchEvent(event);
            return event.defaultPrevented;
        };
        const screen = await renderScreen(element('visible'));
        try {
            await flushHookEffects();
            expect(press('l')).toBe(false);
            expect(press('y', true)).toBe(true);
            expect(host.window.document.activeElement).toBe(address);
            await screen.update(element('hidden'));
            expect(press('y', true)).toBe(false);
            expect(host.window.document.activeElement).not.toBe(address);
        } finally {
            await screen.unmount();
            storage.setState({ settings: originalSettings });
            vi.unstubAllGlobals();
            guest.window.close();
            host.window.close();
        }
    });


    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('preserves the native capture generation across same-document URL changes', async () => {
        const bridge = createBridge();
        const view = createExternalDesktopView();
        bridge.readPageInfo.mockResolvedValue({ ok: true, availability: availableDesktopWebView, pageInfo: {
            browserSessionId: view.browserSessionId, viewId: view.viewId, requestedUrl: view.currentUrl!, currentUrl: view.currentUrl!,
            loadingState: 'finished', canGoBack: false, canGoForward: false,
        } });
        let state = { ...createBrowserControlState(), viewsById: { [view.viewId]: view } };
        const onLifecycle = (signal: BrowserViewLifecycleSignal) => {
            const event = browserViewLifecycleEvent(view, signal);
            if (event) state = applyBrowserControlEvent(state, event);
        };
        const screen = await renderScreen(<DesktopWebViewEngine view={view} profileId="profile-1" testID="native-generation"
            bridge={bridge} onLifecycle={onLifecycle} />);
        await flushHookEffects();
        const nativeFacts = { currentUrl: 'https://example.com/same-document' };
        bridge.emitNativeEvent('pageInfoChanged', nativeFacts, false, 0);
        await flushHookEffects();
        expect(state.viewsById[view.viewId].currentUrl).toBe(nativeFacts.currentUrl);
        expect(state.viewsById[view.viewId].navigationGeneration).toBe(0);
        await screen.unmount();
    });

    it('notifies native history for URL changes and same-URL entries without polling', () => {
        const page = new JSDOM('', { url: 'https://example.test', runScripts: 'outside-only' });
        const messages: string[] = [];
        Object.defineProperty(page.window, 'ipc', { value: { postMessage: (message: string) => messages.push(message) } });
        page.window.eval(readFileSync(new URL('../../../../../src-tauri/src/browser/history_notifications.js', import.meta.url), 'utf8'));
        page.window.history.pushState(null, '', '/next');
        page.window.history.replaceState(null, '', '/next');
        page.window.history.pushState(null, '', '/next');
        expect(messages).toEqual(['happier:history-changed', 'happier:history-changed']);
        page.window.dispatchEvent(new page.window.PopStateEvent('popstate'));
        expect(messages).toHaveLength(3);
        page.window.close();
    });

    it('resumes diagnostics on a socket created while the retained page was hidden', async () => {
        const page = new JSDOM('', { runScripts: 'outside-only' });
        const messages: string[] = [];
        class NativeSocket extends page.window.EventTarget { send() {} }
        Object.defineProperty(page.window, 'WebSocket', { value: NativeSocket, configurable: true });
        Object.defineProperty(page.window, 'ipc', { value: { postMessage: (message: string) => messages.push(message) } });
        vi.spyOn(page.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        page.window.eval(buildInjectedBrowserDiagnosticsScript({
            browserSessionId: 'session', viewId: 'view', navigationGeneration: 0, collectorId: 'collector', nonce: 'nonce',
            version: '1.0.0', desktopIpcDelivery: true, presentationActive: false,
        }));
        const socket = new page.window.WebSocket('wss://example.test');
        socket.dispatchEvent(new page.window.MessageEvent('message', { data: 'hidden' }));
        expect(messages).toHaveLength(0);
        page.window.eval('window.__happierBrowserDiagnostics.setPresentationActive(true)');
        messages.length = 0;
        socket.dispatchEvent(new page.window.MessageEvent('message', { data: 'visible' }));
        const events = messages.flatMap((raw) => JSON.parse(raw).events ?? []);
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'network.websocketSummary' })]));
        page.window.close();
    });

    it('projects title and same-document history facts without replaying the load lifecycle', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();
        const screen = await renderScreen(<DesktopWebViewEngine view={createExternalDesktopView()} profileId="profile-1"
            testID="native-facts" bridge={bridge} onLifecycle={onLifecycle} />);
        await flushHookEffects();
        onLifecycle.mockClear();
        bridge.readPageInfo.mockClear();
        bridge.emitNativeEvent('pageInfoChanged', { title: 'Renamed', canGoForward: true }, false);
        await flushHookEffects();
        expect(onLifecycle.mock.calls.map(([signal]) => signal.kind)).toEqual(['navigationStateChanged']);
        expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({ title: 'Renamed', canGoForward: true }));
        expect(bridge.readPageInfo).not.toHaveBeenCalled();
        await screen.unmount();
        onLifecycle.mockClear();
        bridge.emitNativeEvent('pageInfoChanged');
        expect(onLifecycle).not.toHaveBeenCalled();
    });

    it.each(['visible', 'hidden', 'parked'] as const)('does no bridge reads or publications during a settled %s minute', async (lifecycleState) => {
        vi.useFakeTimers();
        try {
            const bridge = createBridge();
            const onLifecycle = vi.fn();
            const onEvents = vi.fn();
            const diagnostics = { browserSessionId: 'browser_session_1', viewId: 'view_external_1', navigationGeneration: 0,
                collectorId: 'collector-1', nonce: 'nonce-1', collectorVersion: '1.0.0', onEvents };
            const screen = await renderScreen(<DesktopWebViewEngine view={createExternalDesktopView()} profileId="profile-1"
                testID="native-idle" bridge={bridge} lifecycleState={lifecycleState} diagnostics={diagnostics} onLifecycle={onLifecycle} />);
            await flushHookEffects();
            bridge.readPageInfo.mockClear();
            bridge.drainDiagnostics.mockClear();
            onLifecycle.mockClear();
            onEvents.mockClear();
            await flushHookEffects({ cycles: 1, turns: 3, advanceTimersMs: 60_000 });
            expect(bridge.readPageInfo).toHaveBeenCalledTimes(0);
            expect(bridge.drainDiagnostics).toHaveBeenCalledTimes(0);
            expect(onLifecycle).toHaveBeenCalledTimes(0);
            expect(onEvents).toHaveBeenCalledTimes(0);
            await screen.unmount();
        } finally { vi.useRealTimers(); }
    });

    it.each([
        { label: 'direct Session preview', url: 'http://127.0.0.1:48128/app', serviceTarget: undefined },
        { label: 'relay external-plugin Service', url: 'https://preview.example.test/app?previewToken=fresh-admission', serviceTarget: {
            kind: 'managed_service', managedServiceId: 'external-service-1', machineId: 'machine-1', cwd: '/workspace/external-service',
            declaration: { workspaceRefId: 'workspace-1', selection: { kind: 'native', source: {
                kind: 'pluginNative', adapter: { pluginId: 'external.preview.fixture', localId: 'services' }, file: 'external-services.json', target: 'web',
            } } },
        } },
    ] as const)('opens and releases a local preview through its selected native child view: $label', async ({ url, serviceTarget }) => {
        const [{ LocalPreviewTarget }, { createBrowserViewState, openBrowserTarget, resolveBrowserViewIdForTarget }, { BrowserLocalServicePreviewTargetV1Schema }] = await Promise.all([
            import('../../adapters/LocalPreviewTarget.web'),
            import('@/sync/domains/browser/store'),
            import('@happier-dev/protocol'),
        ]);
        const bridge = createBridge();
        const target = BrowserLocalServicePreviewTargetV1Schema.parse({
            kind: 'localServicePreview', targetId: 'preview-1', machineId: 'machine-1', ...(serviceTarget ? { serviceTarget } : {}),
        });
        const state = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'desktop', desktopWebViewAvailability: availableDesktopWebView,
        });
        const view = state.viewsById[resolveBrowserViewIdForTarget(target)];
        bridge.readPageInfo.mockResolvedValue({
            ok: true, availability: availableDesktopWebView,
            pageInfo: {
                browserSessionId: view.browserSessionId, viewId: view.viewId,
                requestedUrl: url, currentUrl: url, title: 'Preview document', loadingState: 'finished',
                canGoBack: true, canGoForward: false,
            },
        });
        const onLifecycle = vi.fn();
        const screen = await renderScreen(<LocalPreviewTarget
            title="Preview" url={url} testID="preview"
            view={view} profileId="profile-1" bridge={bridge} onLifecycle={onLifecycle}
        />);
        await flushHookEffects();
        expect(bridge.openView).toHaveBeenCalledWith(expect.objectContaining({ url }));
        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'navigationStateChanged', title: 'Preview document', canGoBack: true, canGoForward: false,
        }));
        await screen.unmount();
        expect(bridge.closeView).toHaveBeenCalledWith(expect.objectContaining({ viewId: view.viewId }));
    });

    it('does not reload a native-observed page when its navigation state is projected back to the engine', async () => {
        const bridge = createBridge();
        const view = createExternalDesktopView();
        const observedUrl = 'https://example.com/followed-link';
        bridge.readPageInfo.mockResolvedValue({
            ok: true, availability: availableDesktopWebView,
            pageInfo: {
                browserSessionId: view.browserSessionId, viewId: view.viewId,
                requestedUrl: view.currentUrl!, currentUrl: observedUrl, title: 'Followed link', loadingState: 'finished',
                canGoBack: true, canGoForward: true,
            },
        });
        const onLifecycle = vi.fn();
        const screen = await renderScreen(<DesktopWebViewEngine
            view={view} profileId="profile-1" bridge={bridge} testID="native-page"
            onLifecycle={onLifecycle}
        />);
        await flushHookEffects();
        expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'navigationStateChanged', url: observedUrl }));
        await screen.update(<DesktopWebViewEngine
            view={{ ...view, currentUrl: observedUrl }} profileId="profile-1" bridge={bridge} testID="native-page"
            onLifecycle={onLifecycle}
        />);
        await flushHookEffects();
        // Re-loading this already committed URL would discard native Forward history.
        expect(bridge.navigateView).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('executes agent commands through its retained owner while presentation collection is paused in a settled hidden view', async () => {
        // The native WebView is the boundary: execute its actual init/command scripts in a DOM,
        // and buffer window.ipc messages exactly as the Wry host does.
        const page = new JSDOM('<button id="go">Go</button>', { url: 'https://example.com/', runScripts: 'outside-only' });
        // JSDOM has no native canvas renderer; report that platform capability as unavailable.
        vi.spyOn(page.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const messages: string[] = [];
        Object.defineProperty(page.window, 'ipc', { value: { postMessage: (raw: string) => messages.push(raw) } });
        let clicks = 0;
        page.window.document.querySelector('#go')?.addEventListener('click', () => { clicks += 1; });
        const bridge = createBridge();
        const commandResult = { ok: true, availability: availableDesktopWebView } satisfies DesktopBrowserCommandResult;
        bridge.openView.mockImplementation(async (request) => {
            if (request.diagnosticsInitScript) page.window.eval(request.diagnosticsInitScript);
            return commandResult;
        });
        bridge.evalScript.mockImplementation(async (request) => {
            page.window.eval(request.script);
            return commandResult;
        });
        bridge.drainDiagnostics.mockImplementation(async () => ({ ok: true, availability: availableDesktopWebView, messages: messages.splice(0) }));
        const identity = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collectorId: 'desktop_collector_1',
            nonce: 'desktop_nonce_1',
        };
        const controlService = createBrowserAutomationControlService({ nowMs: Date.now });
        const automation = {
            ...identity,
            capabilityVersion: '1.0.0',
            adapterKind: 'externalUrl',
            supportedActions: ['click'],
            controlService,
        };
        const diagnostics = { ...identity, collectorVersion: '1.0.0', onEvents: vi.fn() };
        const screen = await renderScreen(<DesktopWebViewEngine
            view={createExternalDesktopView()}
            profileId="profile_external_1"
            testID="desktop-webview"
            diagnostics={diagnostics}
            automation={automation}
            bridge={bridge}
        />);
        await flushHookEffects({ cycles: 3, turns: 3 });
        const request = {
            v: 1,
            automationRequestId: 'agent_click',
            browserSessionId: identity.browserSessionId,
            viewId: identity.viewId,
            navigationGeneration: 0,
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            actionKind: 'click',
            timeoutMs: 1_000,
            payload: { locator: { kind: 'css', value: '#go' } },
        } as const;
        try {
            const result = await controlService.executeAction(request);
            expect(result.status).toBe('succeeded');
            await screen.update(<DesktopWebViewEngine
                view={createExternalDesktopView()} profileId="profile_external_1" testID="desktop-webview"
                diagnostics={diagnostics} automation={automation} bridge={bridge} lifecycleState="hidden"
            />);
            await flushHookEffects();
            diagnostics.onEvents.mockClear();
            page.window.console.info('presentation-only hidden diagnostic');
            bridge.emitNativeEvent('diagnosticsAvailable');
            await flushHookEffects();
            expect(diagnostics.onEvents).toHaveBeenCalledTimes(0);
            const hiddenResult = await controlService.executeAction({ ...request, automationRequestId: 'hidden-agent-click' });
            expect(hiddenResult.status).toBe('succeeded');
            expect(diagnostics.onEvents).toHaveBeenCalledTimes(0);
            expect(clicks).toBe(2);
            const missing = await controlService.executeAction({
                ...request,
                automationRequestId: 'agent_missing',
                payload: { locator: { kind: 'css', value: '#missing' } },
            });
            expect(missing).toMatchObject({ status: 'failed', errorCode: 'selector_not_found' });

            // The native evaluator may still be running while title/history state rerenders the host.
            // Equivalent config objects do not replace that physical page or cancel its real owner.
            const evaluationGate = createDeferred<void>();
            bridge.evalScript.mockImplementation(async (input) => {
                await evaluationGate.promise;
                page.window.eval(input.script);
                return commandResult;
            });
            const pending = controlService.executeAction({ ...request, automationRequestId: 'agent_pending' });
            await flushHookEffects({ cycles: 1, turns: 2 });
            await screen.update(<DesktopWebViewEngine
                view={createExternalDesktopView({ title: 'Updated title' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={{ ...diagnostics }}
                automation={{ ...automation, supportedActions: [...automation.supportedActions] }}
                bridge={bridge}
            />);
            evaluationGate.resolve(undefined);
            expect(await pending).toMatchObject({ status: 'succeeded' });
            expect(clicks).toBe(3);
            await screen.unmount();
            expect(await controlService.executeAction({ ...request, automationRequestId: 'agent_after_unmount' }))
                .toMatchObject({ status: 'canceled', errorCode: 'owner_disconnected' });
        } finally {
            await screen.unmount();
            page.window.close();
        }
    });

    it('opens, bounds, navigates, omits the occluded in-frame devtools button, emits page-info diagnostics, and closes the native view', async () => {
        const bridge = createBridge();
        const onDiagnosticsEvents = vi.fn();
        const diagnostics = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collectorId: 'desktop_collector_1',
            nonce: 'desktop_nonce_1',
            collectorVersion: '1.0.0',
            onEvents: onDiagnosticsEvents,
        };

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnostics}
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // With a diagnostics bridge, the canonical collector is injected as the Wry document-start
        // init script (full in-page console/network/resource devtools over the `window.ipc` channel).
        expect(bridge.openView).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            profileId: 'profile_external_1',
            url: 'https://example.com/',
            diagnosticsInitScript: expect.stringContaining('desktop_collector_1'),
        }));
        expect(bridge.drainDiagnostics).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
        });
        expect(onDiagnosticsEvents).toHaveBeenCalledWith([
            expect.objectContaining({
                eventId: 'desktop_collector_1:0:desktopPageInfo:1',
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                fidelity: 'nativeCallback',
                trusted: true,
                capturedAtMs: 5_000,
                data: {
                    url: 'https://example.com/dashboard',
                    loading: false,
                    title: 'Example dashboard',
                },
            }),
        ]);

        // Bounds now flow through `useDesktopWebViewSurfaceSync` (rAF + occlusion + stable-frame
        // early-out), exercised directly in useDesktopWebViewSurfaceSync.test.tsx. `onLayout` is a
        // sync-request trigger here, not a one-shot bounds push.
        expect(screen.findByTestId('desktop-webview')?.props.onLayout).toBeTypeOf('function');

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({
                    pendingUrl: 'https://example.com/docs',
                    loadingState: 'loading',
                    navigationGeneration: 1,
                })}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/docs',
        });

        // A5a (F1-ui): the engine no longer renders an in-frame devtools button (it was permanently
        // occluded by the native Wry child view). Devtools is owned solely by the BrowserShell toolbar.
        expect(screen.findByTestId('desktop-webview-open-devtools')).toBeNull();

        await screen.unmount();
        expect(bridge.closeView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
        });
    });

    it('engages pointer passthrough while a host drag signal is active', async () => {
        const bridge = createBridge();
        let dragActive = false;
        const dragListeners = new Set<() => void>();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                dragSignal={{
                    isActive: () => dragActive,
                    subscribe: (cb) => {
                        dragListeners.add(cb);
                        return () => dragListeners.delete(cb);
                    },
                }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        vi.mocked(bridge.setPointerPassthrough).mockClear();

        await act(async () => {
            dragActive = true;
            dragListeners.forEach((cb) => cb());
            await Promise.resolve();
        });

        expect(bridge.setPointerPassthrough).toHaveBeenLastCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            ignore: true,
        });

        await screen.unmount();
    });

    it('does not close the native view on a hide-only lifecycle transition (keep-mounted)', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                lifecycleState="visible"
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                lifecycleState="hidden"
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.closeView).not.toHaveBeenCalled();

        // A genuine unmount while hide-latched is the tab/split-canvas owner's teardown, not the
        // engine's — so the engine still does not close here.
        await screen.unmount();
        expect(bridge.closeView).not.toHaveBeenCalled();
    });

    it('keeps the native view mounted when page-info diagnostics are unavailable after open succeeds', async () => {
        const bridge = createBridge();
        vi.mocked(bridge.readPageInfo).mockResolvedValue({
            ok: false,
            availability: {
                ...availableDesktopWebView,
                supports: {
                    ...availableDesktopWebView.supports,
                    pageInfoDiagnostics: false,
                },
                disabledReasons: ['desktop_webview_native_command_unavailable'],
            },
        } satisfies DesktopBrowserPageInfoResult);
        const onDiagnosticsEvents = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={{
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    navigationGeneration: 0,
                    collectorId: 'desktop_collector_1',
                    nonce: 'desktop_nonce_1',
                    collectorVersion: '1.0.0',
                    onEvents: onDiagnosticsEvents,
                }}
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(screen.findByTestId('desktop-webview')).not.toBeNull();
        expect(screen.findByTestId('desktop-webview-unavailable')).toBeNull();
        expect(onDiagnosticsEvents).not.toHaveBeenCalled();
    });

    it('injects location.reload() into the native view for a reload navigation command', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        vi.mocked(bridge.dispatchNavigation).mockClear();

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                navigationCommand={{ commandId: 'cmd_reload_1', kind: 'reload' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'reload',
            script: 'location.reload()',
        });
    });

    it('injects window.stop() into the native view for a stop navigation command', async () => {
        const bridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                navigationCommand={{ commandId: 'cmd_stop_1', kind: 'stop' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'stop',
            script: 'window.stop()',
        });
    });

    it('renders a recoverable crash surface and reloads the last URL when the render process crashes', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();
        const crashedPageInfo = {
            ok: true,
            availability: availableDesktopWebView,
            pageInfo: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_external_1',
                requestedUrl: 'https://example.com/',
                currentUrl: 'https://example.com/',
                title: 'Example',
                loadingState: 'crashed',
                canGoBack: false,
                canGoForward: false,
            },
        } satisfies DesktopBrowserPageInfoResult;
        // First read after open reports a crash; subsequent reads (after reload) report finished.
        vi.mocked(bridge.readPageInfo)
            .mockResolvedValueOnce(crashedPageInfo)
            .mockResolvedValue({
                ok: true,
                availability: availableDesktopWebView,
                pageInfo: {
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    requestedUrl: 'https://example.com/',
                    currentUrl: 'https://example.com/',
                    title: 'Example',
                    loadingState: 'finished',
                    canGoBack: false,
                    canGoForward: false,
                },
            } satisfies DesktopBrowserPageInfoResult);

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                onLifecycle={onLifecycle}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // A crashed render process surfaces a recoverable frame with a Reload affordance — not a
        // frozen page and not the generic unavailable frame.
        expect(screen.findByTestId('desktop-webview-crashed')).not.toBeNull();
        // A native crash must remain failed in the reducer, not be revived by a ready navigation snapshot.
        expect(onLifecycle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'loadFailed' }));
        expect(onLifecycle).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'navigationStateChanged' }));
        const reload = screen.findByTestId('desktop-webview-crashed-action');
        expect(reload).not.toBeNull();

        vi.mocked(bridge.navigateView).mockClear();
        await screen.pressByTestIdAsync('desktop-webview-crashed-action');
        await flushHookEffects({ cycles: 2, turns: 2 });

        // Reload re-issues navigation to the last good URL and clears the crashed surface.
        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/',
        });
        expect(screen.findByTestId('desktop-webview-crashed')).toBeNull();
        expect(screen.findByTestId('desktop-webview')).not.toBeNull();
    });

    it('B-2 cause-2: feeds native page-info load lifecycle back to the control reducer via onLifecycle', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                onLifecycle={onLifecycle}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The bridge reports a finished load; publishPageInfo maps it to a loadFinished lifecycle
        // signal so the reducer can leave `loading` — independent of any diagnostics bridge being
        // attached. Unlike the diagnostics event (which is redacted for telemetry egress), the
        // lifecycle carries the REAL current URL so the view's address/navigation stay accurate.
        expect(onLifecycle).toHaveBeenCalledWith({
            kind: 'loadFinished',
            url: 'https://example.com/dashboard?token=secret#panel',
        });
        expect(onLifecycle).toHaveBeenCalledWith({
            kind: 'navigationStateChanged',
            navigationGeneration: 0,
            url: 'https://example.com/dashboard?token=secret#panel',
            title: 'Example dashboard',
            loading: false,
            canGoBack: true,
            canGoForward: false,
        });

        await screen.unmount();
    });

    it('B-2 cause-2: reports a load failure to the reducer when a native navigate command fails', async () => {
        const bridge = createBridge();
        const onLifecycle = vi.fn();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                onLifecycle={onLifecycle}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        onLifecycle.mockClear();
        vi.mocked(bridge.navigateView).mockResolvedValue({
            ok: false,
            availability: {
                ...availableDesktopWebView,
                disabledReasons: ['desktop_webview_native_command_unavailable'],
            },
        });

        // A same-viewKey in-place URL set drives navigateView; its failure is a load failure for the
        // reducer (harden §15 Δ2 — the in-place URL set is dispatched, not swallowed).
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({
                    pendingUrl: 'https://example.com/docs',
                    loadingState: 'loading',
                    navigationGeneration: 1,
                })}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                onLifecycle={onLifecycle}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.navigateView).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            url: 'https://example.com/docs',
        });
        expect(onLifecycle).toHaveBeenCalledWith({
            kind: 'loadFailed',
            errorCode: 'desktop_webview_native_command_unavailable',
        });

        await screen.unmount();
    });

    it('settles native lifecycle from changed producer facts even without diagnostics', async () => {
        vi.useFakeTimers();
        try {
            const bridge = createBridge();
            // Initial read still loading; the producer subsequently reports the finished load.
            vi.mocked(bridge.readPageInfo).mockResolvedValueOnce({
                ok: true,
                availability: availableDesktopWebView,
                pageInfo: {
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_external_1',
                    requestedUrl: 'https://example.com/',
                    currentUrl: 'https://example.com/',
                    title: 'Example',
                    loadingState: 'loading',
                    canGoBack: false,
                    canGoForward: false,
                },
            } satisfies DesktopBrowserPageInfoResult);
            const onLifecycle = vi.fn();

            const screen = await renderScreen(
                <DesktopWebViewEngine
                    view={createExternalDesktopView({ loadingState: 'loading' })}
                    profileId="profile_external_1"
                    testID="desktop-webview"
                    bridge={bridge}
                    // No `diagnostics` prop: this is the diagnostics-unavailable desktop case.
                    onLifecycle={onLifecycle}
                    nowMs={() => 5_000}
                />,
            );
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(onLifecycle).toHaveBeenCalledWith({ kind: 'loadStarted', url: 'https://example.com/' });
            onLifecycle.mockClear();

            bridge.emitNativeEvent('pageInfoChanged');
            await flushHookEffects();
            expect(bridge.readPageInfo).toHaveBeenCalledTimes(1);
            expect(onLifecycle).toHaveBeenCalledWith({
                kind: 'loadFinished',
                url: 'https://example.com/dashboard?token=secret#panel',
            });

            await screen.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('evals the canonical eval command script into the page when the diagnostics bridge sets an eval request', async () => {
        const bridge = createBridge();
        const diagnostics = {
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collectorId: 'desktop_collector_1',
            nonce: 'desktop_nonce_1',
            collectorVersion: '1.0.0',
            onEvents: vi.fn(),
            evalRequest: {
                v: 1,
                evalRequestId: 'eval_req_1',
                viewId: 'view_external_1',
                navigationGeneration: 0,
                tier: 'injectedPage',
                expression: 'document.title',
                timeoutMs: 2_000,
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            },
        } as const;

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnostics}
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The interactive eval REPL pushes the canonical command script through the host eval command
        // (bound to the injected collector); its result returns over the ipc/drain channel.
        expect(bridge.evalScript).toHaveBeenCalledWith(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            script: expect.stringContaining('desktop_collector_1'),
        }));

        await screen.unmount();
    });

    it('dispatches Back and Forward through native history rather than injecting guessed history', async () => {
        const bridge = createBridge();
        const props = { view: createExternalDesktopView(), profileId: 'profile_external_1', testID: 'desktop-webview', bridge };
        const screen = await renderScreen(<DesktopWebViewEngine {...props} navigationCommand={{ commandId: 'back_1', kind: 'goBack' }} />);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({ browserSessionId: 'browser_session_1', viewId: 'view_external_1', kind: 'goBack' });
        await screen.update(<DesktopWebViewEngine {...props} navigationCommand={{ commandId: 'forward_1', kind: 'goForward' }} />);
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(bridge.dispatchNavigation).toHaveBeenCalledWith({ browserSessionId: 'browser_session_1', viewId: 'view_external_1', kind: 'goForward' });
        await screen.unmount();
    });

    it('does not re-inject the same navigation command on unrelated re-renders', async () => {
        const bridge = createBridge();
        const command = { commandId: 'cmd_reload_stable', kind: 'reload' } as const;

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                navigationCommand={command}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(bridge.dispatchNavigation).toHaveBeenCalledTimes(1);

        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={bridge}
                navigationCommand={command}
                nowMs={() => 6_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(bridge.dispatchNavigation).toHaveBeenCalledTimes(1);
    });

    it('A5b: dispatches a navigation command through the LATEST bridge after the bridge prop changes', async () => {
        const firstBridge = createBridge();
        const secondBridge = createBridge();

        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={firstBridge}
                navigationCommand={{ commandId: 'cmd_1', kind: 'reload' }}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(firstBridge.dispatchNavigation).toHaveBeenCalledTimes(1);

        // The bridge instance changes, then a NEW command id fires. The ref-based callback must read
        // the live bridge — the latest instance — not a render-time captured closure.
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView()}
                profileId="profile_external_1"
                testID="desktop-webview"
                bridge={secondBridge}
                navigationCommand={{ commandId: 'cmd_2', kind: 'stop' }}
                nowMs={() => 6_000}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(secondBridge.dispatchNavigation).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            kind: 'stop',
            script: 'window.stop()',
        });
        // The first bridge was only used for the first command, never the post-swap one.
        expect(firstBridge.dispatchNavigation).toHaveBeenCalledTimes(1);
    });

    it('A5c: keeps early post-navigation events tagged with the prior collector generation (N-1)', async () => {
        const bridge = createBridge();
        const onEvents = vi.fn();
        const diagnosticsForGeneration = (navigationGeneration: number, collectorId: string) => ({
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration,
            collectorId,
            nonce: `nonce_${collectorId}`,
            collectorVersion: '1.0.0',
            onEvents,
        });
        const priorGenerationBatch = JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.events',
            browserSessionId: 'browser_session_1',
            viewId: 'view_external_1',
            navigationGeneration: 0,
            collector: { collectorId: 'collector_gen0', nonce: 'nonce_collector_gen0', version: '1.0.0' },
            events: [{
                v: 1,
                eventId: 'evt_prior_gen_1',
                browserSessionId: 'browser_session_1',
                viewId: 'view_external_1',
                navigationGeneration: 0,
                capturedAtMs: 2_000,
                family: 'console',
                kind: 'console.entry',
                fidelity: 'injectedPage',
                trusted: false,
                collector: { collectorId: 'collector_gen0', nonce: 'nonce_collector_gen0', version: '1.0.0' },
                data: { level: 'log', textPreview: 'early-post-nav' },
                redaction: { level: 'metadataOnly' },
            }],
        });

        // Open at generation 0 (collector_gen0).
        const screen = await renderScreen(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/a', pendingUrl: 'https://example.com/a' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(0, 'collector_gen0')}
                bridge={bridge}
                nowMs={() => 5_000}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // A navigation rotates the collector identity to generation 1 (collector_gen1); the prior
        // generation (collector_gen0) is remembered.
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/a', pendingUrl: 'https://example.com/a' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(1, 'collector_gen1')}
                bridge={bridge}
                nowMs={() => 5_001}
            />,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        onEvents.mockClear();

        // Now an early post-navigation drain delivers an event still tagged with the prior collector.
        vi.mocked(bridge.drainDiagnostics).mockResolvedValueOnce({
            ok: true,
            availability: availableDesktopWebView,
            messages: [priorGenerationBatch],
        });

        // Trigger a drain via an in-place navigation (the navigate effect drains after it resolves).
        await screen.update(
            <DesktopWebViewEngine
                view={createExternalDesktopView({ currentUrl: 'https://example.com/b', pendingUrl: 'https://example.com/b' })}
                profileId="profile_external_1"
                testID="desktop-webview"
                diagnostics={diagnosticsForGeneration(1, 'collector_gen1')}
                bridge={bridge}
                nowMs={() => 5_002}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 3 });

        // The prior-generation event was accepted, not dropped as collector_mismatch/navigation_stale.
        // (The parser re-derives a sanitized eventId, so match on the stable family/preview instead.)
        expect(onEvents).toHaveBeenCalled();
        const deliveredEvents = onEvents.mock.calls.flatMap(([events]) => events as Array<{
            family: string;
            navigationGeneration: number;
            data?: { textPreview?: string };
        }>);
        // The prior-generation (N-1) console event was delivered rather than dropped — it carries the
        // prior navigationGeneration (0), proving the drain accepted the immediately-prior collector.
        const priorGenConsoleEvent = deliveredEvents.find((event) => event.family === 'console');
        expect(priorGenConsoleEvent).toBeDefined();
        expect(priorGenConsoleEvent?.navigationGeneration).toBe(0);
    });
});
