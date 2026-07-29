import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserLocalServicePreviewTargetV1 } from '@happier-dev/protocol';
import { buildPluginHostedWebStaticAssetPreviewId } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { reactNativeSurfaceProps, activeLanguage, surfaceEnvironment } = vi.hoisted(() => ({
    reactNativeSurfaceProps: [] as unknown[],
    activeLanguage: { value: 'en' },
    surfaceEnvironment: {
        platform: 'web' as 'web' | 'ios' | 'android',
        dark: false,
        rtl: false,
        fontScale: 1,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        reducedMotion: false,
        screenReaderEnabled: false,
        highContrast: false,
    },
}));
const pluginSurfaceConnectivity = vi.hoisted(() => ({
    endpointStatus: 'online' as 'online' | 'offline',
    machineOnline: true,
    daemonStateVersion: 1,
}));
const declarativeSettingsGetMock = vi.hoisted(() => vi.fn());
const declarativeSettingsSetMock = vi.hoisted(() => vi.fn());
const declarativeActionExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginSettingsGet: (...args: unknown[]) => declarativeSettingsGetMock(...args),
    machinePluginSettingsSet: (...args: unknown[]) => declarativeSettingsSetMock(...args),
    machinePluginStructuredMessageActionExecute: (...args: unknown[]) => declarativeActionExecuteMock(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useEndpointStatus: () => pluginSurfaceConnectivity.endpointStatus,
    useMachineCliDetectionTarget: () => ({
        isOnline: pluginSurfaceConnectivity.machineOnline,
        daemonStateVersion: pluginSurfaceConnectivity.daemonStateVersion,
    }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return surfaceEnvironment.platform;
            },
        },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const unistyles = await createUnistylesMock();
    return {
        ...unistyles,
        useUnistyles: () => {
            const { theme, rt } = unistyles.useUnistyles();
            return {
                theme: { ...theme, dark: surfaceEnvironment.dark },
                rt: {
                    ...rt,
                    rtl: surfaceEnvironment.rtl,
                    fontScale: surfaceEnvironment.fontScale,
                    insets: surfaceEnvironment.insets,
                },
            };
        },
    };
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => surfaceEnvironment.reducedMotion,
}));

vi.mock('@/hooks/ui/useScreenReaderEnabled', () => ({
    useScreenReaderEnabled: () => surfaceEnvironment.screenReaderEnabled,
}));

vi.mock('@/hooks/ui/useHighContrastPreference', () => ({
    useHighContrastPreference: () => surfaceEnvironment.highContrast,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock({
            translate: (key) => key,
            translateLoose: (key) => key,
            getPreferredLanguage: () => activeLanguage.value,
        }),
        hasTranslation: () => false,
    };
});

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async () => {
    const ReactModule = await import('react');
    return {
        PluginReactNativeSurface: (props: any) => {
            reactNativeSurfaceProps.push(props);
            return ReactModule.createElement('PluginReactNativeSurfaceMock', {
                testID: 'plugin-react-native-surface-proxy',
            });
        },
    };
});

afterEach(() => {
    activeLanguage.value = 'en';
    surfaceEnvironment.platform = 'web';
    surfaceEnvironment.dark = false;
    surfaceEnvironment.rtl = false;
    surfaceEnvironment.fontScale = 1;
    surfaceEnvironment.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    surfaceEnvironment.reducedMotion = false;
    surfaceEnvironment.screenReaderEnabled = false;
    surfaceEnvironment.highContrast = false;
    pluginSurfaceConnectivity.endpointStatus = 'online';
    pluginSurfaceConnectivity.machineOnline = true;
    pluginSurfaceConnectivity.daemonStateVersion = 1;
    declarativeSettingsGetMock.mockReset();
    declarativeSettingsSetMock.mockReset();
    declarativeActionExecuteMock.mockReset();
});

const target: BrowserLocalServicePreviewTargetV1 = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
};

function createPreviewState() {
    return applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
        generatedAt: 100,
        refreshState: 'idle',
        diagnostics: [],
        previews: [{
            previewId: 'preview_1',
            accessUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: null,
            diagnostics: [],
            resource: {
                previewId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                owner: { kind: 'session', id: 'session_1' },
                target: {
                    scheme: 'https',
                    host: 'localhost',
                    port: 5173,
                },
                initialPath: { pathname: '/', search: '' },
                display: {
                    title: 'Preview',
                    addressLabel: 'localhost:5173',
                },
                originMode: 'host',
                browserTarget: target,
            },
        }],
    });
}

const hostedWebProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['requestSessionResource'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
};

const browserHostedWebPlacement = {
    id: 'surfacePlacement:acme.browser:hosted-panel',
    pluginId: 'acme.browser',
    contributionKind: 'surfacePlacement',
    descriptorId: 'hosted-panel',
    placement: 'browser.panel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
} as const;

const translatedHostRendererProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    translationsByPluginId: {
        'acme.browser': {
            id: 'translations:acme.browser',
            pluginId: 'acme.browser',
            contributionKind: 'translations',
            locales: ['en', 'es'],
            bundles: {
                en: {
                    'acme.browser.panel.title': 'Translated browser panel',
                    'acme.browser.panel.description': 'Plugin-owned browser panel description.',
                },
                es: {
                    'acme.browser.panel.title': 'Panel de navegador traducido',
                    'acme.browser.panel.description': 'Descripcion del panel del plugin.',
                },
            },
        },
    },
};

const STATIC_ASSET_PREVIEW_ID = buildPluginHostedWebStaticAssetPreviewId({
    pluginId: 'acme.docs',
    contributionId: 'panel',
    sessionId: 'session_docs',
    machineId: 'machine_docs',
});

const staticAssetHostedWebProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.docs:panel': {
            id: 'hostedWeb:acme.docs:panel',
            pluginId: 'acme.docs',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'staticAssets', assetRootId: 'hosted-web/docs' },
            runtimeMode: { kind: 'installedStaticAssets', artifactId: 'docs-static', assetRootId: 'hosted-web/docs' },
            entry: { routeMode: 'pathFallback', path: '/' },
            bridge: { allowedMessages: ['requestSessionResource'] },
            sandbox: { scripts: true },
            // Installed static-asset bundles are served over loopback http, so the
            // declared policy must allow devLoopbackOnly mixed content to load.
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    scriptSrc: 'selfOnly',
                    styleSrc: 'selfOnly',
                    imgSrc: 'selfOnly',
                    fontSrc: 'selfOnly',
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'devLoopbackOnly',
            },
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: { state: 'render', reason: 'available', diagnostics: [] },
            },
        },
    },
};

// A static-asset hosted-web placement carries NO explicit browser target: the
// served loopback endpoint is correlated from the daemon-registered preview.
const staticAssetHostedWebPlacement = {
    id: 'surfacePlacement:acme.docs:docs-panel',
    pluginId: 'acme.docs',
    contributionKind: 'surfacePlacement',
    descriptorId: 'docs-panel',
    placement: 'services.panel',
    target: { kind: 'services' },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Docs' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
} as const;

function createStaticAssetPreviewState() {
    return applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
        generatedAt: 100,
        refreshState: 'idle',
        diagnostics: [],
        previews: [{
            previewId: STATIC_ASSET_PREVIEW_ID,
            accessUrl: 'http://127.0.0.1:51789/',
            expiresAt: null,
            diagnostics: [],
            resource: {
                previewId: STATIC_ASSET_PREVIEW_ID,
                sessionId: 'session_docs',
                machineId: 'machine_docs',
                owner: { kind: 'plugin', id: 'acme.docs' },
                target: { scheme: 'http', host: '127.0.0.1', port: 51789 },
                initialPath: { pathname: '/', search: '' },
                display: { title: 'Docs', addressLabel: '127.0.0.1:51789' },
                originMode: 'path',
            },
        }],
    });
}

const reactNativeCacheIdentity = {
    pluginId: 'acme.browser',
    contributionId: 'native-panel',
    artifactDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

const defaultReactNativeModuleReference = {
    containerName: 'acme_browser_native_panel',
    modulePath: './renderSurface',
    exportName: 'renderSurface',
} as const;

const reactNativeProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    reactNativeBundlesById: {
        'reactNativeBundle:acme.browser:native-panel': {
            id: 'reactNativeBundle:acme.browser:native-panel',
            pluginId: 'acme.browser',
            contributionKind: 'reactNativeBundle',
            contributionId: 'native-panel',
            hostApi: {
                minVersion: '1.0.0',
                methods: ['requestSessionResource'],
            },
            runtime: {
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
                loadPolicy: {
                    source: 'installedArtifact',
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                },
                cacheKey: 'native-cache-key',
                cacheIdentity: reactNativeCacheIdentity,
            },
        },
    },
};

const browserReactNativePlacement = {
    id: 'surfacePlacement:acme.browser:native-panel',
    pluginId: 'acme.browser',
    contributionKind: 'surfacePlacement',
    descriptorId: 'native-panel',
    placement: 'browser.panel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    renderer: { kind: 'reactNative', contributionId: 'native-panel' },
    display: { label: 'Native panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
} as const;

const transitiveFallbackHostPlacement = {
    ...browserReactNativePlacement,
    id: 'surfacePlacement:acme.browser:descriptor-tertiary',
    descriptorId: 'descriptor-tertiary',
    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
} as const;

const transitiveFallbackReactNativePlacement = {
    ...browserReactNativePlacement,
    id: 'surfacePlacement:acme.browser:native-with-web-fallback',
    descriptorId: 'native-with-web-fallback',
    renderer: {
        kind: 'reactNative',
        contributionId: 'native-panel',
        fallback: { kind: 'hostedWeb', contributionId: 'panel' },
    },
} as const;

const transitiveFallbackProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            ...hostedWebProjection.hostedWebById['hostedWeb:acme.browser:panel'],
            fallback: { kind: 'descriptor', descriptorId: 'descriptor-tertiary' },
        },
    },
    reactNativeBundlesById: {
        'reactNativeBundle:acme.browser:native-panel': {
            ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
            runtime: {
                decision: {
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['react_native_unavailable'],
                    fallback: { kind: 'hostedWeb', contributionId: 'panel' },
                },
                loadPolicy: {
                    source: 'installedArtifact',
                    featureEnabled: false,
                    loaderBackendAvailable: true,
                },
            },
        },
    },
    surfacePlacementsById: {
        [transitiveFallbackHostPlacement.id]: transitiveFallbackHostPlacement,
    },
};

describe('PluginSurfacePlacementHost', () => {
    it('renders an evaluated declarative model and uses canonical settings/action RPCs', async () => {
        surfaceEnvironment.platform = 'android';
        declarativeSettingsGetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '0', values: { name: 'Before', count: 2, mode: 'safe', enabled: true, token: 'must-not-render' }, redactedKeys: ['token'] } });
        declarativeSettingsSetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '1', values: { name: 'After', count: 3, mode: 'fast', enabled: true }, redactedKeys: ['token'] } });
        declarativeActionExecuteMock.mockResolvedValue({ supported: true, result: { ok: true, result: null } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:settings', pluginId: 'acme.forms', pluginVersion: '1.0.0',
            contributionKind: 'surfacePlacement', descriptorId: 'settings', generatedV2: true,
            placement: 'app.settingsPage', target: { kind: 'app' }, display: { developerFallback: 'Settings' },
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-7' },
                visible: true, requiredHostMethods: ['executeAction'], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, title: 'Profile', children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', contributionId: 'profile', qualifiedId: 'acme.forms/settings/profile/fields/name', descriptor: { id: 'name', title: 'Name', target: { kind: 'plugin' }, scope: 'pluginLocal', schema: { type: 'string' } } } },
                    { kind: 'status', path: 'root.children[1]', order: 2, label: 'State', value: 'Ready', tone: 'success' },
                    { kind: 'action', path: 'root.children[2]', order: 3, action: { identity: { pluginId: 'acme.forms', localId: 'save' }, qualifiedId: 'acme.forms/save', generation: 'generation-7' }, label: 'Save', enabled: true },
                    { kind: 'action', path: 'root.children[3]', order: 4, action: { identity: { pluginId: 'acme.forms', localId: 'delete' }, qualifiedId: 'acme.forms/delete', generation: 'generation-7' }, label: 'Delete', enabled: false },
                    { kind: 'stack', path: 'root.children[4]', order: 5, direction: 'vertical', children: [
                        { kind: 'text', path: 'root.children[4].children[0]', order: 6, text: 'Plain text' },
                        { kind: 'markdown', path: 'root.children[4].children[1]', order: 7, text: '**Formatted**' },
                    ] },
                    { kind: 'field', path: 'root.children[5]', order: 8, label: 'Count', control: { kind: 'number', settingId: 'count' }, setting: { id: 'count' } },
                    { kind: 'field', path: 'root.children[6]', order: 9, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode' } },
                    { kind: 'field', path: 'root.children[7]', order: 10, label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' }, setting: { id: 'enabled' } },
                    { kind: 'field', path: 'root.children[8]', order: 11, label: 'Token', control: { kind: 'secret', settingId: 'token' }, setting: { id: 'token' } },
                    { kind: 'action', path: 'root.children[9]', order: 12, action: { identity: { pluginId: 'acme.shared', localId: 'reset' }, qualifiedId: 'acme.shared/reset', generation: 'generation-7' }, label: 'Reset', enabled: true },
                ] },
            } },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" serverId="server-a" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        await act(async () => {});
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Before');
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'After'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
            pluginId: 'acme.forms',
            fieldId: 'name',
            value: 'After',
            expectedRevision: '0',
        }));
        await act(async () => { screen.pressByTestId('plugin-declarative-action:acme.forms/save'); });
        expect(declarativeActionExecuteMock).toHaveBeenCalledWith('machine-1', { serverId: 'server-a', expectedGeneration: 'generation-7', qualifiedActionId: 'acme.forms/save', input: null, executionSurface: 'ui' });
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/delete')?.props.disabled).toBe(true);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/delete')?.props.style.minHeight).toBe(48);
        expect(screen.findByTestId('plugin-declarative-status')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findByTestId('plugin-declarative-stack')).toBeTruthy();
        expect(screen.findByTestId('plugin-declarative-markdown:root.children[4].children[1]')?.props.markdown).toBe('**Formatted**');
        expect(screen.getTextContent()).toContain('Plain text');
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.secureTextEntry).toBe(true);
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.value).toBe('');
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.style.minHeight).toBe(48);
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[8]')?.props.style.minHeight).toBe(48);
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[5]', '42'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[5]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({ fieldId: 'count', value: 42 }));
        await act(async () => { screen.pressByTestId('plugin-declarative-field:root.children[6]:option:1'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({ fieldId: 'mode', value: 'fast' }));
        await act(async () => { screen.pressByTestId('plugin-declarative-action:acme.shared/reset'); });
        expect(declarativeActionExecuteMock).toHaveBeenCalledWith('machine-1', { serverId: 'server-a', expectedGeneration: 'generation-7', qualifiedActionId: 'acme.shared/reset', input: null, executionSurface: 'ui' });
    });

    it('keeps declarative settings inert without a machine and ignores stale recovery responses', async () => {
        let resolveOldSettings!: (value: unknown) => void;
        const oldSettings = new Promise((resolve) => { resolveOldSettings = resolve; });
        let resolveReconnectSettings!: (value: unknown) => void;
        const reconnectSettings = new Promise((resolve) => { resolveReconnectSettings = resolve; });
        let currentMachineRequestCount = 0;
        declarativeSettingsGetMock.mockImplementation((machineId: string) => {
            if (machineId === 'machine-old') return oldSettings;
            currentMachineRequestCount += 1;
            return currentMachineRequestCount === 1
                ? Promise.resolve({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '0', values: { name: 'Current' }, redactedKeys: [] } })
                : reconnectSettings;
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = (generation: string) => ({
            id: 'surfacePlacement:acme.forms:recovery', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'recovery', generatedV2: true,
            placement: 'app.settingsPage', target: { kind: 'app' }, display: { developerFallback: 'Recovery' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name' } },
                    { kind: 'action', path: 'root.children[1]', order: 2, action: { identity: { pluginId: 'acme.forms', localId: 'save' }, qualifiedId: 'acme.forms/save', generation }, label: 'Save', enabled: true },
                ] },
            } },
        } as const);
        const renderPlacement = (generation: string, machineId?: string) => <PluginSurfacePlacementHost placement={placement(generation)} machineId={machineId} pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />;
        const screen = await renderScreen(renderPlacement('generation-1'));
        expect(declarativeSettingsGetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(true);

        await screen.update(renderPlacement('generation-1', 'machine-old'));
        expect(declarativeSettingsGetMock).toHaveBeenCalledWith('machine-old', expect.objectContaining({ pluginId: 'acme.forms' }));
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(false);
        const staleOnlineAction = screen.findByTestId(
            'plugin-declarative-action:acme.forms/save',
        )?.props.onPress as (() => void);

        await act(async () => { resolveOldSettings({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '0', values: { name: 'Stale' }, redactedKeys: [] } }); });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');

        pluginSurfaceConnectivity.endpointStatus = 'offline';
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        const offlineBoundary = screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        );
        expect(offlineBoundary?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(offlineBoundary?.props.style).toMatchObject({ pointerEvents: 'none' });
        expect(screen.findByTestId(
            'plugin-surface-offline-summary:declarative:acme.forms:acme.forms/form',
        )?.props.role).toBe('status');
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(true);
        await act(async () => {
            staleOnlineAction();
        });
        expect(declarativeActionExecuteMock).not.toHaveBeenCalled();

        const callsBeforeReconnect = declarativeSettingsGetMock.mock.calls.length;
        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.daemonStateVersion += 1;
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        expect(declarativeSettingsGetMock).toHaveBeenCalledTimes(callsBeforeReconnect + 1);
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        expect(screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        )?.props.inert).toBe(true);
        await act(async () => {
            resolveReconnectSettings({
                supported: true,
                snapshot: {
                    protocolVersion: 1,
                    pluginId: 'acme.forms',
                    storageScope: 'local',
                    revision: '1',
                    values: { name: 'Revalidated' },
                    redactedKeys: [],
                },
            });
            await reconnectSettings;
        });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value)
            .toBe('Revalidated');
        expect(screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        )?.props.inert).toBe(false);
        expect(screen.findByTestId(
            'plugin-surface-offline-summary:declarative:acme.forms:acme.forms/form',
        )).toBeNull();
    });

    it('serializes declarative setting writes and restores authoritative values after failure', async () => {
        let resolveFirstWrite!: (value: unknown) => void;
        const firstWrite = new Promise((resolve) => { resolveFirstWrite = resolve; });
        declarativeSettingsGetMock
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '0', values: { name: 'Before', mode: 'safe' }, redactedKeys: [] } })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '2', values: { name: 'External', mode: 'fast' }, redactedKeys: [] } });
        declarativeSettingsSetMock
            .mockImplementationOnce(() => firstWrite)
            .mockResolvedValueOnce({ supported: false, reason: 'error' })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '3', values: { name: 'Retried', mode: 'fast' }, redactedKeys: [] } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:writes', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'writes', generatedV2: true,
            placement: 'app.settingsPage', target: { kind: 'app' }, display: { developerFallback: 'Writes' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name' } },
                    { kind: 'field', path: 'root.children[1]', order: 2, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode' } },
                ] },
            } },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        await act(async () => {});
        const staleNameSave = screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.onPress as (() => void);

        await act(async () => { screen.pressByTestId('plugin-declarative-field:root.children[1]:option:1'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);
        await act(async () => { staleNameSave(); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(1);

        await act(async () => { resolveFirstWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '1', values: { name: 'Before', mode: 'fast' }, redactedKeys: [] } }); });
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'After'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(declarativeSettingsGetMock).toHaveBeenCalledTimes(2));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('External');
        expect(screen.findByTestId('plugin-declarative-settings-error')?.props.accessibilityLiveRegion).toBe('polite');

        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Retried'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            fieldId: 'name',
            expectedRevision: '2',
        }));
    });

    it('does not let a pre-reconnect write completion release the current authority write lock', async () => {
        let resolvePreReconnectWrite!: (value: unknown) => void;
        const preReconnectWrite = new Promise((resolve) => { resolvePreReconnectWrite = resolve; });
        let resolveCurrentWrite!: (value: unknown) => void;
        const currentWrite = new Promise((resolve) => { resolveCurrentWrite = resolve; });
        declarativeSettingsGetMock
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '0', values: { name: 'Before', mode: 'safe' }, redactedKeys: [] } })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '1', values: { name: 'Revalidated', mode: 'safe' }, redactedKeys: [] } });
        declarativeSettingsSetMock
            .mockImplementationOnce(() => preReconnectWrite)
            .mockImplementationOnce(() => currentWrite)
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '3', values: { name: 'Unexpected', mode: 'fast' }, redactedKeys: [] } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:write-reconnect', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'write-reconnect', generatedV2: true,
            placement: 'app.settingsPage', target: { kind: 'app' }, display: { developerFallback: 'Write reconnect' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name' } },
                    { kind: 'field', path: 'root.children[1]', order: 2, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode' } },
                ] },
            } },
        } as const;
        const renderPlacement = () => (
            <PluginSurfacePlacementHost
                placement={placement}
                machineId="machine-1"
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />
        );
        const screen = await renderScreen(renderPlacement());
        await act(async () => {});

        await act(async () => {
            screen.pressByTestId('plugin-declarative-field:root.children[1]:option:1');
        });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(1);

        pluginSurfaceConnectivity.endpointStatus = 'offline';
        await screen.update(renderPlacement());
        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.daemonStateVersion += 1;
        await screen.update(renderPlacement());
        await act(async () => {});

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Current write');
            screen.pressByTestId('plugin-declarative-field-save:root.children[0]');
        });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);

        await act(async () => {
            resolvePreReconnectWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '1', values: { name: 'Stale', mode: 'fast' }, redactedKeys: [] } });
            await preReconnectWrite;
        });

        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveCurrentWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', storageScope: 'local', revision: '2', values: { name: 'Current write', mode: 'safe' }, redactedKeys: [] } });
            await currentWrite;
        });
    });

    it('renders unavailable instead of a blank surface for a mismatched evaluated model', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:mismatch', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'mismatch', generatedV2: true,
            placement: 'app.settingsPage', target: { kind: 'app' }, display: { developerFallback: 'Mismatch' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            renderer: { kind: 'declarative', contributionId: 'form', model: { identity: { pluginId: 'other.plugin', localId: 'form', qualifiedId: 'other.plugin/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [], root: { kind: 'text', path: 'root', order: 0, text: 'Must not render' } } },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('declarative_model_unavailable');
        expect(screen.getTextContent()).not.toContain('Must not render');
    });

    it('keeps generated declarative source rows inert until the daemon projects an evaluated model', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const declarativePlacement = {
            id: 'surfacePlacement:acme.forms:settings',
            pluginId: 'acme.forms',
            contributionKind: 'surfacePlacement',
            descriptorId: 'settings',
            generatedV2: true,
            placement: 'app.settingsPage',
            target: { kind: 'app' },
            renderer: {
                kind: 'declarative',
                contributionId: 'settings-form',
                root: {
                    kind: 'action',
                    action: 'save',
                    label: 'Save settings',
                },
                requiredHostMethods: ['executeAction'],
            },
            display: { titleKey: 'settings', developerFallback: 'Settings' },
            availability: {
                state: 'fallback',
                reason: 'declarative_model_unavailable',
                diagnostics: ['declarative_model_unavailable'],
            },
        } as const;
        const handleRequest = vi.fn();

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativePlacement}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
                hostApi={{ platform: 'web', channel: 'internal', handleRequest }}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('declarative_model_unavailable');
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')).toBeNull();
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('renders explicit unavailable states for unavailable or unevaluated placements', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const unavailablePlacement = {
            ...browserHostedWebPlacement,
            availability: {
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            },
        } as const;
        const deferredPlacement = {
            ...browserHostedWebPlacement,
            featureGate: 'plugins.ui.hostedWeb',
        } as const;

        const unavailable = await renderScreen(
            <PluginSurfacePlacementHost
                placement={unavailablePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        const deferred = await renderScreen(
            <PluginSurfacePlacementHost
                placement={deferredPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(unavailable.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(deferred.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(unavailable.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(deferred.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(unavailable.getTextContent()).toContain('feature_disabled');
        expect(deferred.getTextContent()).toContain('feature_disabled');
    });

    it('threads host policy context into placement and hosted-web render gates', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const gatedPlacement = {
            ...browserHostedWebPlacement,
            featureGate: 'plugins.ui.hostedWeb',
        } as const;
        const gatedProjection: PluginUiProjectionModel = {
            ...hostedWebProjection,
            hostedWebById: {
                ...hostedWebProjection.hostedWebById,
                'hostedWeb:acme.browser:panel': {
                    ...hostedWebProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    compatibility: {
                        platforms: ['web'],
                        channels: ['internal'],
                    },
                },
            },
        };

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={gatedPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={gatedProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
                hostApi={{
                    platform: 'web',
                    channel: 'internal',
                    handleRequest: vi.fn(async () => ({ accepted: true })),
                }}
                policyContext={{
                    isFeatureEnabled: (featureId) => featureId === 'plugins.ui.hostedWeb',
                }}
            />,
        );

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
    });

    it('passes hosted-web Host API through browser panel placements with browserSurface context', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const handleRequest = vi.fn(async () => ({ state: 'available', title: 'Preview' }));
        (globalThis as any).window = new EventTarget();

        try {
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={browserHostedWebPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    pluginUiProjection={hostedWebProjection}
                    localServicePreviewState={createPreviewState()}
                    platform="web"
                    hostApi={{
                        platform: 'web',
                        channel: 'internal',
                        handleRequest,
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
            const frame = screen.root.findByType('iframe');
            expect(String(frame?.props.src ?? '')).toContain('happierBridgeNonce=');
            const nonce = new URL(String(frame?.props.src ?? 'https://unused.test/')).searchParams.get('happierBridgeNonce') ?? 'nonce';

            await act(async () => undefined);
            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'https://preview.happier.test' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        contributionId: 'panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce,
                        sequence: 2,
                        kind: 'requestSessionResource',
                        payload: { resource: { kind: 'session' } },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
            });

            expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
                surface: expect.objectContaining({
                    placement: 'browserSurface',
                }),
            }));
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('keeps hosted-web and React Native snapshots inert when daemon connectivity is offline', async () => {
        reactNativeSurfaceProps.length = 0;
        pluginSurfaceConnectivity.endpointStatus = 'offline';
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const hostApi = {
            platform: 'web' as const,
            channel: 'internal' as const,
            handleRequest: vi.fn(async () => ({ accepted: true })),
        };

        const hostedWeb = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
                hostApi={hostApi}
            />,
        );
        expect(hostedWeb.findByTestId(
            'plugin-surface-snapshot:surfacePlacement:acme.browser:hosted-panel',
        )?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(hostedWeb.findByTestId(
            'plugin-surface-offline-summary:surfacePlacement:acme.browser:hosted-panel',
        )).toBeTruthy();

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                machineId="machine_1"
                pluginUiProjection={reactNativeProjection}
                platform="web"
                hostApi={hostApi}
            />,
        );
        expect(reactNativeSurfaceProps.at(-1)).toMatchObject({
            interactionEnabled: false,
            snapshotTitle: 'Native panel',
        });

        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.machineOnline = false;
        await hostedWeb.update(
            <PluginSurfacePlacementHost
                placement={browserHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
                hostApi={hostApi}
            />,
        );
        expect(hostedWeb.findByTestId(
            'plugin-surface-snapshot:surfacePlacement:acme.browser:hosted-panel',
        )?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                machineId="machine_1"
                pluginUiProjection={reactNativeProjection}
                platform="web"
                hostApi={hostApi}
            />,
        );
        expect(reactNativeSurfaceProps.at(-1)).toMatchObject({
            interactionEnabled: false,
        });
    });

    it('renders an installed static-asset hosted-web surface from the daemon-served preview endpoint (Phase 6.1)', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const served = await renderScreen(
            <PluginSurfacePlacementHost
                placement={staticAssetHostedWebPlacement}
                machineId="machine_docs"
                sessionId="session_docs"
                pluginUiProjection={staticAssetHostedWebProjection}
                localServicePreviewState={createStaticAssetPreviewState()}
                platform="web"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            },
        );
        const iframe = served.findByType('iframe');
        expect(iframe).not.toBeNull();
        expect(String(iframe?.props.src ?? '')).toContain('http://127.0.0.1:51789/');

        // Truthful availability: with no served preview row the surface stays
        // unavailable instead of advertising a phantom endpoint.
        const unserved = await renderScreen(
            <PluginSurfacePlacementHost
                placement={staticAssetHostedWebPlacement}
                machineId="machine_docs"
                sessionId="session_docs"
                pluginUiProjection={staticAssetHostedWebProjection}
                localServicePreviewState={createLocalServicePreviewState()}
                platform="web"
            />,
        );
        expect(unserved.root.findAllByType('iframe')).toHaveLength(0);
    });

    it('passes a typed RN Host API and injected ScriptManager backend into loadable RN placements', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadInstalledBundle = vi.fn(async () => module.renderSurface);
        const handleRequest = vi.fn(async () => ({ accepted: true }));

        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: reactNativeCacheIdentity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                pluginUiProjection={reactNativeProjection}
                platform="ios"
                hostApi={{
                    platform: 'ios',
                    channel: 'internal',
                    handleRequest,
                }}
                reactNativeLoaderBackend={{
                    backendId: 'repackScriptManager',
                    available: true,
                    loadInstalledBundle,
                }}
            />,
        );

        const props = reactNativeSurfaceProps.at(-1) as {
            hostApi?: {
                requestSessionResource?: (payload: unknown) => Promise<unknown>;
                dispatchAction?: (payload: unknown) => Promise<unknown>;
            };
            load?: () => Promise<unknown>;
        };
        expect(props.hostApi).toEqual(expect.objectContaining({
            requestSessionResource: expect.any(Function),
            dispatchAction: expect.any(Function),
        }));
        await expect(props.hostApi?.requestSessionResource?.({ resource: { kind: 'session' } }))
            .resolves.toEqual({ accepted: true });
        await expect(props.hostApi?.dispatchAction?.({ actionId: 'plugin.preview.open' }))
            .rejects.toMatchObject({ code: 'denied' });
        await expect(props.load?.()).resolves.toEqual(module);
        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity: reactNativeCacheIdentity,
            bytes: expect.any(Uint8Array),
            moduleReference: defaultReactNativeModuleReference,
        });
    });

    it('mounts generated RNW with the canonical SDK render context and no invented Re.Pack identity', async () => {
        reactNativeSurfaceProps.length = 0;
        surfaceEnvironment.dark = true;
        surfaceEnvironment.rtl = true;
        surfaceEnvironment.fontScale = 1.6;
        surfaceEnvironment.insets = { top: 12, right: 8, bottom: 24, left: 4 };
        surfaceEnvironment.reducedMotion = true;
        surfaceEnvironment.screenReaderEnabled = true;
        surfaceEnvironment.highContrast = true;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const entryRelativePath = 'react-native/native-panel/index.js';
        const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        const generatedIdentity = {
            ...reactNativeCacheIdentity,
            artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            platform: 'web',
            projectionGeneration: 44,
        };
        const generatedProjection = {
            ...reactNativeProjection,
            generation: 44,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    generatedV2: true,
                    pluginVersion: '3.2.1',
                    artifactGraph: {
                        contributionId: 'native-panel-artifact',
                        tier: 'reactNative',
                        platform: 'web',
                        entry: entryRelativePath,
                        files: [{
                            relativePath: entryRelativePath,
                            digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                            byteSize: entryBytes.byteLength,
                        }],
                        digest: generatedIdentity.artifactDigest,
                        builtWith: { bundler: 'vite', version: '7.0.0' },
                        hostUiApiVersion: '1.0.0',
                        compat: { react: '19.2.0', reactNative: '0.83.4' },
                    },
                    hostApi: {
                        minVersion: '1.0.0',
                        methods: ['context', 'executeAction'],
                    },
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'installedArtifact' },
                        cacheKey: 'generated-native-cache-key',
                        cacheIdentity: generatedIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;
        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: generatedIdentity,
            bytes: entryBytes,
            entryRelativePath,
            format: 'plainJs',
            files: [{
                relativePath: entryRelativePath,
                digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }],
        });
        const renderSurface = () => React.createElement('PluginNativeSurface');
        const loadInstalledBundle = vi.fn(async () => renderSurface);
        const handleRequest = vi.fn(async () => ({ accepted: true }));

        const renderPlacement = (
            projection: PluginUiProjectionModel = generatedProjection,
            connected = true,
        ) => (
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                pluginUiProjection={projection}
                sessionId="session-generated"
                platform="web"
                hostApi={connected ? { platform: 'web', channel: 'internal', handleRequest } : undefined}
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle,
                }}
            />
        );
        const screen = await renderScreen(renderPlacement());
        const props = reactNativeSurfaceProps.at(-1) as {
            hostApi?: unknown;
            renderContext?: {
                plugin: { id: string; version: string };
                view: { id: string; placement: string };
                surface: {
                    locale: string;
                    direction: string;
                    colorScheme: string;
                    contrast: string;
                    textScale: number;
                    reducedMotion: boolean;
                    screenReaderEnabled: boolean;
                    safeAreaInsets: { top: number; right: number; bottom: number; left: number };
                    session?: { id: string };
                };
                hostApi: {
                    version(): { apiVersion: string; wireVersion: number; methods: readonly string[] };
                    context(): Promise<unknown>;
                    executeAction(action: string, input: unknown): Promise<unknown>;
                };
                signal: AbortSignal;
            };
            load?: () => Promise<unknown>;
            interactionEnabled?: boolean;
        };

        expect(props.hostApi).toBeUndefined();
        expect(props.interactionEnabled).toBe(true);
        expect(props.renderContext).toMatchObject({
            plugin: { id: 'acme.browser', version: '3.2.1' },
            view: { id: 'native-panel', placement: 'browser.panel' },
            surface: {
                locale: 'en',
                direction: 'rtl',
                colorScheme: 'dark',
                contrast: 'high',
                textScale: 1.6,
                reducedMotion: true,
                screenReaderEnabled: true,
                safeAreaInsets: { top: 12, right: 8, bottom: 24, left: 4 },
                session: { id: 'session-generated' },
            },
            hostApi: {
                version: expect.any(Function),
                context: expect.any(Function),
                executeAction: expect.any(Function),
            },
            signal: expect.any(AbortSignal),
        });
        expect(props.renderContext).not.toHaveProperty('generation');
        expect(props.renderContext?.hostApi.version()).toMatchObject({
            apiVersion: '1.0.0',
            wireVersion: 1,
            methods: expect.arrayContaining(['context', 'executeAction', 'readResource']),
        });
        await expect(props.renderContext?.hostApi.context()).resolves.toBe(props.renderContext?.surface);
        await expect(props.renderContext?.hostApi.executeAction('open', { source: 'generated' }))
            .resolves.toEqual({ accepted: true });
        expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
            method: 'dispatchAction',
            payload: { action: 'open', input: { source: 'generated' } },
        }));
        await expect(props.load?.()).resolves.toEqual({ renderSurface });
        expect(loadInstalledBundle).toHaveBeenCalledWith({
            identity: generatedIdentity,
            bytes: entryBytes,
            files: expect.any(Array),
            entryRelativePath,
        });

        const initialSignal = props.renderContext?.signal;
        surfaceEnvironment.dark = false;
        surfaceEnvironment.rtl = false;
        surfaceEnvironment.fontScale = 2;
        surfaceEnvironment.insets = { top: 0, right: 16, bottom: 20, left: 16 };
        surfaceEnvironment.reducedMotion = false;
        surfaceEnvironment.screenReaderEnabled = false;
        surfaceEnvironment.highContrast = false;
        await screen.update(renderPlacement());
        const refreshedProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(refreshedProps.renderContext?.surface).toMatchObject({
            direction: 'ltr',
            colorScheme: 'light',
            contrast: 'normal',
            textScale: 2,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 16, bottom: 20, left: 16 },
        });
        expect(refreshedProps.renderContext?.signal).toBe(initialSignal);
        expect(refreshedProps.renderContext?.signal.aborted).toBe(false);

        await screen.update(renderPlacement(generatedProjection, false));
        const offlineProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(offlineProps.interactionEnabled).toBe(false);
        expect(offlineProps.renderContext).toBeUndefined();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        await expect(props.renderContext?.hostApi.executeAction('open', { source: 'offline' }))
            .rejects.toMatchObject({ code: 'stale_surface' });

        await screen.update(renderPlacement({
            ...generatedProjection,
            generation: generatedIdentity.projectionGeneration + 1,
        }));
        const staleGenerationProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(staleGenerationProps.load).toBeUndefined();
        expect(staleGenerationProps.interactionEnabled).toBe(false);
        expect(staleGenerationProps.renderContext).toBeUndefined();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();

        await screen.update(renderPlacement());
        const revalidatedProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(revalidatedProps.interactionEnabled).toBe(true);
        expect(revalidatedProps.renderContext).toBeDefined();

        await screen.unmount();
        expect(props.renderContext?.signal.aborted).toBe(true);
    });

    it('RN-2: mounts a devHotReload source loadable from the projected dev-server URL', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadDevServerBundle = vi.fn(async () => module.renderSurface);
        const devUrl = 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true';
        const devProjection = {
            ...reactNativeProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: {
                            source: 'devHotReload',
                            devUrl,
                            featureEnabled: true,
                            loaderBackendAvailable: true,
                        },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                pluginUiProjection={devProjection}
                platform="ios"
                hostApi={{ platform: 'ios', channel: 'internal', handleRequest: vi.fn(async () => ({ accepted: true })) }}
                reactNativeLoaderBackend={{
                    backendId: 'repackScriptManager',
                    available: true,
                    loadDevServerBundle,
                }}
            />,
        );

        const props = reactNativeSurfaceProps.at(-1) as {
            loadPolicy?: { source?: string; devUrl?: string };
            load?: () => Promise<unknown>;
        };
        expect(props.loadPolicy).toEqual(expect.objectContaining({ source: 'devHotReload', devUrl }));
        await expect(props.load?.()).resolves.toEqual(module);
        expect(loadDevServerBundle).toHaveBeenCalledWith({
            devUrl,
            pluginId: 'acme.browser',
            contributionId: 'native-panel',
            moduleReference: defaultReactNativeModuleReference,
        });
    });

    it('RN-2: does not build a dev load path for a denied devHotReload projection (no dev URL / fallback)', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const deniedProjection = {
            ...reactNativeProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: { state: 'fallback', reason: 'channel_policy_denied', diagnostics: ['dev_hot_reload_denied'] },
                        loadPolicy: { source: 'devHotReload', featureEnabled: true, loaderBackendAvailable: true },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                pluginUiProjection={deniedProjection}
                platform="ios"
                hostApi={{ platform: 'ios', channel: 'internal', handleRequest: vi.fn(async () => ({ accepted: true })) }}
            />,
        );

        const props = reactNativeSurfaceProps.at(-1) as {
            decision?: { state?: string };
            load?: () => Promise<unknown>;
        };
        expect(props.decision?.state).toBe('fallback');
        expect(props.load).toBeUndefined();
    });

    it('mounts the hosted-web fallback when the declared RN renderer is unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={transitiveFallbackReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={transitiveFallbackProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            },
        );

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeNull();
    });

    it('mounts the descriptor fallback when RN and its hosted-web fallback are unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const projection: PluginUiProjectionModel = {
            ...transitiveFallbackProjection,
            hostedWebById: {
                'hostedWeb:acme.browser:panel': {
                    ...transitiveFallbackProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['hosted_web_unavailable'],
                        decision: {
                            state: 'fallback',
                            reason: 'hosted_web_unavailable',
                            diagnostics: ['hosted_web_unavailable'],
                        },
                    },
                },
            },
        };

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={transitiveFallbackReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={projection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-host-renderer-descriptorPanel')).toBeTruthy();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeNull();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('fails closed when projected RN Host API requirements are missing', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const entry = reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'];
        const { hostApi: _hostApi, ...entryWithoutHostApi } = entry;
        const malformedProjection = {
            ...reactNativeProjection,
            reactNativeBundlesById: {
                ...reactNativeProjection.reactNativeBundlesById,
                'reactNativeBundle:acme.browser:native-panel': entryWithoutHostApi,
            },
        } as unknown as PluginUiProjectionModel;
        const handleRequest = vi.fn(async () => ({ accepted: true }));

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                pluginUiProjection={malformedProjection}
                platform="ios"
                hostApi={{
                    platform: 'ios',
                    channel: 'internal',
                    handleRequest,
                }}
            />,
        );

        const props = reactNativeSurfaceProps.at(-1) as {
            hostApi?: {
                requestSessionResource?: (payload: unknown) => Promise<unknown>;
            };
        };
        await expect(props.hostApi?.requestSessionResource?.({ resource: { kind: 'session' } }))
            .rejects.toMatchObject({ code: 'denied' });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('maps workspace, project, and app placements to concrete surface contexts', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placements = [
            {
                ...browserReactNativePlacement,
                id: 'surfacePlacement:acme.browser:workspace-details',
                descriptorId: 'workspace-details',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
            },
            {
                ...browserReactNativePlacement,
                id: 'surfacePlacement:acme.browser:project-main',
                descriptorId: 'project-main',
                placement: 'project.main',
                target: { kind: 'project' },
            },
            {
                ...browserReactNativePlacement,
                id: 'surfacePlacement:acme.browser:app-bottom-panel',
                descriptorId: 'app-bottom-panel',
                placement: 'app.bottomPanel',
                target: { kind: 'app' },
            },
        ] as const;

        for (const placement of placements) {
            await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    pluginUiProjection={reactNativeProjection}
                    platform="ios"
                />,
            );
        }

        expect(reactNativeSurfaceProps.map((props) => (
            (props as { surface?: { placement?: string } }).surface?.placement
        ))).toEqual([
            'workspaceSurface',
            'projectSurface',
            'appSurface',
        ]);
    });

    it('renders a host-owned fallback for descriptor-only placement renderers instead of a blank surface', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserHostedWebPlacement,
                    id: 'surfacePlacement:acme.browser:descriptor-only',
                    descriptorId: 'descriptor-only',
                    placement: 'app.settingsPage',
                    target: { kind: 'app' },
                    renderer: { kind: 'host', rendererId: 'settingsDescriptorPanel' },
                }}
                pluginUiProjection={hostedWebProjection}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-surface-placement-settingsDescriptorPanel')).toBeTruthy();
    });

    it('renders the registered host renderer-id component for generic descriptor-only placements (PR-12)', async () => {
        surfaceEnvironment.rtl = true;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserHostedWebPlacement,
                    id: 'surfacePlacement:acme.browser:workspace-details-host',
                    descriptorId: 'workspace-details-host',
                    placement: 'workspace.details',
                    target: { kind: 'workspace' },
                    renderer: { kind: 'host', rendererId: 'actionPanel' },
                    display: { developerFallback: 'Workspace details' },
                }}
                pluginUiProjection={hostedWebProjection}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-host-renderer-actionPanel')?.props.style).toEqual(
            expect.objectContaining({
                borderRightWidth: 2,
                paddingRight: 14,
            }),
        );
        expect(screen.findByTestId('plugin-host-renderer-actionPanel')?.props.accessible).toBe(true);
        expect(screen.findByTestId('plugin-host-renderer-actionPanel')?.props.accessibilityRole).toBe('summary');
        expect(screen.findByTestId('plugin-host-renderer-actionPanel')?.props.accessibilityLabel)
            .toContain('Workspace details');
        expect(screen.findByTestId('plugin-host-renderer-actionPanel')?.props.style)
            .not.toHaveProperty('borderLeftWidth');
        // The registered renderer renders the real component, NOT the generic fallback.
        expect(screen.findByTestId('plugin-surface-placement-actionPanel')).toBeNull();
        surfaceEnvironment.rtl = false;
    });

    it('resolves descriptor-only host renderer title and description through plugin translation bundles', async () => {
        activeLanguage.value = 'es';
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserHostedWebPlacement,
                    id: 'surfacePlacement:acme.browser:translated-host',
                    descriptorId: 'translated-host',
                    placement: 'browser.panel',
                    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
                    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                    display: {
                        titleKey: 'acme.browser.panel.title',
                        descriptionKey: 'acme.browser.panel.description',
                    },
                }}
                pluginUiProjection={translatedHostRendererProjection}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-host-renderer-descriptorPanel')).toBeTruthy();
        const renderedText = screen.root.findAllByType('Text')
            .map((node) => String(node.props.children ?? ''))
            .join('\n');
        expect(renderedText).toContain('Panel de navegador traducido');
        expect(renderedText).toContain('Descripcion del panel del plugin.');
        expect(renderedText).not.toContain('Translated browser panel');
        expect(renderedText).not.toContain('Plugin-owned browser panel description.');
        expect(renderedText).not.toContain('acme.browser.panel.title');
        expect(renderedText).not.toContain('acme.browser.panel.description');
        activeLanguage.value = 'en';
    });

    it('falls back for unregistered host renderer ids and bare host renderers (fail-closed)', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const unregistered = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserHostedWebPlacement,
                    id: 'surfacePlacement:acme.browser:unknown-host',
                    descriptorId: 'unknown-host',
                    placement: 'app.settingsPage',
                    target: { kind: 'app' },
                    renderer: { kind: 'host', rendererId: 'notARegisteredRenderer' },
                }}
                pluginUiProjection={hostedWebProjection}
                platform="web"
            />,
        );
        expect(unregistered.findByTestId('plugin-surface-placement-notARegisteredRenderer')).toBeTruthy();
        expect(unregistered.findByTestId('plugin-host-renderer-notARegisteredRenderer')).toBeNull();
    });
});

describe('REG-2 — cross-mode runtime selection through the Surface Registry SSOT', () => {
    it('derives providedModes from the declared renderer + cross-mode fallback ref', async () => {
        const { resolveSurfaceMountProvidedModes } = await import('./PluginSurfaceHost');
        // A hostedWeb renderer with a host-descriptor fallback declares BOTH the
        // hostedWeb mode and (via the descriptor fallback) the host mode.
        expect(resolveSurfaceMountProvidedModes({
            kind: 'hostedWeb',
            contributionId: 'inspector-details-web',
            fallback: { kind: 'descriptor', descriptorId: 'inspector-details-host' },
        })).toEqual(['hostedWeb', 'host']);
        // An RN renderer with a hostedWeb fallback declares RN + hostedWeb.
        expect(resolveSurfaceMountProvidedModes({
            kind: 'reactNative',
            contributionId: 'native-panel',
            fallback: { kind: 'hostedWeb', contributionId: 'panel' },
        })).toEqual(['reactNative', 'hostedWeb']);
        // A bare host renderer declares only the host mode.
        expect(resolveSurfaceMountProvidedModes({ kind: 'host', rendererId: 'descriptorPanel' }))
            .toEqual(['host']);
        // `unavailable`/`none` fallbacks add no cross-mode.
        expect(resolveSurfaceMountProvidedModes({
            kind: 'hostedWeb',
            contributionId: 'panel',
            fallback: { kind: 'unavailable' },
        })).toEqual(['hostedWeb']);
    });

    it('selectRuntimeMode returns the registry-priority mode among the provided+available modes', async () => {
        const { resolveSurfaceMountMode } = await import('./PluginSurfaceHost');
        // session.details supportedRuntimeModes priority = host, hostedWeb, ...
        // both modes provided + available → registry-priority `host` wins. The
        // mount layer (resolveCrossModeHostFallbackMount) keeps the AUTHOR's
        // declared hostedWeb primary unless it is runtime-unavailable.
        const mode = resolveSurfaceMountMode({
            surfaceId: 'session.details',
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'inspector-details-web',
                fallback: { kind: 'descriptor', descriptorId: 'inspector-details-host' },
            },
            isRuntimeAvailable: () => true,
            isTrustCompatible: () => true,
        });
        expect(mode).toBe('host');
    });

    it('falls across to the host mode through the registry when the declared mode runtime is unavailable', async () => {
        const { resolveSurfaceMountMode } = await import('./PluginSurfaceHost');
        const mode = resolveSurfaceMountMode({
            surfaceId: 'session.details',
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'inspector-details-web',
                fallback: { kind: 'descriptor', descriptorId: 'inspector-details-host' },
            },
            // hostedWeb served endpoint unavailable → registry must pick the host
            // mode declared by the cross-mode fallback ref.
            isRuntimeAvailable: (candidate) => candidate !== 'hostedWeb',
            isTrustCompatible: () => true,
        });
        expect(mode).toBe('host');
    });

    it('returns null when no provided mode is runtime-available or trust-compatible (fail-closed)', async () => {
        const { resolveSurfaceMountMode } = await import('./PluginSurfaceHost');
        expect(resolveSurfaceMountMode({
            surfaceId: 'session.details',
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'inspector-details-web',
                fallback: { kind: 'descriptor', descriptorId: 'inspector-details-host' },
            },
            isRuntimeAvailable: () => true,
            isTrustCompatible: () => false,
        })).toBeNull();
    });

    it('mounts the cross-mode host fallback descriptor when the declared hostedWeb endpoint is unavailable', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        // session.details supports both hostedWeb + host. The declared renderer is
        // hostedWeb with a host-descriptor fallback, but NO served preview exists,
        // so the registry selects `host` and the host fallback descriptor mounts.
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserHostedWebPlacement,
                    id: 'surfacePlacement:acme.docs:details',
                    pluginId: 'acme.docs',
                    descriptorId: 'inspector-details',
                    placement: 'session.details',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    renderer: {
                        kind: 'hostedWeb',
                        contributionId: 'missing-web',
                        fallback: { kind: 'descriptor', descriptorId: 'inspector-details-host' },
                    },
                }}
                sessionId="session_docs"
                machineId="machine_docs"
                pluginUiProjection={{
                    ...EMPTY_PLUGIN_UI_PROJECTION,
                    surfacePlacementsById: {
                        'surfacePlacement:acme.docs:inspector-details-host': {
                            id: 'surfacePlacement:acme.docs:inspector-details-host',
                            pluginId: 'acme.docs',
                            contributionKind: 'surfacePlacement',
                            descriptorId: 'inspector-details-host',
                            placement: 'session.details',
                            target: { kind: 'session', sessionIdPath: '/session/id' },
                            renderer: { kind: 'host', rendererId: 'resourceSummary' },
                            display: { developerFallback: 'Session Inspector' },
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                    },
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                platform="web"
            />,
        );
        // The host fallback descriptor's renderer id mounts via the host renderer map.
        expect(screen.findByTestId('plugin-host-renderer-resourceSummary')).toBeTruthy();
        // No hosted-web iframe is mounted for the unavailable primary mode.
        expect(screen.root.findAllByType('iframe')).toHaveLength(0);
    });

    it('mounts the cross-mode hostedWeb fallback when the declared RN runtime is unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const projection = {
            ...hostedWebProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserReactNativePlacement,
                    renderer: {
                        kind: 'reactNative',
                        contributionId: 'native-panel',
                        fallback: { kind: 'hostedWeb', contributionId: 'panel' },
                    },
                }}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={projection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeNull();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('keeps typed RN unavailable when both RN and its hostedWeb fallback are unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const projection = {
            ...hostedWebProjection,
            hostedWebById: {
                'hostedWeb:acme.browser:panel': {
                    ...hostedWebProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    runtime: {
                        state: 'fallback',
                        diagnostics: ['feature_disabled'],
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                },
            },
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserReactNativePlacement,
                    renderer: {
                        kind: 'reactNative',
                        contributionId: 'native-panel',
                        fallback: { kind: 'hostedWeb', contributionId: 'panel' },
                    },
                }}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={projection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        const props = reactNativeSurfaceProps.at(-1) as { decision?: { state?: string; diagnostics?: readonly string[] } };
        expect(props.decision).toMatchObject({
            state: 'fallback',
            diagnostics: ['feature_disabled'],
        });
    });
});
