import * as React from 'react';
import {
    type BrowserContextCapabilities,
    type BrowserRecordingCapabilities,
    type BrowserTargetPolicyDecisionV1,
    type FeatureDecision,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    normalizePluginUiDestinationBindingV1,
    PluginUiArtifactsManifestEntryV1Schema,
    type CurrentUiContextSnapshotV1,
} from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationCaptureSurface } from '@/components/browser/annotation';
import type { CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    type PluginUiClientExecutableActivation,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import { renderScreen } from '@/dev/testkit';
import {
    createBrowserViewState,
    openBrowserTarget,
} from '@/sync/domains/browser/store';
import { createBrowserDiagnosticsUiStore } from '@/sync/domains/browser/diagnostics';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/frame/engines/DesktopWebViewEngine', () => ({
    DesktopWebViewEngine: (props: Readonly<Record<string, unknown>>) => React.createElement('View', {
        testID: props.testID ?? 'desktop-webview',
    }),
}));

const pluginSurfaceAccountLifetime = vi.hoisted(() => {
    let current = true;
    const retirements = new Set<() => void>();
    const lifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
        isCurrent: () => current,
        onRetire: (cancel: () => void) => {
            if (!current) {
                cancel();
                return Object.freeze({ dispose: () => {} });
            }
            retirements.add(cancel);
            return Object.freeze({ dispose: () => retirements.delete(cancel) });
        },
    });
    let capture: typeof lifetime | null = lifetime;
    return {
        capture: () => capture,
        captureNone: () => { capture = null; },
        retire: () => {
            if (!current) return;
            current = false;
            for (const cancel of [...retirements]) cancel();
            retirements.clear();
        },
        reset: () => {
            current = true;
            capture = lifetime;
            retirements.clear();
        },
    };
});
const browserCurrentUiContextReader = vi.hoisted(() => ({
    value: null as CurrentUiContextReader | null,
}));
const browserActionModal = vi.hoisted(() => {
    let confirm: (() => void) | null = null;
    return {
        show: vi.fn((config: unknown) => {
            confirm = (config as Readonly<{ props: Readonly<{ onConfirm: () => void }> }>).props.onConfirm;
            return 'browser-client-action-confirmation';
        }),
        hide: vi.fn(),
        confirmFallback: vi.fn(async () => true),
        confirm: () => {
            if (confirm === null) throw new Error('Browser client Action confirmation was not shown');
            confirm();
        },
        shown: () => confirm !== null,
        reset: () => { confirm = null; },
    };
});
const accountEncryptionModeCredentials = vi.hoisted(() => ({
    value: { token: 'browser-host-account-mode-test-token' } as Readonly<{ token: string }> | null,
}));
const accountEncryptionModeFetch = vi.hoisted(() => vi.fn<
    typeof import('@/sync/api/account/apiAccountEncryptionMode').fetchAccountEncryptionMode
>());

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => pluginSurfaceAccountLifetime.capture(),
}));

vi.mock('@/components/appShell/currentUiContext/CurrentUiContextProvider', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/appShell/currentUiContext/CurrentUiContextProvider')>();
    return {
        ...original,
        // Browser receives this opaque app-shell capability; this focused host
        // test observes whether its late read is reached without replacing the
        // Browser, dispatcher, or current-intent implementations.
        useOptionalCurrentUiContextReader: () => browserCurrentUiContextReader.value,
    };
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: browserActionModal.show as never,
            hide: browserActionModal.hide,
            confirm: browserActionModal.confirmFallback,
        },
    }).module;
});

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>();
    return {
        ...original,
        fetchAccountEncryptionMode: (...args: Parameters<typeof original.fetchAccountEncryptionMode>) => (
            accountEncryptionModeFetch(...args)
        ),
    };
});

vi.mock('@/sync/sync', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/sync')>();
    return {
        ...original,
        sync: new Proxy(original.sync, {
            get(target, property) {
                if (property === 'getCredentials') {
                    return () => accountEncryptionModeCredentials.value;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} as const;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_docs',
    url: 'https://docs.happier.test/',
    display: {
        title: 'Docs',
        addressLabel: 'docs.happier.test',
    },
} as const;

const sessionBrowserProfile = {
    profileId: 'profile_session_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} as const;

const allowedExternalPolicy = {
    targetKind: 'externalUrl',
    state: 'allowed',
    profileId: sessionBrowserProfile.profileId,
    profileMode: 'session',
    origin: 'https://docs.happier.test',
    security: {
        url: 'https://docs.happier.test/',
        origin: 'https://docs.happier.test',
        securityLevel: 'secure',
        reasonCodes: [],
    },
    permissions: {
        downloads: 'deny',
        uploads: 'deny',
        clipboard: 'deny',
        camera: 'deny',
        microphone: 'deny',
        fileAccess: 'deny',
        popups: 'deny',
        browserUse: 'prompt',
    },
    disabledReasons: [],
} satisfies BrowserTargetPolicyDecisionV1;

const enabledBrowserDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 1_000,
    scope: { scopeKind: 'runtime' },
} satisfies FeatureDecision;

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

const annotationDesktopWebView = {
    ...availableDesktopWebView,
    supports: {
        ...availableDesktopWebView.supports,
        capture: true,
    },
} as const;

const annotationContextCapabilities = {
    enabled: true,
    available: true,
    supportedContextKinds: ['browserPageReference', 'browserAnnotation'],
    supportedAdapterKinds: ['externalUrl'],
    screenshot: {
        supported: true,
        requiresAttachmentUploads: true,
        maxBytes: 5_000_000,
    },
    text: {
        maxSelectionChars: 2048,
        maxSummaryChars: 8192,
    },
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserContextCapabilities;

const previewDiagnostics = {
    status: 'available',
    sourceKind: 'previewProxy',
    fidelity: 'previewProxy',
    trusted: true,
    attribution: 'traffic_for_preview_all_views',
    activeFlowCount: 0,
    families: [],
    flows: [],
} as const;

const recordingCapabilities = {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: ['streamFrameCapture'],
    supportedMimeTypes: ['video/webm'],
    supportedAdapterKinds: ['localPreview'],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: true,
    actionTimelineChaptersSupported: true,
    supportedRetentionClasses: ['preSend', 'attached'],
    disabledReasons: [],
    policyDeniedReasons: [],
} satisfies BrowserRecordingCapabilities;

const browserPanelBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'acme.browser',
    destinationId: 'panel',
    rendererId: 'panel',
    container: 'browserPanel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
});
if (!browserPanelBinding) throw new Error('Browser panel binding fixture is required');

const browserPanelPlacement = {
    id: 'surfacePlacement:acme.browser:panel',
    pluginId: 'acme.browser',
    contributionKind: 'surfacePlacement',
    descriptorId: 'panel',
    binding: browserPanelBinding,
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    availability: {
        state: 'available',
        reason: 'available',
        diagnostics: [],
    },
    headerActions: [],
    order: 10,
} as const;

const hostedWebBrowserPanelProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['ready'] },
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
    surfacePlacementsById: {
        [browserPanelPlacement.id]: browserPanelPlacement,
    },
};

const BROWSER_CLIENT_ACTION_PLUGIN_ID = 'acme.browser-client-action';
const BROWSER_CLIENT_ACTION_ID = 'refresh-preview';
const BROWSER_CLIENT_ACTION_GENERATION = 17;
const BROWSER_CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'browser-client-action-bundle',
    modulePath: './actions/refreshPreview',
    exportName: 'execute',
    platform: 'web' as const,
});
const BROWSER_CLIENT_ACTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_browser_client_action',
    materializationRef: Object.freeze({
        pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
        machineId: target.machineId,
        materializationId: 'materialization-browser-client-action',
    }),
});
const BROWSER_CLIENT_ACTION_ORIGIN_PROJECTION = Object.freeze({
    machineId: target.machineId,
    serverId: 'server-1',
    generation: BROWSER_CLIENT_ACTION_GENERATION,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: BROWSER_CLIENT_ACTION_ORIGIN,
});
const BROWSER_CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    generation: Object.freeze({
        targetGeneration: String(BROWSER_CLIENT_ACTION_GENERATION),
        desiredGeneration: String(BROWSER_CLIENT_ACTION_GENERATION),
        appliedGeneration: String(BROWSER_CLIENT_ACTION_GENERATION),
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});
const BROWSER_CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV1Schema.parse({
    contributionId: BROWSER_CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    platform: BROWSER_CLIENT_ACTION_TARGET.platform,
    entry: 'react-native/browser-client-action-bundle/index.js',
    files: [{
        relativePath: 'react-native/browser-client-action-bundle/index.js',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'vite', version: '7.0.0' },
    hostUiApiVersion: '1.0.0',
    compat: { react: '19.0.0', reactNative: '0.83.4' },
});

function createBrowserClientActionFixture(handler: PluginClientActionHandler): Readonly<{
    activation: PluginUiClientExecutableActivation;
    pluginUiProjection: PluginUiProjectionModel;
    pluginBrowserProjection: PluginBrowserProjectionModel;
}> {
    const action = PluginProjectedActionV2Schema.parse({
        id: BROWSER_CLIENT_ACTION_ID,
        pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
        title: 'Refresh preview',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: BROWSER_CLIENT_ACTION_TARGET.artifactId,
                modulePath: BROWSER_CLIENT_ACTION_TARGET.modulePath,
                exportName: BROWSER_CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [BROWSER_CLIENT_ACTION_TARGET.platform],
        },
        serverIdentityId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId,
        materializationRef: BROWSER_CLIENT_ACTION_ORIGIN.materializationRef,
        dangerLevel: 'writesRemote',
        confirmation: {
            title: 'Confirm preview refresh',
            body: 'This action changes remote state.',
        },
        available: true,
        authorization: BROWSER_CLIENT_ACTION_AUTHORIZATION,
    });
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: BROWSER_CLIENT_ACTION_ORIGIN_PROJECTION,
    });
    const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
        contributionId: BROWSER_CLIENT_ACTION_ID,
        artifactDigest: BROWSER_CLIENT_ACTION_ARTIFACT_GRAPH.digest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: BROWSER_CLIENT_ACTION_TARGET.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectionGeneration: BROWSER_CLIENT_ACTION_GENERATION,
    });
    const pluginUiProjection = Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: BROWSER_CLIENT_ACTION_GENERATION,
        installedPackagesById: Object.freeze({
            [BROWSER_CLIENT_ACTION_PLUGIN_ID]: PluginProjectionInstalledPackageV2Schema.parse({
                id: BROWSER_CLIENT_ACTION_PLUGIN_ID,
                displayName: 'Browser client Action',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: BROWSER_CLIENT_ACTION_PLUGIN_ID },
            }),
        }),
        actionsById: Object.freeze({
            [`${BROWSER_CLIENT_ACTION_PLUGIN_ID}/${BROWSER_CLIENT_ACTION_ID}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [`reactNativeBundle:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`]: Object.freeze({
                id: `reactNativeBundle:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`,
                pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: BROWSER_CLIENT_ACTION_ID,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: BROWSER_CLIENT_ACTION_ARTIFACT_GRAPH,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity,
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: BROWSER_CLIENT_ACTION_ORIGIN_PROJECTION,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection: pluginUiProjection }),
        platform: BROWSER_CLIENT_ACTION_TARGET.platform,
    });
    const resolvedAction = resolved[0];
    if (!resolvedAction || resolved.length !== 1) {
        throw new Error('Browser client Action fixture did not resolve through the production projection.');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: resolvedAction.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = (api: PluginClientApi): void => {
        api.actions.register(BROWSER_CLIENT_ACTION_ID, handler);
    };
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'reactNativeWebModule',
        available: true,
        loadInstalledBundle: async () => activate as PluginReactNativeExecutableExport,
    });
    const activation: PluginUiClientExecutableActivation = Object.freeze({
        pluginId: resolvedAction.pluginId,
        ...(resolvedAction.pluginVersion === undefined ? {} : { pluginVersion: resolvedAction.pluginVersion }),
        contributes: resolvedAction.contributes,
        target: resolvedAction.target,
        executionOrigin: resolvedAction.executionOrigin,
        projectionGeneration: resolvedAction.projectionGeneration,
        cache,
        identity: resolvedAction.cacheIdentity,
        moduleReference: resolvedAction.moduleReference,
        backend,
        authority: resolvedAction.authority,
        isCurrent: () => true,
    });
    const pluginBrowserProjection: PluginBrowserProjectionModel = Object.freeze({
        generation: BROWSER_CLIENT_ACTION_GENERATION,
        targetsById: Object.freeze({}),
        actionsById: Object.freeze({
            [`browserAction:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`]: Object.freeze({
                id: `browserAction:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`,
                pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
                contributionKind: 'browserAction' as const,
                contributionId: BROWSER_CLIENT_ACTION_ID,
                actionIdentity: Object.freeze({
                    pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
                    localId: BROWSER_CLIENT_ACTION_ID,
                }),
                qualifiedActionId: `${BROWSER_CLIENT_ACTION_PLUGIN_ID}/${BROWSER_CLIENT_ACTION_ID}`,
                targetId: target.targetId,
                placement: 'toolbar' as const,
                display: Object.freeze({ title: 'Refresh preview', iconToken: 'browser' }),
                order: 10,
            }),
        }),
        unknownEntriesById: Object.freeze({}),
    });
    return Object.freeze({ activation, pluginUiProjection, pluginBrowserProjection });
}

beforeEach(async () => {
    pluginSurfaceAccountLifetime.reset();
    browserCurrentUiContextReader.value = null;
    browserActionModal.show.mockClear();
    browserActionModal.hide.mockClear();
    browserActionModal.confirmFallback.mockClear();
    browserActionModal.reset();
    accountEncryptionModeCredentials.value = { token: 'browser-host-account-mode-test-token' };
    accountEncryptionModeFetch.mockReset();
    accountEncryptionModeFetch.mockResolvedValue({ mode: 'plain', updatedAt: 1 });
    const { invalidateAccountEncryptionModeCache } = await import(
        '@/sync/api/account/apiAccountEncryptionMode'
    );
    invalidateAccountEncryptionModeCache();
});

describe('BrowserSurfaceHost', () => {
    it('does not read current context or enter a client Action handler when no Account lifetime is captured', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const composition = getInstalledPluginUiClientExecutableComposition();
        const currentUiContextReader: CurrentUiContextReader = Object.freeze({
            readCurrentUiContext: vi.fn((): CurrentUiContextSnapshotV1 => ({
                navigation: { area: 'app', screen: 'browser' },
                commands: [],
            })),
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn(() => () => {}),
        });
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createBrowserClientActionFixture(handler);
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        pluginSurfaceAccountLifetime.captureNone();
        browserCurrentUiContextReader.value = currentUiContextReader;
        await composition.unload();
        try {
            await expect(composition.reconcile([fixture.activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);
            const screen = await renderScreen(
                <BrowserSurfaceHost
                    browserSessionId="browser_session_default"
                    platform="web"
                    initialBrowserState={initialBrowserState}
                    policy={{
                        browserEnabled: true,
                        viewTargetsEnabled: true,
                        diagnosticsEnabled: false,
                        contextEnabled: false,
                    }}
                    localServicePreviewState={createLocalServicePreviewState()}
                    pluginUiProjection={fixture.pluginUiProjection}
                    pluginUiInteractionEnabled
                    pluginBrowserProjection={fixture.pluginBrowserProjection}
                    pluginBrowserActionContext={{
                        machineId: target.machineId,
                        serverId: 'server-1',
                        sessionId: target.sessionId,
                    }}
                    testID="browser-surface"
                />,
            );
            try {
                await screen.pressByTestIdAsync('browser-surface-overflow');
                await act(async () => {
                    await screen.pressByTestIdAsync(
                        `browser-surface-overflow-item-browserAction:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`,
                    );
                    await Promise.resolve();
                });

                expect(browserActionModal.shown()).toBe(false);
                expect(currentUiContextReader.readCurrentUiContext).not.toHaveBeenCalled();
                expect(handler).not.toHaveBeenCalled();
            } finally {
                await screen.unmount();
            }
        } finally {
            browserCurrentUiContextReader.value = null;
            await composition.unload();
        }
    });

    it('does not enter a client Action handler or read current context after its Account retires during confirmation', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const composition = getInstalledPluginUiClientExecutableComposition();
        const currentUiContextReader: CurrentUiContextReader = Object.freeze({
            readCurrentUiContext: vi.fn((): CurrentUiContextSnapshotV1 => ({
                navigation: { area: 'app', screen: 'browser' },
                commands: [],
            })),
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn(() => () => {}),
        });
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createBrowserClientActionFixture(handler);
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        browserCurrentUiContextReader.value = currentUiContextReader;
        await composition.unload();
        try {
            await expect(composition.reconcile([fixture.activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);
            const screen = await renderScreen(
                <BrowserSurfaceHost
                    browserSessionId="browser_session_default"
                    platform="web"
                    initialBrowserState={initialBrowserState}
                    policy={{
                        browserEnabled: true,
                        viewTargetsEnabled: true,
                        diagnosticsEnabled: false,
                        contextEnabled: false,
                    }}
                    localServicePreviewState={createLocalServicePreviewState()}
                    pluginUiProjection={fixture.pluginUiProjection}
                    pluginUiInteractionEnabled
                    pluginBrowserProjection={fixture.pluginBrowserProjection}
                    pluginBrowserActionContext={{
                        machineId: target.machineId,
                        serverId: 'server-1',
                        sessionId: target.sessionId,
                    }}
                    testID="browser-surface"
                />,
            );
            try {
                await screen.pressByTestIdAsync('browser-surface-overflow');
                await screen.pressByTestIdAsync(
                    `browser-surface-overflow-item-browserAction:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`,
                );
                await vi.waitFor(() => {
                    expect(browserActionModal.shown()).toBe(true);
                });
                expect(currentUiContextReader.readCurrentUiContext).not.toHaveBeenCalled();
                expect(handler).not.toHaveBeenCalled();

                // Account A owns this Browser projection and action attempt.
                // Retiring it leaves the same machine/generation visible only
                // long enough to prove the late confirmation cannot execute.
                pluginSurfaceAccountLifetime.retire();
                await act(async () => {
                    browserActionModal.confirm();
                    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
                });

                expect(currentUiContextReader.readCurrentUiContext).not.toHaveBeenCalled();
                expect(handler).not.toHaveBeenCalled();
            } finally {
                await screen.unmount();
            }
        } finally {
            browserCurrentUiContextReader.value = null;
            await composition.unload();
        }
    });

    it('renders a typed unavailable state before mounting shell chrome when browser policy is disabled', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: false,
                    viewTargetsEnabled: false,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-unavailable-disabled')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-address')).toBeNull();
    });

    it('keeps diagnostics projections unavailable when the diagnostics policy is disabled', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                supplementalDiagnostics={previewDiagnostics}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-address')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-supplemental-diagnostics')).toBeNull();
    });

    it('does not mount the injected diagnostics drawer for local-preview web iframes without a supported producer', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: true,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                testID="browser-surface"
            />,
        );

        // Web local previews do not have a production collector-injection path; the supported
        // fidelity for this adapter/engine is previewProxy supplemental diagnostics, not a fake
        // injected drawer that can only render "Unavailable".
        expect(screen.findByTestId('browser-surface-diagnostics')).toBeNull();
    });

    it('renders preview-proxy diagnostics for local-preview web iframes without a competing injected drawer', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: true,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                supplementalDiagnostics={previewDiagnostics}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-diagnostics')).toBeNull();
        expect(screen.findByTestId('browser-surface-supplemental-diagnostics')).not.toBeNull();
    });

    it('passes browser recording state into the reusable shell chrome', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { createBrowserRecordingState } = await import('@/sync/domains/browser/recording');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    recordingEnabled: true,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                browserRecording={{
                    state: createBrowserRecordingState(),
                    recordingCapabilities,
                    enabled: true,
                    nowMs: () => 10_000,
                }}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-recording-start')).not.toBeNull();
    });

    it('fails closed for browser recording when the recording policy is not explicitly enabled', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { createBrowserRecordingState } = await import('@/sync/domains/browser/recording');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                browserRecording={{
                    state: createBrowserRecordingState(),
                    recordingCapabilities,
                    enabled: true,
                    nowMs: () => 10_000,
                }}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-address')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-recording-start')).toBeNull();
    });

    it('reports lifecycle against the logical browser view instead of the presentation slot', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const lifecycleSpy = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                presentationSlotId="details:primary"
                visible
                active
                measuredRect={{ x: 0, y: 0, width: 800, height: 600 }}
                localServicePreviewState={createLocalServicePreviewState()}
                onLifecycleChange={lifecycleSpy}
                testID="browser-surface"
            />,
        );

        expect(lifecycleSpy).toHaveBeenCalledWith(expect.objectContaining({
            logicalViewId: 'browser_view:preview_1',
            lifecycleState: 'visible',
            slotsById: expect.objectContaining({
                'details:primary': expect.objectContaining({
                    presentationSlotId: 'details:primary',
                    visible: true,
                    active: true,
                }),
            }),
        }));
    });

    it('reconciles lifecycle from the previous host snapshot when a presentation slot disappears', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const lifecycleSpy = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });
        const renderHost = (presentationSlotId?: string) => (
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                surfaceKey="preview_1"
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                presentationSlotId={presentationSlotId}
                visible={presentationSlotId != null}
                active={presentationSlotId != null}
                measuredRect={presentationSlotId ? { x: 0, y: 0, width: 800, height: 600 } : null}
                localServicePreviewState={createLocalServicePreviewState()}
                onLifecycleChange={lifecycleSpy}
                testID="browser-surface"
            />
        );

        const screen = await renderScreen(renderHost('details:primary'));
        await screen.update(renderHost(undefined));

        expect(lifecycleSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            logicalViewId: 'browser_view:preview_1',
            lifecycleState: 'orphaned',
            cleanupReason: null,
            slotsById: expect.objectContaining({
                'details:primary': expect.objectContaining({
                    presentationSlotId: 'details:primary',
                    visible: false,
                    active: false,
                    measuredRect: { x: 0, y: 0, width: 800, height: 600 },
                }),
            }),
        }));
    });

    it('routes client-local navigation and reload effects into the active frame host', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                testID="browser-surface"
            />,
        );

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/');

        // B-2: a URL-bearing open seeds `loading` (cause-1), so the toolbar shows Stop until the
        // engine reports load-end. Firing the iframe `onLoad` feeds the lifecycle back through the
        // host's `applyBrowserControlEvent` (cause-2), transitioning the view to `ready` and
        // surfacing the reload affordance — proving the engine→reducer wiring end-to-end.
        expect(screen.findByTestId('browser-surface-reload')).toBeNull();
        await act(async () => {
            screen.findByType('iframe').props.onLoad?.();
        });
        expect(screen.findByTestId('browser-surface-reload')).not.toBeNull();

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-reload');
        });

        expect(screen.findByType('iframe').props['data-browser-navigation-key']).toEqual(
            expect.stringContaining('browser_command:browser_view:preview_1:reload:'),
        );

        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://preview.happier.test/dashboard');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');
    });

    it('retargets the active local-preview view when typed navigation resolves to an external URL target', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const onViewTargetChange = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                productModels={{
                    browserProfile: {
                        profile: sessionBrowserProfile,
                        activePermissionGrantCount: 0,
                    },
                }}
                browserFeatureDecision={enabledBrowserDecision}
                onViewTargetChange={onViewTargetChange}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-view-frame-external-escape')).toBeNull();

        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://example.com/');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        expect(screen.findByType('iframe').props.src).toBe('https://example.com/');
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('example.com');
        expect(screen.findByTestId('browser-surface-view-frame-external-escape')).not.toBeNull();
        expect(onViewTargetChange).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_default',
            viewId: 'browser_view:preview_1',
            target: expect.objectContaining({
                kind: 'externalUrl',
                url: 'https://example.com/',
            }),
        });
    });

    it('preserves local browser state across parent refreshes with the same surface key', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const localServicePreviewState = createLocalServicePreviewState();
        const renderHost = (initialUrl: string) => (
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={openBrowserTarget(createBrowserViewState(), target, {
                    platform: 'web',
                    currentUrl: initialUrl,
                })}
                surfaceKey="preview_1"
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={localServicePreviewState}
                testID="browser-surface"
            />
        );

        const screen = await renderScreen(renderHost('https://preview.happier.test/'));

        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://preview.happier.test/dashboard');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');

        await screen.update(renderHost('https://preview.happier.test/refreshed'));

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');
    });

    it('renders browser panel plugin placements for the active browser target', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });
        const localServicePreviewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
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

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={localServicePreviewState}
                pluginUiProjection={hostedWebBrowserPanelProjection}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-plugin-placement-surfacePlacement:acme.browser:panel')).not.toBeNull();
        expect(screen.findAllByType('iframe').some((frame) => {
            const src = String(frame.props.src ?? '');
            return src.startsWith('https://preview.happier.test/plugin/acme/')
                && src.includes('happierBridgeNonce=');
        })).toBe(true);
    });

    it('does not mount browser panel plugin placements without an active browser target', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={createBrowserViewState()}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                localServicePreviewState={createLocalServicePreviewState()}
                pluginUiProjection={hostedWebBrowserPanelProjection}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-plugin-placement-surfacePlacement:acme.browser:panel')).toBeNull();
    });

    it('opens launchpad targets through the reusable host when no external opener is supplied', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const onViewTargetChange = vi.fn();
        const launchpadRows = [{
            id: 'localService:preview_1',
            section: 'running',
            sourceKind: 'localService',
            title: 'Preview',
            subtitle: 'localhost:5173',
            detail: 'vite',
            target,
            currentUrl: 'https://preview.happier.test/',
            disabledReason: null,
            lastSeenAt: 100,
        }] as const;

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={createBrowserViewState()}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                launchpadRows={launchpadRows}
                localServicePreviewState={createLocalServicePreviewState()}
                onViewTargetChange={onViewTargetChange}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-launchpad-card:localService:preview_1-available')).not.toBeNull();

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-launchpad-card:localService:preview_1');
        });

        expect(screen.findByTestId('browser-surface-launchpad')).toBeNull();
        // Blurred address field shows the pretty display URL (scheme/trailing-slash trimmed).
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('preview.happier.test');
        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/');
        expect(onViewTargetChange).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_default',
            viewId: 'browser_view:preview_1',
            target,
        });
    });

    it('opens desktop external URL launchpad rows through the reusable host with policy and native WebView context', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const launchpadRows = [{
            id: 'recent:external_docs',
            section: 'recent',
            sourceKind: 'recent',
            title: 'Docs',
            subtitle: 'docs.happier.test',
            detail: 'externalUrl',
            target: externalTarget,
            disabledReason: null,
            lastSeenAt: 100,
        }] as const;

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="desktop"
                initialBrowserState={createBrowserViewState()}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                launchpadRows={launchpadRows}
                productModels={{
                    browserProfile: {
                        profile: sessionBrowserProfile,
                        activePermissionGrantCount: 0,
                    },
                }}
                browserFeatureDecision={enabledBrowserDecision}
                desktopWebViewAvailability={availableDesktopWebView}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-launchpad-card:recent:external_docs-available')).not.toBeNull();

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-launchpad-card:recent:external_docs');
        });

        expect(screen.findByTestId('browser-surface-launchpad')).toBeNull();
        expect(screen.findByTestId('browser-surface-view-frame')).not.toBeNull();
        // Blurred address field shows the pretty display URL (scheme/trailing-slash trimmed).
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('docs.happier.test');
    });

    it('routes annotation Select through the diagnostics element picker for the active surface view', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const {
            createBrowserContextState,
            startBrowserAnnotationMode,
        } = await import('@/sync/domains/browser/context');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            browserSessionId: 'browser_session_default',
            platform: 'desktop',
            currentUrl: 'https://docs.happier.test/',
            targetPolicyDecision: allowedExternalPolicy,
            desktopWebViewAvailability: annotationDesktopWebView,
        });
        const activeView = Object.values(initialBrowserState.viewsById)[0];
        expect(activeView).toBeDefined();
        if (!activeView) return;
        const started = startBrowserAnnotationMode(createBrowserContextState(), {
            browserContextEnabled: true,
            attachmentsUploadsEnabled: true,
            contextCapabilities: annotationContextCapabilities,
            adapterCapabilities: {
                ...activeView.adapterCapabilities,
                diagnosticsFidelityByFamily: {
                    ...activeView.adapterCapabilities.diagnosticsFidelityByFamily,
                    screenshot: 'injectedPage',
                },
                contextKinds: ['browserPageReference', 'browserAnnotation'],
            },
            browserSessionId: activeView.browserSessionId,
            viewId: activeView.viewId,
            navigationGeneration: activeView.navigationGeneration,
            startedAtMs: 10_000,
        });
        expect(started.status).toBe('started');
        if (started.status !== 'started') return;
        const onStartElementPicker = vi.fn();

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="desktop"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: true,
                    contextEnabled: true,
                }}
                productModels={{
                    browserContext: {
                        state: started.state,
                        contextCapabilities: annotationContextCapabilities,
                        attachmentsUploadsEnabled: true,
                        onStateChange: vi.fn(),
                        nowMs: () => 10_100,
                    },
                    browserDiagnostics: {
                        state: createBrowserDiagnosticsUiStore(),
                        requestEval: vi.fn(() => false),
                        requestGetProperties: vi.fn(() => false),
                        requestReleaseObjectGroup: vi.fn(() => false),
                        interaction: {
                            state: 'enabled',
                            ownerOnly: true,
                            pickerState: 'idle',
                            onStartElementPicker,
                        },
                    },
                    browserProfile: {
                        profile: sessionBrowserProfile,
                        activePermissionGrantCount: 0,
                    },
                }}
                browserFeatureDecision={enabledBrowserDecision}
                desktopWebViewAvailability={annotationDesktopWebView}
                testID="browser-surface"
            />,
        );

        expect(screen.findByTestId('browser-surface-annotation-editor-tool-select')?.props.disabled).toBe(false);
        screen.findByType(AnnotationCaptureSurface).props.onPick({ x: 18, y: 24 });

        expect(onStartElementPicker).toHaveBeenCalledTimes(1);
    });

    it('keeps the address field editable and navigates the active desktop view in place (no new tab)', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const launchpadRows = [{
            id: 'recent:external_docs',
            section: 'recent',
            sourceKind: 'recent',
            title: 'Docs',
            subtitle: 'docs.happier.test',
            detail: 'externalUrl',
            target: externalTarget,
            disabledReason: null,
            lastSeenAt: 100,
        }] as const;

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="desktop"
                initialBrowserState={createBrowserViewState()}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                launchpadRows={launchpadRows}
                productModels={{
                    browserProfile: {
                        profile: sessionBrowserProfile,
                        activePermissionGrantCount: 0,
                    },
                }}
                browserFeatureDecision={enabledBrowserDecision}
                desktopWebViewAvailability={availableDesktopWebView}
                testID="browser-surface"
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-launchpad-card:recent:external_docs');
        });

        // Symptom 2: the address field is editable once a navigable view is mounted.
        const addressField = screen.findByTestId('browser-surface-address');
        expect(addressField).not.toBeNull();
        expect(addressField?.props.editable).toBe(true);

        // Symptom 3: submitting a URL from WITHIN the active view navigates that same view in place
        // (no second view/tab is opened, the launchpad does not reappear).
        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://docs.happier.test/changelog');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        // The launchpad does not reappear (we stayed in the same mounted view), and the address
        // field reflects the in-place navigation target rather than spawning a fresh launchpad tab.
        // (Blurred after submit, so it shows the pretty display URL — scheme/trailing-slash trimmed.)
        expect(screen.findByTestId('browser-surface-launchpad')).toBeNull();
        expect(screen.findByTestId('browser-surface-view-frame')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('docs.happier.test/changelog');
    });
});
