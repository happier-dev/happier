import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { BrowserViewHost } from './BrowserViewHost';
import type { BrowserDiagnosticsEngineBridgeConfig } from './frame/types';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { applyLocalServicePreviewSnapshot, createLocalServicePreviewState } from '@/sync/domains/local/services/preview/store';

const previewHttp = vi.hoisted(() => ({ fetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
    token: 'header.eyJzdWIiOiJ2aWV3ZXItYWNjb3VudCJ9.signature' }));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: Parameters<typeof previewHttp.fetch>) => previewHttp.fetch(...args) }));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: previewHttp.token }),
    } });
});

const simulatorTargetProps: Array<Readonly<Record<string, unknown>>> = [];
const desktopWebViewTargetProps: Array<Readonly<Record<string, unknown>>> = [];

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/adapters/SimulatorPreviewTarget', () => ({
    SimulatorPreviewTarget: (props: Readonly<Record<string, unknown>>) => {
        simulatorTargetProps.push(props);
        return React.createElement('View', {
            testID: props.testID ?? 'simulator-preview-target',
        });
    },
}));

vi.mock('@/components/browser/frame/engines/DesktopWebViewEngine', () => ({
    DesktopWebViewEngine: (props: Readonly<Record<string, unknown>>) => {
        desktopWebViewTargetProps.push(props);
        return React.createElement('View', {
            testID: props.testID ?? 'desktop-webview-target',
        });
    },
}));

function createHostedPluginView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: {
            kind: 'hostedPluginWeb',
            targetId: 'hosted_1',
            pluginId: 'plugin.example',
            contributionId: 'surface.main',
            display: { title: 'Plugin surface' },
        },
        platform: 'web',
        adapterKind: 'hostedPlugin',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'hostedPlugin',
            supportedTargetKinds: ['hostedPluginWeb'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'https://plugins.happier.test/plugin.example/surface.main/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Plugin surface',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://plugins.happier.test/',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createLocalPreviewView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_local_1',
        target: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Preview', addressLabel: 'localhost:5173' },
        },
        platform: 'web',
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'localPreview',
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'https://preview.happier.test/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Preview',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 3,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://preview.happier.test/',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createSimulatorView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_simulator_1',
        target: {
            kind: 'simulatorPreview',
            targetId: 'simulator_1',
            deviceId: 'device_1',
            display: { title: 'iPhone 16' },
        },
        platform: 'web',
        adapterKind: 'simulatorPreview',
        engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'simulatorPreview',
            supportedTargetKinds: ['simulatorPreview'],
            supportedRenderEngines: ['streamedSurface'],
        }),
        currentUrl: null,
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'iPhone 16',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: null,
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createSidecarView(): BrowserControlViewState {
    return {
        ...createHostedPluginView(),
        viewId: 'view_sidecar_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://example.com/',
            display: { title: 'External' },
        },
        adapterKind: 'chromiumSidecar',
        engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'chromiumSidecar',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['streamedSurface'],
        }),
        currentUrl: 'https://example.com/',
        title: 'External',
        securityOrigin: 'https://example.com',
    };
}

function createExternalDesktopView(): BrowserControlViewState {
    return {
        ...createHostedPluginView(),
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
            desktopWebViewSupport: {
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
        }),
        currentUrl: 'https://example.com/',
        title: 'Example',
        securityOrigin: 'https://example.com',
    };
}

const pluginUiProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:plugin.example:surface.main': {
            id: 'hostedWeb:plugin.example:surface.main',
            pluginId: 'plugin.example',
            occurrenceId: 'plugin-example-occurrence-1',
            contributionKind: 'hostedWeb',
            contributionId: 'surface.main',
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
            sandbox: { scripts: true, popups: true },
            security: {},
            runtime: { state: 'available' },
        },
    },
};

const pluginBrowserProfile = {
    profileId: 'profile_plugin_1',
    storageMode: 'plugin',
    owner: {
        kind: 'plugin',
        id: 'plugin.example',
        contributionId: 'surface.main',
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

function createDiagnosticsBridge(
    view: BrowserControlViewState,
    onCollectorScriptReady: (script: string) => void,
): BrowserDiagnosticsEngineBridgeConfig {
    return {
        browserSessionId: view.browserSessionId,
        viewId: view.viewId,
        navigationGeneration: view.navigationGeneration,
        collectorId: `collector:${view.viewId}`,
        nonce: `nonce:${view.viewId}`,
        collectorVersion: '1.0.0',
        sourceOrigin: view.securityOrigin ?? undefined,
        webPostMessageTargetOrigin: 'https://app.happier.test',
        onCollectorScriptReady,
        onEvents: vi.fn(),
    };
}

function readAutomationOwnerIds(snapshot: Readonly<Record<string, unknown>>): readonly string[] {
    const owners = snapshot.ownersByViewId;
    if (!owners || typeof owners !== 'object' || Array.isArray(owners)) return [];
    return Object.keys(owners);
}

function createReachableCollectorFrame(origin: string) {
    const host = new EventTarget();
    vi.stubGlobal('window', host);
    const events: Array<{ target: string; type: string; key?: string }> = [];
    const focus = vi.fn();
    const input = Object.assign(new EventTarget(), {
        tagName: 'INPUT', type: 'file', files: [] as File[], focus,
        getAttribute: (name: string) => name === 'id' ? 'source' : name === 'type' ? 'file' : null,
    });
    const destination = Object.assign(new EventTarget(), {
        tagName: 'DIV', getAttribute: (name: string) => name === 'id' ? 'destination' : null,
    });
    for (const [name, node] of [['source', input], ['destination', destination]] as const) {
        for (const type of ['keydown', 'keyup', 'mouseover', 'mousemove', 'focus', 'input', 'change', 'dragstart', 'dragend', 'dragenter', 'dragover', 'drop']) {
            node.addEventListener(type, (event) => events.push({ target: name, type, ...('key' in event ? { key: String(event.key) } : {}) }));
        }
    }
    const deliver = (target: EventTarget, data: string, source: EventTarget) => {
        const event = new Event('message');
        Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
        target.dispatchEvent(event);
    };
    // Genuine browser boundaries: script insertion, DOM events, file transfer and postMessage.
    // The actual injected collector executes and produces its own result envelopes.
    class BrowserDataTransfer {
        readonly files: File[] = [];
        readonly items = { add: (file: File) => this.files.push(file) };
    }
    class BrowserActionEvent extends Event {
        readonly key?: string;
        readonly dataTransfer?: BrowserDataTransfer;
        constructor(type: string, options: EventInit & { key?: string; dataTransfer?: BrowserDataTransfer } = {}) {
            super(type, options);
            this.key = options.key;
            this.dataTransfer = options.dataTransfer;
        }
    }
    const documentBoundary = {
        title: 'Same-origin preview', readyState: 'complete', documentElement: { nodeType: 1 },
        querySelectorAll: (selector: string) => selector === '#source' ? [input] : selector === '#destination' ? [destination] : [],
        createElement: () => ({ textContent: '', remove() {} }),
        head: { appendChild: (script: { textContent: string }) => {
            new Function('window', 'document', 'console', 'performance', 'Event', 'KeyboardEvent', 'DragEvent', 'DataTransfer', 'File', script.textContent)(
                frame, documentBoundary, { log() {}, info() {}, warn() {}, error() {}, debug() {} },
                { getEntriesByType: () => [] }, Event, BrowserActionEvent, BrowserActionEvent, BrowserDataTransfer, File,
            );
        } },
    };
    const frame = Object.assign(new EventTarget(), {
        document: documentBoundary, location: { href: `${origin}/`, origin },
        localStorage: { length: 0 }, sessionStorage: { length: 0 },
        parent: { postMessage: (data: string) => queueMicrotask(() => deliver(host, data, frame)) },
        postMessage: (data: string) => queueMicrotask(() => deliver(frame, data, host)),
    });
    return { frame, events, input, focus };
}

describe('BrowserViewHost', () => {
    beforeEach(() => {
        simulatorTargetProps.length = 0;
        desktopWebViewTargetProps.length = 0;
    });

    it('admits a sessionless web frame through the actual viewer Home credential without a native descriptor', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://viewer-home.example.test' });
        const view = { ...createLocalPreviewView(), target: { ...createLocalPreviewView().target, sessionId: undefined },
            currentUrl: 'https://preview.example.test/?previewToken=custodian', securityOrigin: 'https://preview.example.test' };
        const resource = { previewId: 'preview_1', machineId: 'machine_1', owner: { kind: 'user' as const, id: 'starter' },
            serviceTarget: { kind: 'managed_service' as const, machineId: 'machine_1', managedServiceId: 'actual-instance', cwd: '/workspace/app',
                declaration: { workspaceRefId: 'workspace_1', selection: { kind: 'manifest' as const, name: 'web' } } },
            target: { scheme: 'http' as const, host: '127.0.0.1', port: 5173 }, initialPath: { pathname: '/', search: '' },
            display: { title: 'Web', addressLabel: 'localhost:5173' }, originMode: 'host' as const };
        const state = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), { generatedAt: 1_000, refreshState: 'idle', diagnostics: [],
            previews: [{ previewId: resource.previewId, resource, accessUrl: view.currentUrl, expiresAt: 2_000_000_000_000, diagnostics: [] }] });
        previewHttp.fetch.mockImplementation(async (url, init) => {
            if (url === 'https://viewer-home.example.test/v1/local-services/preview/preview_1/access'
                && new Headers(init?.headers).get('Authorization') === `Bearer ${previewHttp.token}`) return Response.json({
                    v: 1, kind: 'server_preview', previewId: resource.previewId, machineId: resource.machineId,
                    accessUrl: 'https://preview.example.test/?previewToken=viewer', expiresAt: 2_000_000_000_000 });
            return Response.json({ error: 'preview_access_denied' }, { status: 403 });
        });
        const screen = await renderScreen(<BrowserViewHost view={view} localServicePreviewState={state}
            localServicePreviewServerId={home.id} testID="viewer-preview" />);
        try {
            await flushHookEffects({ cycles: 40 });
            expect(screen.findByType('iframe').props.src).toBe('https://preview.example.test/?previewToken=viewer');
        } finally { await screen.unmount(); }
    });

    it('resolves a registered target-only web preview at the Home without manufacturing a daemon snapshot', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://target-only-home.example.test' });
        const view: BrowserControlViewState = { ...createLocalPreviewView(), target: {
            kind: 'localServicePreview', targetId: 'preview_1', machineId: 'machine_1', display: { title: 'Web' } },
            currentUrl: null, securityOrigin: null };
        previewHttp.fetch.mockImplementation(async (url, init) => {
            if (url === 'https://target-only-home.example.test/v1/local-services/preview/preview_1/access'
                && new Headers(init?.headers).get('Authorization') === `Bearer ${previewHttp.token}`) return Response.json({
                    v: 1, kind: 'server_preview', previewId: 'preview_1', machineId: 'machine_1',
                    accessUrl: 'https://preview.example.test/?previewToken=target-viewer', expiresAt: 2_000_000_000_000 });
            return Response.json({ error: 'preview_access_denied' }, { status: 403 });
        });
        const screen = await renderScreen(<BrowserViewHost view={view} localServicePreviewServerId={home.id} testID="target-viewer" />);
        try {
            await flushHookEffects({ cycles: 40 });
            expect(screen.findByType('iframe').props.src).toBe('https://preview.example.test/?previewToken=target-viewer');
        } finally { await screen.unmount(); }
    });

    it('fails closed when a hosted-plugin Browser view supplies only raw current or pending URLs', async () => {
        const view = {
            ...createHostedPluginView(),
            currentUrl: 'https://unadmitted.example.test/current',
            pendingUrl: 'https://unadmitted.example.test/pending',
        };
        const screen = await renderScreen(
            <BrowserViewHost
                view={view}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                testID="browser-view"
            />,
        );

        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(screen.findByTestId('browser-view-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-view-unavailable-diagnostic-hosted_plugin_artifact_unavailable')).toBeTruthy();
    });

    it('fails closed for hosted-plugin browser views without a matching browser profile', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createHostedPluginView()}
                pluginUiProjection={pluginUiProjection}
                testID="browser-view"
            />,
        );

        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(screen.findByTestId('browser-view-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-view-unavailable-diagnostic-profile_missing')).toBeTruthy();
    });

    it('fails closed for hosted-plugin browser views with a mismatched browser profile', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createHostedPluginView()}
                pluginUiProjection={pluginUiProjection}
                browserProfile={{
                    ...pluginBrowserProfile,
                    owner: {
                        kind: 'plugin',
                        id: 'other.plugin',
                    },
                }}
                testID="browser-view"
            />,
        );

        expect(screen.findAllByType('iframe')).toHaveLength(0);
        expect(screen.findByTestId('browser-view-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-view-unavailable-diagnostic-hosted_plugin_profile_mismatch')).toBeTruthy();
    });

    /**
     * H-UX F-1 / services lab R: a private preview this device has no access URL for (the server's
     * preview access owner issued none here) is a designed state that names where the service runs and
     * the way that works — never a generic "unavailable" or "Page failed to load".
     */
    it('says where a private preview runs when this device has no way to open it', async () => {
        const view = { ...createLocalPreviewView(), currentUrl: null, securityOrigin: null };
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const registeredWithoutAccess = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                // The server's preview access owner issued no URL for this viewer.
                accessUrl: null,
                expiresAt: null,
                accessUnavailableReasonCode: 'preview_private_route_unavailable',
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget: {
                        kind: 'localServicePreview',
                        targetId: 'preview_1',
                        sessionId: 'session_1',
                        machineId: 'machine_1',
                        display: { title: 'Preview', addressLabel: 'localhost:5173' },
                    },
                },
            }],
            diagnostics: [],
        });

        const screen = await renderScreen(
            <BrowserViewHost view={view} localServicePreviewState={registeredWithoutAccess} testID="browser-view" />,
        );

        expect(screen.findByTestId('browser-view-frame')).toBeNull();
        expect(screen.findByTestId('browser-view-elsewhere')).not.toBeNull();
        expect(screen.getTextContent()).toContain('browserShell.unavailable.previewElsewhere');
    });

    it('does not claim a preview runs elsewhere before its registration is known', async () => {
        const view = { ...createLocalPreviewView(), currentUrl: null, securityOrigin: null };

        const screen = await renderScreen(<BrowserViewHost view={view} testID="browser-view" />);

        expect(screen.findByTestId('browser-view-elsewhere')).toBeNull();
    });

    it('passes diagnostics bridge config into local-preview frame targets', async () => {
        const view = createLocalPreviewView();
        const collectorScripts: string[] = [];

        await renderScreen(
            <BrowserViewHost
                view={view}
                diagnosticsBridge={createDiagnosticsBridge(view, (script) => {
                    collectorScripts.push(script);
                })}
                testID="browser-view"
            />,
        );
        await flushHookEffects();

        expect(collectorScripts).toHaveLength(1);
        expect(collectorScripts[0]).toContain('"viewId":"view_local_1"');
        expect(collectorScripts[0]).toContain('"navigationGeneration":3');
    });

    it('registers injected-page automation owners for live local-preview iframe targets', async () => {
        const view = { ...createLocalPreviewView(), currentUrl: 'https://app.happier.test/', securityOrigin: 'https://app.happier.test' };
        const controlService = createBrowserAutomationControlService({ nowMs: () => 1_000 });
        const { frame } = createReachableCollectorFrame('https://app.happier.test');

        try {
            const screen = await renderScreen(
                <BrowserViewHost
                    view={view}
                    diagnosticsBridge={createDiagnosticsBridge(view, vi.fn())}
                    browserAutomation={{
                        controlService,
                        enabled: true,
                    }}
                    testID="browser-view"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: frame }
                            : null
                    ),
                },
            );
            await flushHookEffects();

            expect(readAutomationOwnerIds(controlService.getSnapshot())).not.toContain('view_local_1');
            await act(async () => screen.findByType('iframe').props.onLoad());
            expect(readAutomationOwnerIds(controlService.getSnapshot())).toContain('view_local_1');
            expect(Reflect.get(frame, '__happierBrowserRuntime')).toBeDefined();

            await screen.unmount();
            await flushHookEffects();

            expect(readAutomationOwnerIds(controlService.getSnapshot())).not.toContain('view_local_1');
            expect(Reflect.get(frame, '__happierBrowserRuntime')).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it.each(['press', 'hover', 'focus', 'upload', 'drag'])('dispatches the implemented %s verb through the mounted engine owner', async (actionKind) => {
        const view = { ...createLocalPreviewView(), currentUrl: 'https://app.happier.test/', securityOrigin: 'https://app.happier.test' };
        const controlService = createBrowserAutomationControlService({ nowMs: () => 1_000 });
        const { frame, events, input, focus } = createReachableCollectorFrame('https://app.happier.test');
        try {
            const screen = await renderScreen(<BrowserViewHost
                view={view}
                diagnosticsBridge={createDiagnosticsBridge(view, vi.fn())}
                browserAutomation={{ controlService, enabled: true }}
            />, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: frame } : null });
            await act(async () => screen.findByType('iframe').props.onLoad());
            await expect(controlService.executeAction({
                v: 1, automationRequestId: `request_${actionKind}`,
                browserSessionId: view.browserSessionId, viewId: view.viewId,
                navigationGeneration: view.navigationGeneration,
                requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' },
                actionKind, timeoutMs: 2_000,
                payload: {
                    locator: { kind: 'css', value: '#source' }, key: 'Enter',
                    from: { kind: 'css', value: '#source' }, to: { kind: 'css', value: '#destination' },
                    files: [{ name: 'hello.txt', mimeType: 'text/plain', text: 'hello' }],
                },
            })).resolves.toMatchObject({ status: 'succeeded' });
            const expectedEvents = { press: ['keydown', 'keyup'], hover: ['mouseover', 'mousemove'], focus: ['focus'], upload: ['input', 'change'], drag: ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'] };
            expect(events.map((event) => event.type)).toEqual(expectedEvents[actionKind as keyof typeof expectedEvents]);
            if (actionKind === 'press') expect(events[0]?.key).toBe('Enter');
            if (actionKind === 'focus') expect(focus).toHaveBeenCalled();
            if (actionKind === 'upload') expect(input.files[0]?.name).toBe('hello.txt');
            await screen.unmount();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('shows the agent\'s managed browser as its live stream, never as a fake page (lab browser A/ST)', async () => {
        const base = {
            selectedCodec: 'image.mjpeg',
            activeRenderer: 'mjpeg',
            decodedFrames: 0,
            droppedFrames: 0,
            bufferedBytes: 0,
        } as const;
        const openPage = vi.fn();
        const closePage = vi.fn();
        const render = (playerState: React.ComponentProps<typeof BrowserViewHost>['streamedBrowserRuntime']) => renderScreen(
            <BrowserViewHost view={createSidecarView()} streamedBrowserRuntime={playerState}
                onOpenStreamedPageHere={openPage} onClosePage={closePage} testID="browser-view" />,
        );

        // No stream could be opened: say so, never an embedded page.
        const none = await render(null);
        expect(none.findByTestId('browser-view-streamed-unavailable')).toBeTruthy();

        // Opening, no frame yet: connecting, not "playing".
        const opening = await render({ machineName: 'MacBook Pro', playerState: { ...base, phase: 'playing' } });
        expect(opening.findByTestId('browser-view-streamed-connecting')).toBeTruthy();
        expect(opening.findByTestId('browser-view-streamed-player')).toBeNull();

        // Frames arrive: the canonical player shows them.
        const live = await render({ machineName: 'MacBook Pro', playerState: { ...base, phase: 'playing', lastFrameUrl: 'data:image/jpeg;base64,AAAA' } });
        expect(live.findByTestId('browser-view-streamed-live')).toBeTruthy();
        expect(live.findByTestId('browser-view-streamed-player')).toBeTruthy();
        // A live page carries no status chip of its own: healthy is quiet (lab A).
        expect(live.findByTestId('browser-view-streamed-player-status-playing')).toBeNull();

        // The stream drops: the last frame stays, ONE status capsule says so (not a second player chip).
        const stalled = await render({ machineName: 'MacBook Pro', playerState: { ...base, phase: 'reconnecting', lastFrameUrl: 'data:image/jpeg;base64,AAAA' } });
        expect(stalled.findByTestId('browser-view-streamed-player')).toBeTruthy();
        expect(stalled.findByTestId('browser-view-streamed-stalled')).toBeTruthy();
        expect(stalled.findByTestId('browser-view-streamed-player-status-reconnecting')).toBeNull();

        // The producer stopped: ended, with no fake last frame.
        const ended = await render({ machineName: 'MacBook Pro', playerState: { ...base, phase: 'stopped', lastFrameUrl: 'data:image/jpeg;base64,AAAA' } });
        expect(ended.findByTestId('browser-view-streamed-ended')).toBeTruthy();
        expect(ended.findByTestId('browser-view-streamed-player')).toBeNull();
        await ended.pressByTestIdAsync('browser-view-streamed-ended-open');
        expect(openPage).toHaveBeenCalledOnce();
        await ended.pressByTestIdAsync('browser-view-streamed-ended-close');
        expect(closePage).toHaveBeenCalledOnce();
        expect(none.findByTestId('browser-view-streamed-ended-open')).toBeNull();
    });

    it('renders backed desktop external URL views through the native desktop WebView engine', async () => {
        const view = createExternalDesktopView();
        const diagnostics = createDiagnosticsBridge(view, vi.fn());

        const screen = await renderScreen(
            <BrowserViewHost
                view={view}
                diagnosticsBridge={diagnostics}
                lifecycleState="hidden"
                browserProfile={{
                    profileId: 'profile_external_1',
                    storageMode: 'session',
                    owner: { kind: 'session', id: 'session_1' },
                    cleanupOnSessionClose: true,
                }}
                testID="browser-view"
            />,
        );

        expect(screen.findByTestId('browser-view-frame')).toBeTruthy();
        expect(screen.findByTestId('browser-view-unavailable')).toBeNull();
        expect(desktopWebViewTargetProps).toHaveLength(1);
        expect(desktopWebViewTargetProps[0]).toMatchObject({
            view,
            profileId: 'profile_external_1',
            testID: 'browser-view-frame',
            diagnostics,
            lifecycleState: 'hidden',
        });
    });

    it('fails closed instead of registering automation when adapter capabilities omit automation actions', async () => {
        const view = createLocalPreviewView();
        const { automationActions: _automationActions, ...adapterCapabilities } = view.adapterCapabilities;
        const controlService = createBrowserAutomationControlService({ nowMs: () => 1_000 });
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });

        try {
            await renderScreen(
                <BrowserViewHost
                    view={{
                        ...view,
                        adapterCapabilities,
                    }}
                    diagnosticsBridge={createDiagnosticsBridge(view, vi.fn())}
                    browserAutomation={{
                        controlService,
                        enabled: true,
                    }}
                    testID="browser-view"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: { postMessage: vi.fn() } }
                            : null
                    ),
                },
            );
            await flushHookEffects();

            expect(readAutomationOwnerIds(controlService.getSnapshot())).not.toContain('view_local_1');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('renders the pending navigation URL for client-local navigation intents', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={{
                    ...createLocalPreviewView(),
                    pendingUrl: 'https://preview.happier.test/dashboard',
                    loadingState: 'loading',
                    loadingProgress: 0,
                }}
                testID="browser-view"
            />,
        );

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');
    });

    it('passes a stable frame navigation key for client-local reload intents', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createLocalPreviewView()}
                navigationEffect={{
                    kind: 'clientLocalNavigation',
                    viewId: 'view_local_1',
                    command: {
                        kind: 'reload',
                        commandId: 'command_reload_1',
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_local_1',
                    },
                }}
                testID="browser-view"
            />,
        );

        expect(screen.findByType('iframe').props['data-browser-navigation-key']).toBe('command_reload_1');
    });

    it('remounts web iframe reloads without also calling the frame reload API', async () => {
        const reload = vi.fn();

        const screen = await renderScreen(
            <BrowserViewHost
                view={createLocalPreviewView()}
                navigationEffect={{
                    kind: 'clientLocalNavigation',
                    viewId: 'view_local_1',
                    command: {
                        kind: 'reload',
                        commandId: 'command_reload_1',
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_local_1',
                    },
                }}
                testID="browser-view"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { location: { reload } } }
                        : null
                ),
            },
        );
        await flushHookEffects();

        expect(screen.findByType('iframe').props['data-browser-navigation-key']).toBe('command_reload_1');
        expect(reload).not.toHaveBeenCalled();
    });

    it('does not pass stale diagnostics bridge config into rendered frame targets', async () => {
        const view = createLocalPreviewView();
        const staleView = {
            ...view,
            viewId: 'stale_view',
            navigationGeneration: 2,
        };
        const collectorScripts: string[] = [];

        await renderScreen(
            <BrowserViewHost
                view={view}
                diagnosticsBridge={createDiagnosticsBridge(staleView, (script) => {
                    collectorScripts.push(script);
                })}
                testID="browser-view"
            />,
        );
        await flushHookEffects();

        expect(collectorScripts).toHaveLength(0);
    });

    it('does not attach diagnostics to a raw-URL hosted-plugin Browser view', async () => {
        const view = createHostedPluginView();
        const collectorScripts: string[] = [];

        await renderScreen(
            <BrowserViewHost
                view={view}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                diagnosticsBridge={createDiagnosticsBridge(view, (script) => {
                    collectorScripts.push(script);
                })}
                testID="browser-view"
            />,
        );
        await flushHookEffects();

        expect(collectorScripts).toHaveLength(0);
    });

    it('does not promote invalid or expired Browser URLs into hosted-plugin endpoints', async () => {
        const invalid = createHostedPluginView();
        const invalidScreen = await renderScreen(
            <BrowserViewHost
                view={{ ...invalid, currentUrl: 'javascript:alert(1)' }}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                testID="browser-view-invalid"
            />,
        );

        const expiredScreen = await renderScreen(
            <BrowserViewHost
                view={{
                    ...createHostedPluginView(),
                    currentUrlExpiresAt: 1_000,
                }}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                nowMs={() => 2_000}
                testID="browser-view-expired"
            />,
        );

        expect(invalidScreen.findByTestId('browser-view-invalid-unavailable')).toBeTruthy();
        expect(invalidScreen.findAllByType('iframe')).toHaveLength(0);
        expect(expiredScreen.findByTestId('browser-view-expired-unavailable')).toBeTruthy();
        expect(expiredScreen.findAllByType('iframe')).toHaveLength(0);
    });

    it('renders simulator preview browser targets through the simulator preview surface', async () => {
        const actions = {
            selectDevice: vi.fn(),
        };
        const screen = await renderScreen(
            <BrowserViewHost
                view={createSimulatorView()}
                simulatorPreviewRuntime={{
                    resources: [{
                        v: 1,
                        simulatorId: 'sim_1',
                        platform: 'ios',
                        deviceId: 'device_1',
                        displayName: 'iPhone 16',
                        capture: {
                            status: 'available',
                            sourceId: 'source_1',
                            supportedCodecs: ['image.mjpeg'],
                            inputMode: 'exclusive',
                        },
                    }],
                    selectedSimulatorId: 'sim_1',
                    viewerId: 'viewer_1',
                    actions,
                }}
                testID="browser-view-simulator"
            />,
        );

        expect(screen.findByTestId('browser-view-simulator-simulator')).toBeTruthy();
        expect(screen.findByTestId('browser-view-simulator-unavailable')).toBeNull();
        const props = simulatorTargetProps.at(-1);
        expect((props?.viewModel as { selectedSimulatorId?: unknown } | undefined)?.selectedSimulatorId).toBe('sim_1');
        expect(props?.actions).toBe(actions);
    });

    it('selects simulator preview resources by producer source identity when device ids differ', async () => {
        await renderScreen(
            <BrowserViewHost
                view={{
                    ...createSimulatorView(),
                    target: {
                        kind: 'simulatorPreview',
                        targetId: 'simulator_1',
                        deviceId: 'emulator-5554',
                        sourceId: 'simulator:android:emulator-5554:screen',
                        display: { title: 'Pixel 9' },
                    },
                }}
                simulatorPreviewRuntime={{
                    resources: [
                        {
                            v: 1,
                            simulatorId: 'sim_decoy',
                            platform: 'android',
                            deviceId: 'adb:emulator-5556',
                            displayName: 'Pixel 8',
                            capture: {
                                status: 'available',
                                sourceId: 'simulator:android:emulator-5556:screen',
                                supportedCodecs: ['image.mjpeg'],
                                inputMode: 'exclusive',
                            },
                        },
                        {
                            v: 1,
                            simulatorId: 'sim_android_1',
                            platform: 'android',
                            deviceId: 'adb:emulator-5554',
                            displayName: 'Pixel 9',
                            capture: {
                                status: 'available',
                                sourceId: 'simulator:android:emulator-5554:screen',
                                supportedCodecs: ['image.mjpeg'],
                                inputMode: 'exclusive',
                            },
                        },
                    ],
                    selectedSimulatorId: null,
                    viewerId: 'viewer_1',
                    actions: {},
                }}
                testID="browser-view-simulator"
            />,
        );

        const props = simulatorTargetProps.at(-1);
        expect((props?.viewModel as { selectedSimulatorId?: unknown } | undefined)?.selectedSimulatorId).toBe('sim_android_1');
    });
});
