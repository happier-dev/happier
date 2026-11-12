import * as React from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import type { BrowserAutomationEngineBridgeConfig } from '../frame/types';
import { BrowserViewHost } from '../BrowserViewHost';
import { LOCAL_BROWSER_PROFILE } from '@/sync/domains/browser/profiles/localBrowserProfile';

import { ExternalUrlTarget as NativeExternalUrlTarget } from './ExternalUrlTarget.native';
import { ExternalUrlTarget as WebExternalUrlTarget } from './ExternalUrlTarget.web';

const nativePages = new Map<string, JSDOM>();
let nativeReplyGate: Promise<void> | null = null;
const desktopInvoke = vi.hoisted(() => vi.fn());
const desktopEventListeners = vi.hoisted(() => new Set<(payload: unknown) => void>());
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => true,
    invokeDesktopHost: desktopInvoke,
    // Native events are the other half of this OS boundary. The real bridge
    // subscribes before opening and drains collector replies on IPC arrival.
    listenDesktopHostEvent: async (_event: string, listener: (payload: unknown) => void) => {
        desktopEventListeners.add(listener);
        return () => { desktopEventListeners.delete(listener); };
    },
}));

// The SDK/OS boundary runs the actual injected collector and command scripts in the visible guest.
vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: Readonly<Record<string, unknown>>, ref: React.ForwardedRef<unknown>) => {
        const currentProps = React.useRef(props);
        currentProps.current = props;
        const page = React.useMemo(() => {
            const source = props.source as { uri: string };
            const guest = new JSDOM('<button id="go">Go</button><output>Idle</output>', { url: source.uri, runScripts: 'outside-only' });
            vi.spyOn(guest.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
            guest.window.document.querySelector('#go')?.addEventListener('click', () => {
                guest.window.document.querySelector('output')!.textContent = 'Clicked';
            });
            Object.defineProperty(guest.window, 'ReactNativeWebView', { value: {
                postMessage: (data: string) => queueMicrotask(async () => {
                    if (nativeReplyGate) await nativeReplyGate;
                    const onMessage = currentProps.current.onMessage as (event: unknown) => void;
                    onMessage({ nativeEvent: { data, url: source.uri } });
                }),
            } });
            nativePages.set(String(props.testID), guest);
            return guest;
        }, []);
        React.useImperativeHandle(ref, () => ({ injectJavaScript: (script: string) => page.window.eval(script) }), [page]);
        React.useLayoutEffect(() => {
            if (typeof props.injectedJavaScript === 'string') page.window.eval(props.injectedJavaScript);
        }, [page, props.injectedJavaScript]);
        return React.createElement('WebView', props);
    }),
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));

const identity = { browserSessionId: 'browser_session_external', viewId: 'view_external', navigationGeneration: 0, collectorId: 'external_collector', nonce: 'external_nonce' };
const availability = {
    available: true, platform: 'macos', primitive: 'macosNsViewWebKit', renderEngine: 'desktopWebView', producer: 'tauriWryNativeChildView', privilegedIpc: false,
    supports: { navigation: true, goBackForward: true, reload: true, stop: true, pageInfoDiagnostics: true, nativeDevtools: true, capture: false, recording: false, automation: true },
    disabledReasons: [],
} as const;

function createView(engineKind: 'nativeWebView' | 'desktopWebView' | 'webIframe'): BrowserControlViewState {
    return {
        browserSessionId: identity.browserSessionId, viewId: identity.viewId,
        target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.com/', display: { title: 'Example' } },
        platform: engineKind === 'nativeWebView' ? 'ios' : engineKind === 'desktopWebView' ? 'desktop' : 'web',
        adapterKind: 'externalUrl', engineKind,
        adapterCapabilities: buildBrowserAdapterCapabilities({ adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: [engineKind],
            ...(engineKind === 'desktopWebView' ? { desktopWebViewSupport: availability.supports } : {}) }),
        currentUrl: 'https://example.com/', currentUrlExpiresAt: null, pendingUrl: null, title: 'Example', faviconUrl: null,
        loadingState: 'ready', loadingProgress: 1, navigationGeneration: 0, canGoBack: false, canGoForward: false,
        securityOrigin: 'https://example.com', lastError: null, openerViewId: null, adapterRefreshStatus: 'idle', adapterRefreshError: null,
    };
}

function createAutomation(): BrowserAutomationEngineBridgeConfig {
    return { ...identity, capabilityVersion: '1.0.0', adapterKind: 'externalUrl', supportedActions: ['click'], controlService: createBrowserAutomationControlService({ nowMs: Date.now }) };
}
const diagnostics = { ...identity, collectorVersion: '1.0.0', onEvents: () => undefined };
const request = {
    v: 1, browserSessionId: identity.browserSessionId, viewId: identity.viewId, navigationGeneration: 0,
    automationRequestId: 'click_external', requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' },
    actionKind: 'click', timeoutMs: 1_000, payload: { locator: { kind: 'css', value: '#go' } },
} as const;

describe('ExternalUrlTarget automation composition', () => {
    beforeEach(() => { vi.stubGlobal('window', new EventTarget()); desktopInvoke.mockReset(); desktopEventListeners.clear(); nativeReplyGate = null; });
    afterEach(() => {
        for (const page of nativePages.values()) page.window.close();
        nativePages.clear();
        vi.unstubAllGlobals();
    });

    it('executes through the mobile target in the visible native guest and retires its owner on unmount', async () => {
        const automation = createAutomation();
        const screen = await renderScreen(<NativeExternalUrlTarget testID="external-native" view={createView('nativeWebView')} diagnostics={diagnostics} automation={automation} />);
        const page = nativePages.get('external-native')!;
        expect(screen.findHostByTestId('external-native')?.props.source).toEqual({ uri: page.window.location.href });
        try {
            expect(await automation.controlService.executeAction(request)).toMatchObject({ status: 'succeeded' });
            expect(page.window.document.querySelector('output')?.textContent).toBe('Clicked');
            let releaseReply!: () => void;
            nativeReplyGate = new Promise(resolve => { releaseReply = resolve; });
            const pending = automation.controlService.executeAction({ ...request, automationRequestId: 'pending_mobile' });
            await flushHookEffects({ cycles: 1, turns: 2 });
            await screen.update(<NativeExternalUrlTarget testID="external-native" view={{ ...createView('nativeWebView'), title: 'Updated title', canGoBack: true }}
                diagnostics={{ ...diagnostics }} automation={{ ...automation, supportedActions: [...automation.supportedActions] }} />);
            nativeReplyGate = null;
            releaseReply();
            expect(await pending).toMatchObject({ status: 'succeeded' });
            await screen.unmount();
            page.window.document.querySelector('output')!.textContent = 'Retired';
            expect((await automation.controlService.executeAction({ ...request, automationRequestId: 'retired_click' })).status).not.toBe('succeeded');
            expect(page.window.document.querySelector('output')?.textContent).toBe('Retired');
        } finally { await screen.unmount(); }
    });

    it('executes through the host-selected desktop target in its native child guest and retires its owner on unmount', async () => {
        const page = new JSDOM('<button id="go">Go</button><output>Idle</output>', { url: 'https://example.com/', runScripts: 'outside-only' });
        vi.spyOn(page.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
        const messages: string[] = [];
        Object.defineProperty(page.window, 'ipc', { value: { postMessage: (raw: string) => {
            messages.push(raw);
            queueMicrotask(() => {
                for (const listener of desktopEventListeners) listener({
                    browserSessionId: identity.browserSessionId, viewId: identity.viewId, kind: 'diagnosticsAvailable',
                });
            });
        } } });
        page.window.document.querySelector('#go')?.addEventListener('click', () => { page.window.document.querySelector('output')!.textContent = 'Clicked'; });
        const success = { ok: true, availability } as const;
        desktopInvoke.mockImplementation(async (command: string, payload?: { request?: { diagnosticsInitScript?: string; script?: string } }) => {
            const input = payload?.request;
            if (command === 'desktop_browser_open_view' && input?.diagnosticsInitScript) page.window.eval(input.diagnosticsInitScript);
            if (command === 'desktop_browser_eval_script' && input?.script) page.window.eval(input.script);
            if (command === 'desktop_browser_get_page_info') return { ...success, pageInfo: {
                browserSessionId: identity.browserSessionId, viewId: identity.viewId, requestedUrl: page.window.location.href,
                currentUrl: page.window.location.href, title: 'Example', loadingState: 'finished', canGoBack: false, canGoForward: false,
            } };
            if (command === 'desktop_browser_drain_diagnostics') return { ...success, messages: messages.splice(0) };
            return success;
        });
        const automation = createAutomation();
        const screen = await renderScreen(<BrowserViewHost testID="external-desktop" view={createView('desktopWebView')}
            browserProfile={LOCAL_BROWSER_PROFILE} diagnosticsBridge={diagnostics} browserAutomation={{ controlService: automation.controlService }} />);
        await flushHookEffects({ cycles: 3, turns: 3 });
        try {
            expect(screen.findHostByTestId('external-desktop-frame')).toBeTruthy();
            expect(await automation.controlService.executeAction(request)).toMatchObject({ status: 'succeeded' });
            expect(page.window.document.querySelector('output')?.textContent).toBe('Clicked');
            await screen.unmount();
            expect(desktopEventListeners.size).toBe(0);
            page.window.document.querySelector('output')!.textContent = 'Retired';
            expect((await automation.controlService.executeAction({ ...request, automationRequestId: 'retired_click' })).status).not.toBe('succeeded');
            expect(page.window.document.querySelector('output')?.textContent).toBe('Retired');
        } finally { await screen.unmount(); page.window.close(); }
    });

    it('reports the real opaque external iframe limitation without admitting an automation owner', async () => {
        const automation = createAutomation();
        const rejected: string[] = [];
        const screen = await renderScreen(<WebExternalUrlTarget testID="external-web" view={createView('webIframe')}
            diagnostics={{ ...diagnostics, sourceOrigin: 'https://example.com', webPostMessageTargetOrigin: 'https://app.example.test' }}
            automation={{ ...automation, sourceOrigin: 'https://example.com', onRegistrationRejected: (reason) => rejected.push(reason) }} />,
            { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: { postMessage() {}, document: new EventTarget() } } : null });
        try {
            await act(async () => screen.findByType('iframe').props.onLoad());
            expect(rejected).toEqual(['cross_origin_frame_unavailable']);
            expect((await automation.controlService.executeAction(request)).status).not.toBe('timed_out');
            expect((await automation.controlService.executeAction({ ...request, automationRequestId: 'unreachable_click' })).status).not.toBe('succeeded');
        } finally { await screen.unmount(); }
    });
});
