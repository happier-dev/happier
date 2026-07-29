import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { BrowserViewHost } from './BrowserViewHost';
import type { BrowserDiagnosticsEngineBridgeConfig } from './frame/types';

const simulatorTargetProps: Array<Readonly<Record<string, unknown>>> = [];
const desktopWebViewTargetProps: Array<Readonly<Record<string, unknown>>> = [];
const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));

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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storage')>(),
    useEndpointStatus: () => endpointConnectivityState.status,
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

describe('BrowserViewHost', () => {
    beforeEach(() => {
        simulatorTargetProps.length = 0;
        desktopWebViewTargetProps.length = 0;
        endpointConnectivityState.status = 'online';
    });

    it('renders hosted-plugin browser views through the semantic hosted-plugin adapter', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createHostedPluginView()}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                testID="browser-view"
            />,
        );

        const iframe = screen.findByType('iframe');
        // Phase 1.3: the browser-view hosted-web pane now carries a live host API,
        // so a bridged surface receives the bridge handshake query params.
        const src = new URL(iframe.props.src);
        expect(`${src.origin}${src.pathname}`).toBe('https://plugins.happier.test/plugin.example/surface.main/');
        expect(src.searchParams.get('happierPluginId')).toBe('plugin.example');
        expect(src.searchParams.get('happierContributionId')).toBe('surface.main');
        expect(src.searchParams.get('happierSurfaceId')).toBe('hosted_1');
        expect(typeof src.searchParams.get('happierBridgeNonce')).toBe('string');
        expect(iframe.props.sandbox).toBe('allow-scripts allow-popups');
        expect(screen.findByTestId('browser-view-unavailable')).toBeNull();
    });

    it('keeps a loaded hosted-plugin iframe as a non-interactive snapshot while the endpoint is offline', async () => {
        endpointConnectivityState.status = 'offline';
        const renderElement = () => (
            <BrowserViewHost
                view={createHostedPluginView()}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                testID="browser-view"
            />
        );

        const screen = await renderScreen(renderElement());

        expect(screen.findByType('iframe')).toBeTruthy();
        expect(
            screen.findByTestId('plugin-surface-interaction-boundary:hosted_1')?.props,
        ).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });

        endpointConnectivityState.status = 'online';
        await screen.update(renderElement());
        expect(
            screen.findByTestId('plugin-surface-interaction-boundary:hosted_1')?.props,
        ).toMatchObject({
            inert: false,
            'aria-hidden': false,
        });
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
        const view = createLocalPreviewView();
        const controlService = createBrowserAutomationControlService({ nowMs: () => 1_000 });
        const postMessage = vi.fn();
        const addEventListener = vi.fn();
        const removeEventListener = vi.fn();
        vi.stubGlobal('window', {
            addEventListener,
            removeEventListener,
        });

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
                            ? { contentWindow: { postMessage } }
                            : null
                    ),
                },
            );
            await flushHookEffects();

            expect(addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
            expect(readAutomationOwnerIds(controlService.getSnapshot())).toContain('view_local_1');

            await screen.unmount();
            await flushHookEffects();

            expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
            expect(readAutomationOwnerIds(controlService.getSnapshot())).not.toContain('view_local_1');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('renders sidecar targets as unavailable with the sidecar runtime reason', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createSidecarView()}
                testID="browser-view"
            />,
        );

        expect(screen.findByTestId('browser-view-unavailable')).toBeTruthy();
        expect(screen.findByTestId('browser-view-unavailable-diagnostic-sidecar_runtime_unavailable')).toBeTruthy();
    });

    it('renders backed desktop external URL views through the native desktop WebView engine', async () => {
        const view = createExternalDesktopView();
        const diagnostics = createDiagnosticsBridge(view, vi.fn());

        const screen = await renderScreen(
            <BrowserViewHost
                view={view}
                diagnosticsBridge={diagnostics}
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

    it('passes hosted-plugin web reload effects to the hosted iframe remount key', async () => {
        const screen = await renderScreen(
            <BrowserViewHost
                view={createHostedPluginView()}
                pluginUiProjection={pluginUiProjection}
                browserProfile={pluginBrowserProfile}
                navigationEffect={{
                    kind: 'clientLocalNavigation',
                    viewId: 'view_1',
                    command: {
                        kind: 'reload',
                        commandId: 'command_reload_hosted_1',
                        browserSessionId: 'browser_session_1',
                        viewId: 'view_1',
                    },
                }}
                testID="browser-view"
            />,
        );

        expect(screen.findByType('iframe').props['data-browser-navigation-key']).toBe('command_reload_hosted_1');
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

    it('passes diagnostics bridge config through hosted-plugin policy pane into the shared frame target', async () => {
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

        expect(collectorScripts).toHaveLength(1);
        expect(collectorScripts[0]).toContain('"viewId":"view_1"');
        expect(collectorScripts[0]).toContain('"collectorId":"collector:view_1"');
    });

    it('fails closed for hosted-plugin browser views with invalid or expired hosted-web endpoints', async () => {
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

        expect(invalidScreen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
        expect(invalidScreen.findAllByType('iframe')).toHaveLength(0);
        expect(expiredScreen.findByTestId('plugin-hosted-web-unavailable')).toBeTruthy();
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
