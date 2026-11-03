import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import * as React from 'react';
import {
    type BrowserContextCapabilities,
    type BrowserRecordingCapabilities,
    type BrowserTargetPolicyDecisionV1,
    type FeatureDecision,
    DaemonPluginActionSchemasReadRequestSchema,
    DaemonPluginActionSchemasReadResponseSchema,
    RPC_METHODS,
    type DaemonLocalServicePreviewOpenOrCreateResponseV1,
    type LocalServicePreviewResourceV1,
    buildQualifiedPluginContributionKey,
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    PluginMachineMaterializationExecutionOriginV1Schema,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    normalizePluginUiDestinationBindingV1,
    PluginUiArtifactsManifestEntryV2Schema,
    type CurrentUiContextSnapshotV1,
} from '@happier-dev/protocol/plugins/ui';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    type PluginUiClientExecutableActivation,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { reactNativeWebAppState as browserAppState } from '@/dev/testkit/mocks/reactNative';
import {
    createBrowserViewState,
    openBrowserTarget,
} from '@/sync/domains/browser/store';
import { createBrowserDiagnosticsUiStore } from '@/sync/domains/browser/diagnostics';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import { executePluginBrowserAction, type PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildCooperativeNavigationRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';

// The visibility owner installs one app-lifetime watch. Keep one OS emitter for
// the whole suite so eager executor imports cannot bind it to a discarded stub.

// Static Browser imports reach Socket consumers before the route harness loads.
// Register the canonical network boundary hoisted, then let the harness configure it.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installTerminalRouteCommonModuleMocks();

const actionModuleLoader = vi.hoisted(() => ({
    createDefaultExecutor: null as typeof import('@/sync/ops/actions/defaultActionExecutor').createDefaultActionExecutor | null,
}));
const browserSystemOpen = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: browserSystemOpen }));
// Metro's lazy require is a module-loading boundary absent in Vitest. Inject the
// actual executor through the existing port; policy and Browser owners stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...actual, createFrontDoorActionExecute: (
        executor?: Parameters<typeof actual.createFrontDoorActionExecute>[0],
        options?: Parameters<typeof actual.createFrontDoorActionExecute>[1],
    ) => actual.createFrontDoorActionExecute(executor ?? actionModuleLoader.createDefaultExecutor?.(options), options) };
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/browser/frame/engines/DesktopWebViewEngine', () => ({
    DesktopWebViewEngine: (props: Readonly<Record<string, unknown>>) => React.createElement('View', {
        testID: props.testID ?? 'desktop-webview',
        lifecycleState: props.lifecycleState,
    }),
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
const browserStreamBoundary = vi.hoisted(() => ({
    views: [] as unknown[],
    listeners: new Set<(raw: unknown) => void>(),
}));
const browserPreviewBoundary = vi.hoisted(() => ({
    response: null as DaemonLocalServicePreviewOpenOrCreateResponseV1 | null,
}));
let browserFeatures: ReturnType<typeof createRootLayoutFeaturesResponse> | null = null;

// Discovery and relay socket are genuine network boundaries; host/runtime/ingestion stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string; machineId: string; serverId?: string | null; payload: unknown }) => {
        if (input.method === 'daemon.browser.view.list') return { protocolVersion: 1, views: browserStreamBoundary.views };
        if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE
            && (input.payload as { launchTargetId?: string } | undefined)?.launchTargetId === 'preview_1'
            && browserPreviewBoundary.response) return browserPreviewBoundary.response;
        if (input.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            expect(input.machineId).toBe('machine_1');
            expect(input.serverId).toBe('srv_browser_client_action');
            const request = DaemonPluginActionSchemasReadRequestSchema.parse(input.payload);
            expect(request).toEqual({ machineId: 'machine_1', expectedOccurrenceId: 'occurrence-browser-client-action',
                qualifiedActionId: 'acme.browser-client-action/refresh-preview' });
            return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true, inputSchema: { type: 'object' } });
        }
        throw new Error('offline');
    },
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket', () => ({
    resolveServerScopedMachineLiveStreamRelaySocket: async () => ({
        machineId: 'machine_1', viewerId: 'viewer_1', socketId: 'tab_1',
        onSocketIdChange: () => () => {},
        sendEnvelope: () => {},
        onEnvelope: (listener: (raw: unknown) => void) => {
            browserStreamBoundary.listeners.add(listener);
            return () => browserStreamBoundary.listeners.delete(listener);
        },
        disconnect: async () => undefined,
    }),
}));

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

await initializeTerminalRouteRuntimeForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
actionModuleLoader.createDefaultExecutor = createDefaultActionExecutor;
const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');

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
    occurrenceId: 'acme-browser-occurrence-current',
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
    // A daemon-projected renderer has an installed occurrence and source
    // custody. Keep the real mounted-context owner responsible for admission.
    installedPackagesById: {
        'acme.browser': PluginProjectionInstalledPackageV2Schema.parse({
            id: 'acme.browser', displayName: 'Browser panel', version: '1.0.0', enabled: true,
            source: { kind: 'localPath', locator: 'acme.browser' },
            occurrenceId: browserPanelPlacement.occurrenceId,
            sourceCustody: { kind: 'development', registeredRootId: 'browser-panel-root' },
            declaresContributionPoints: false,
        }),
    },
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            occurrenceId: browserPanelPlacement.occurrenceId,
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
    exportName: 'execute',
    platform: 'web' as const,
});
const BROWSER_CLIENT_ACTION_ORIGIN = Object.freeze(PluginMachineMaterializationExecutionOriginV1Schema.parse({
    serverIdentityId: 'srv_browser_client_action',
    materializationRef: Object.freeze({
        pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
        machineId: target.machineId,
        materializationId: 'materialization-browser-client-action',
    }),
}));
const BROWSER_CLIENT_ACTION_ORIGIN_PROJECTION = Object.freeze({
    machineId: target.machineId,
    serverId: 'srv_browser_client_action',
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: BROWSER_CLIENT_ACTION_ORIGIN,
});
const BROWSER_CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    generation: Object.freeze({
        targetGeneration: 'occurrence-browser-client-action',
        desiredGeneration: 'occurrence-browser-client-action',
        appliedGeneration: 'occurrence-browser-client-action',
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});
const BROWSER_CLIENT_ACTION_ARTIFACT_GRAPH = PluginUiArtifactsManifestEntryV2Schema.parse({
    artifactId: BROWSER_CLIENT_ACTION_TARGET.artifactId,
    tier: 'reactNative',
    entry: 'react-native/browser-client-action-bundle/entry.cjs.bundle',
    files: [{
        relativePath: 'react-native/browser-client-action-bundle/entry.cjs.bundle',
        digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        byteSize: 10,
    }],
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    builtWith: { bundler: 'esbuild', version: '0.27.2' },
    executable: { exports: [BROWSER_CLIENT_ACTION_TARGET.exportName] },
    hostUiApiRange: '^1.0.0',
});

function createBrowserClientActionFixture(handler: PluginClientActionHandler): Readonly<{
    activation: PluginUiClientExecutableActivation;
    pluginUiProjection: PluginUiProjectionModel;
    pluginBrowserProjection: PluginBrowserProjectionModel;
}> {
    const action = PluginProjectedActionV2Schema.parse({
        id: BROWSER_CLIENT_ACTION_ID,
        pluginId: BROWSER_CLIENT_ACTION_PLUGIN_ID,
        occurrenceId: 'occurrence-browser-client-action',
        title: 'Refresh preview',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: BROWSER_CLIENT_ACTION_TARGET.artifactId,
                exportName: BROWSER_CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [BROWSER_CLIENT_ACTION_TARGET.platform],
        },
        executionOrigin: BROWSER_CLIENT_ACTION_ORIGIN,
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
                    cacheIdentity: Object.freeze({
                        artifactDigest: BROWSER_CLIENT_ACTION_ARTIFACT_GRAPH.digest,
                    }),
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
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: async () => activate,
    });
    const activation: PluginUiClientExecutableActivation = Object.freeze({
        pluginId: resolvedAction.pluginId,
        ...(resolvedAction.pluginVersion === undefined ? {} : { pluginVersion: resolvedAction.pluginVersion }),
        hostUiApiRange: resolvedAction.artifactGraph.hostUiApiRange,
        contributes: resolvedAction.contributes,
        target: resolvedAction.target,
        executionOrigin: resolvedAction.executionOrigin,
        occurrenceId: resolvedAction.occurrenceId,
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

let browserAccountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreBrowserStorage: (() => void) | undefined;
let restoreBrowserLocks: (() => void) | undefined;
let browserPanelPane: AppPaneScopeApi | undefined;
function BrowserPanelPaneProbe() {
    browserPanelPane = useAppPaneScope('browser-panels:browser_session_default');
    return null;
}
let browserRuntime: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let browserPortalBoundary: ReturnType<typeof installReactDomPortalBoundaryForTests>;
beforeEach(async () => {
    browserRuntime = await installBrowserRuntimeForTests({ url: 'https://browser-host.example.test/' });
    browserPortalBoundary = installReactDomPortalBoundaryForTests();
    browserPanelPane = undefined;
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyLocalSettings({ appPaneScopesV1: {} });
    if (browserAppState.appState.currentState !== 'active') browserAppState.emit('active');
    browserSystemOpen.mockClear();
    browserPreviewBoundary.response = null;
    browserFeatures = null;
    browserActionModal.show.mockClear();
    browserActionModal.hide.mockClear();
    browserActionModal.confirmFallback.mockClear();
    browserActionModal.reset();
    const { invalidateAccountEncryptionModeCache } = await import(
        '@/sync/api/account/apiAccountEncryptionMode'
    );
    invalidateAccountEncryptionModeCache();
    restoreBrowserStorage = installLocalStorageMock().restore;
    restoreBrowserLocks = installWebLockManagerMock().restore;
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async () => new Response('{}', { status: 404 }));
    const serverUrl = 'https://browser-host.example.test';
    await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
    }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    browserAccountConnection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-1', configureSocket: configureConnectedServerSocketBoundary, request: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/features' && browserFeatures) return Response.json(browserFeatures);
        if (path === '/v1/local-services/preview/preview_1/access' && browserFeatures) {
            const { LocalServicePreviewServerAccessV1Schema } = await import('@happier-dev/protocol/local/services/preview/nativeDirect');
            return Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                previewId: 'preview_1', machineId: 'machine_1', accessUrl: 'https://preview.happier.test/', expiresAt: Date.now() + 60_000 }));
        }
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        return new Response('{}', { status: 404 });
    } });
    expect(getActiveServerAccountScope()).toEqual({ serverId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId, accountId: 'account-1' });
});

afterEach(async () => {
    await standardCleanup();
    await browserAccountConnection?.dispose();
    browserAccountConnection = undefined;
    restoreBrowserLocks?.();
    restoreBrowserStorage?.();
    browserPortalBoundary.restore();
    browserRuntime.restore();
});

describe('BrowserSurfaceHost', () => {
it('explains a refused iframe collector in Diagnostics while keeping its engine bridge attached', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'collector-token' });
        const browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.test/' });
        const portal = installReactDomPortalBoundaryForTests();
        const frame = { postMessage: vi.fn() };
        Object.defineProperty(frame, 'document', { get: () => { throw new DOMException('Cross origin', 'SecurityError'); } });
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), {
            kind: 'externalUrl', targetId: 'external', url: 'https://external.example.test/',
        }, { platform: 'web', currentUrl: 'https://external.example.test/' });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform="web"
            initialBrowserState={initialBrowserState}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: true, contextEnabled: false }}
            testID="iframe-diagnostics" />, { createNodeMock: node => node.type === 'iframe' ? { contentWindow: frame } : null });
        try {
            const { BrowserShell } = await import('@/components/browser/BrowserShell');
            expect(screen.findByType(BrowserShell).props.browserDiagnostics?.bridge).toBeTruthy();
            await act(async () => screen.findByType('iframe').props.onLoad());
            expect(screen.findByType(BrowserShell).props.browserDiagnostics).toMatchObject({
                bridge: expect.any(Object),
                diagnosticsAvailability: { status: 'unavailable', reasonCode: 'cross_origin_frame_unavailable' },
            });
            await screen.pressByTestIdAsync('iframe-diagnostics-overflow');
            await screen.pressByTestIdAsync('iframe-diagnostics-overflow-item-open-diagnostics');
            expect(screen.getTextContent()).toContain('browserDiagnostics.host.devtools.unavailable.directPage');
        } finally {
            await screen.unmount();
            portal.restore();
            browser.restore();
        }
    });

    it('persists the relay document title and location without admission or reloading the frame, and restores after remount', async () => {
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const { createBrowserViewDetailsTab } = await import('./browserSurfaceDetailsTabModel');
        const { DetailsTabStrip } = await import('@/components/appShell/panes/details/workspace/DetailsTabStrip');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { JSDOM } = await import('jsdom');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
            diagnostics: { enabled: true }, automation: { enabled: true },
        } } });
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const host = Object.assign(new EventTarget(), {
            location: { origin: 'https://browser-host.example.test' },
            postMessage: (data: string) => {
                const event = new Event('message');
                Object.defineProperties(event, { data: { value: data }, origin: { value: 'https://preview.happier.test' }, source: { value: frame } });
                host.dispatchEvent(event);
            },
        });
        vi.stubGlobal('window', host);
        // Shared tests can carry desktop bridge globals. This scenario is the ordinary web
        // renderer, whose platform owner must see browser boundary facts.
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.stubGlobal('__TAURI__', undefined);
        vi.stubGlobal('isTauri', false);
        expect((await import('@/utils/platform/desktopHost')).isDesktopHost()).toBe(false);
        const dom = new JSDOM('<!doctype html><title>Sign in</title><body></body>', { url: 'https://preview.happier.test/' });
        const frame = dom.window;
        Object.defineProperty(frame, 'parent', { value: host });
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 100, refreshState: 'idle', diagnostics: [], previews: [{
                previewId: 'preview_1', accessUrl: 'https://preview.happier.test/', expiresAt: null, diagnostics: [], resource: {
                    previewId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1', owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: 'localhost', port: 5173 }, initialPath: { pathname: '/', search: '' },
                    display: { title: 'Preview', addressLabel: 'localhost:5173' }, originMode: 'host', browserTarget: target,
                },
            }],
        });
        const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web', keepAliveAboveRouter: false,
            localServicePreviewState: previewState, browserFeatureDecision: enabledBrowserDecision });
        let pane: AppPaneScopeApi | undefined;
        const tab = createBrowserViewDetailsTab({ target, browserSessionId: 'relay-title' });
        function Workspace() {
            pane = useAppPaneScope('relay-title');
            const group = pane.scopeState?.details.groups?.[0];
            const current = group?.tabs[0];
            return <>{group ? <DetailsTabStrip pane={pane} group={group} testIds={{ tab: () => 'relay-document-tab' }} /> : null}
                {current ? renderer.render({ tab: current, descriptor: { surfaceId: 'relay-title', resourceKey: 'relay-title',
                    scope: { kind: 'global' }, region: 'details', status: 'available' }, scope: { kind: 'global' },
                    region: 'details', active: true, callbacks: { replaceTab: pane.replaceDetailsTab } }) : null}</>;
        }
        let screen = await renderScreen(<AppPaneProvider><Workspace /></AppPaneProvider>, {
            createNodeMock: node => node.type === 'iframe' ? { contentWindow: frame } : null,
        });
        try {
            await act(async () => { pane!.openDetailsTab(tab, { intent: 'pinned' }); });
            await vi.waitFor(() => expect(screen.findAllByType('iframe'), screen.findAll(node =>
                typeof node.props.testID === 'string').map(node => node.props.testID).slice(-20).join(',')).toHaveLength(1));
            const iframe = screen.findByType('iframe');
            const initialSrc = iframe.props.src;
            const config = new URL(iframe.props.src).searchParams.get('__happierCollector');
            expect(config).not.toBeNull();
            const tabLabel = () => screen.findByTestId('relay-document-tab')!.findAll(node =>
                typeof node.props.children === 'string').map(node => node.props.children).join('');
            expect(tabLabel()).toContain('Preview');
            await act(async () => { new Function('window', 'document', buildCooperativeNavigationRuntimeScript(config!))(frame, frame.document); });
            expect(tabLabel()).toContain('Sign in');
            // Page JS changes the title after load, without a navigation or synthetic load signal.
            await act(async () => { frame.document.title = 'Projects'; await new Promise(resolve => setImmediate(resolve)); });
            expect(tabLabel()).toContain('Projects');
            await act(async () => {
                frame.history.pushState({}, '', '/details?qa93=1&previewToken=one-use#section');
                // JSDOM has no Navigation API; pageshow exercises the same real document reporter.
                frame.dispatchEvent(new dom.window.Event('pageshow'));
            });
            expect(pane!.scopeState?.details.tabs[0].resource).toMatchObject({ currentUrl: '/details?qa93=1#section' });
            expect(JSON.stringify(pane!.scopeState?.details)).not.toContain('one-use');
            await act(async () => { screen.findByType('iframe').props.onLoad(); });
            expect(pane!.scopeState?.details.tabs[0].resource).toMatchObject({ currentUrl: '/details?qa93=1#section' });
            const binding = JSON.parse(config!);
            await act(async () => { host.postMessage(JSON.stringify({
                v: 1, kind: 'browser.collector.navigation', browserSessionId: binding.browserSessionId,
                navigationGeneration: binding.navigationGeneration,
                collectorId: binding.collector.collectorId, nonce: binding.collector.nonce,
                viewId: 'another-view', loading: false, canGoBack: false, canGoForward: false,
                url: frame.location.href, title: 'Stale view',
            })); });
            expect(tabLabel()).toContain('Projects');
            expect(screen.findByType('iframe')).toBe(iframe);
            expect(screen.findByType('iframe').props.src).toBe(initialSrc);
            expect(pane!.scopeState?.details.tabs).toHaveLength(1);
            expect(pane!.scopeState?.details.tabs[0].key).toBe(tab.key);
            await screen.unmount();
            screen = await renderScreen(<AppPaneProvider><Workspace /></AppPaneProvider>, {
                createNodeMock: node => node.type === 'iframe' ? { contentWindow: frame } : null,
            });
            await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
            const restored = new URL(screen.findByType('iframe').props.src);
            expect(restored.pathname + restored.searchParams.get('qa93') + restored.hash).toBe('/details1#section');
        } finally { await screen.unmount(); dom.window.close(); vi.unstubAllGlobals(); }
    });

    it.each([false, true])('retries the failing launchpad catalog through its shared preview owner (caller snapshot=%s)', async (callerSnapshot) => {
        const { useBrowserSurfaceHostProps } = await import('./useBrowserSurfaceHostProps');
        const { useLocalServicePreviewState } = await import('@/sync/domains/local/services/preview/useLocalServicePreviewState');
        const { createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
        const { resetLocalServicePreviewStoreForTests } = await import('@/sync/domains/local/services/preview/sharedStore');
        const launcherState = createLocalServiceLauncherState();
        let recovered = false;
        const requests: Array<Readonly<{ machineId: string; serverId?: string | null }>> = [];
        const snapshotClient: import('@/sync/domains/local/services/preview/useLocalServicePreviewState').LocalServicePreviewSnapshotClient = async (input) => {
            requests.push(input);
            return recovered
                ? { ok: true, snapshot: { generatedAt: 1_000, refreshState: 'idle', previews: [], diagnostics: [] } }
                : { ok: false, reason: 'request_failed' };
        };
        function LaunchpadHost() {
            const callerPreviewState = useLocalServicePreviewState({ machineId: 'machine_catalog_retry',
                serverId: 'home_catalog_retry', snapshotClient, enabled: callerSnapshot });
            const props = useBrowserSurfaceHostProps({ scope: 'sessionDetails', sessionId: 'catalog_retry',
                machineId: 'machine_catalog_retry', serverId: 'home_catalog_retry', launcherState,
                localServicePreviewState: callerSnapshot ? callerPreviewState : undefined,
                localServicePreviewSnapshotClient: snapshotClient });
            return <BrowserSurfaceHost {...props} keepAliveAboveRouter={false} testID="catalog-retry"
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false, automationEnabled: false }} />;
        }
        resetLocalServicePreviewStoreForTests();
        const screen = await renderScreen(<LaunchpadHost />);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('catalog-retry-launchpad-error')).toBeTruthy();
            recovered = true;
            await screen.pressByTestIdAsync('catalog-retry-launchpad-error-action');
            await flushHookEffects();
            expect(requests).toHaveLength(2);
            expect(requests.every((request) => request.machineId === 'machine_catalog_retry' && request.serverId === 'home_catalog_retry')).toBe(true);
            expect(screen.findByTestId('catalog-retry-launchpad-error')).toBeNull();
            expect(screen.findByTestId('catalog-retry-launchpad-guidance')).toBeTruthy();
        } finally {
            await screen.unmount();
            resetLocalServicePreviewStoreForTests();
        }
    });
    it('settles Browser navigation facts through the real retained binder and keeps reload current', async () => {
        const { RetainedPresentationSlotBinder, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
        const { SessionViewerControllerProvider } = await import('@/components/sessions/viewer/SessionViewerControllerProvider');
        const { SessionViewerBodyPresentation, useOptionalSessionViewerController } = await import('@/components/sessions/viewer/SessionViewerController');
        const { createBrowserAutomationControlService } = await import('@/sync/domains/browser/automation');
        const browserAutomation = { controlService: createBrowserAutomationControlService({ nowMs: Date.now }) };
        let controller: ReturnType<typeof useOptionalSessionViewerController> = null;
        function Probe() { controller = useOptionalSessionViewerController(); return null; }
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            platform: 'web', currentUrl: externalTarget.url,
        });
        // React's passive-effect loop can starve Vitest's timeout while act drains commits. Bound
        // only this test's runaway renderer so the real feedback cycle reports a finite RED.
        let commits = 0;
        const onRender = () => {
            if (++commits > 100) throw new Error('Retained Browser source facts never settle');
        };
        const render = (visible: boolean) => <React.Profiler id="retained-browser" onRender={onRender}>
            <SessionViewerControllerProvider sessionId="session_1" serverId={null}
                phone canPresentSource={() => true} openDocked={() => {}}>
                <Probe />
                <RetainedPresentationSlotsProvider>
                    <RetainedPresentationSlotBinder slotId="phone-browser" visible={visible} enabled
                        windowGeometry={{ x: 16, y: 145, width: 358, height: 272 }}>
                        <SessionViewerBodyPresentation presentation="viewer">
                            <BrowserSurfaceHost browserSessionId="browser_session_default" platform="web"
                                initialBrowserState={initialBrowserState} keepAliveAboveRouter={false}
                                browserAutomation={browserAutomation}
                                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false, automationEnabled: true }} />
                        </SessionViewerBodyPresentation>
                    </RetainedPresentationSlotBinder>
                </RetainedPresentationSlotsProvider>
            </SessionViewerControllerProvider>
        </React.Profiler>;
        const screen = await renderScreen(render(true));
        const readController = () => { if (!controller) throw new Error('Missing viewer owner'); return controller; };
        try {
            await act(async () => { screen.findByType('iframe').props.onLoad?.(); });
            expect(readController().facts.browser?.navigation?.reload).toBeTypeOf('function');
            const page = screen.findByType('iframe');
            const navigation = readController().facts.browser?.navigation;
            await screen.update(render(false));
            await screen.update(render(true));
            expect(screen.findByType('iframe')).toBe(page);
            expect(readController().facts.browser?.navigation).toBe(navigation);
            const key = screen.findByType('iframe').props['data-browser-navigation-key'];
            await act(async () => { await readController().facts.browser?.navigation?.reload?.(); });
            expect(screen.findByType('iframe').props['data-browser-navigation-key']).not.toBe(key);
        } finally { await screen.unmount(); }
    });

    it('does not reload the mounted page when the Browser Action is disabled for UI', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState().settings.actionsSettingsV1;
        storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                'browser.reload': { enabled: false }, 'browser.view.openExternal': { enabled: false },
            } }),
        } });
        try {
            const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default"
                platform="web" initialBrowserState={openBrowserTarget(createBrowserViewState(), target, {
                    platform: 'web', currentUrl: 'https://preview.happier.test/',
                })} policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
                localServicePreviewState={createLocalServicePreviewState()} testID="browser-surface" />);
            await act(async () => { screen.findByType('iframe').props.onLoad?.(); });
            const previousNavigation = screen.findByType('iframe').props['data-browser-navigation-key'];
            let commandResult: unknown;
            await act(async () => {
                commandResult = await screen.findByType(BrowserShell).props.onCommand({
                    kind: 'reload', commandId: 'disabled-ui-reload', browserSessionId: 'browser_session_default', viewId: 'browser_view:preview_1',
                });
            });
            expect(commandResult).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            expect(await screen.findByType(BrowserShell).props.onOpenInSystemBrowser({
                browserSessionId: 'browser_session_default', viewId: 'browser_view:preview_1',
            })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            expect(browserSystemOpen).not.toHaveBeenCalled();
            await flushHookEffects();
            expect(screen.findByType('iframe').props['data-browser-navigation-key']).toBe(previousNavigation);
        } finally {
            storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: previous } });
        }
    });

    it('subscribes only while both the host and browser surface are visible', async () => {
        const appState = browserAppState;
        appState.emit('background');
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        browserStreamBoundary.views = [{
            browserSessionId: 'session_1', viewId: 'view_streamed', sourceId: 'browser-streamed-1',
            target: externalTarget, platform: 'web', adapterKind: 'chromiumSidecar', events: [],
            captureSource: { v: 1, sourceId: 'browser-streamed-1', sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                inputMode: 'shared', sidebands: [], health: { status: 'available' } },
        }];
        browserStreamBoundary.listeners.clear();
        const initialBrowserState = createBrowserViewState();
        const renderHost = (visible: boolean) => <BrowserSurfaceHost
            browserSessionId="session_1" platform="web" visible={visible} initialBrowserState={initialBrowserState}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: 'srv_browser_client_action' }}
        />;
        try {
            const screen = await renderScreen(renderHost(true));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(0);
            await act(async () => appState.emit('active'));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(1);
            await act(async () => appState.emit('background'));
            // The ingestion owner keeps a pending start's subscriber until its
            // late result can be stopped. Observe cleanup after that settlement.
            await act(async () => { await vi.waitFor(() => expect(browserStreamBoundary.listeners.size).toBe(0)); });
            await act(async () => appState.emit('active'));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(1);
            await screen.update(renderHost(false));
            await act(async () => { await vi.waitFor(() => expect(browserStreamBoundary.listeners.size).toBe(0)); });
            await screen.update(renderHost(true));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(1);
            await screen.unmount();
            await act(async () => { await vi.waitFor(() => expect(browserStreamBoundary.listeners.size).toBe(0)); });
        } finally {
            appState.emit('active');
            browserStreamBoundary.views = [];
        }
    });

    it('does not enter a client Action handler when no Account lifetime is captured', async () => {
        const composition = getInstalledPluginUiClientExecutableComposition();
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createBrowserClientActionFixture(handler);
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

        await browserAccountConnection?.dispose();
        browserAccountConnection = undefined;
        expect(getActiveServerAccountScope()).toBeNull();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async () => new Response('{}', { status: 404 }));
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
                        serverId: 'srv_browser_client_action',
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
                expect(handler).not.toHaveBeenCalled();
            } finally {
                await screen.unmount();
            }
        } finally {
            await composition.unload();
        }
    });

    it('does not enter a client Action handler after its Account retires during confirmation', async () => {
        const composition = getInstalledPluginUiClientExecutableComposition();
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the real Browser Account lifetime');
        const handler = vi.fn(async () => ({ shouldNotRun: true }));
        const fixture = createBrowserClientActionFixture(handler);
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), target, {
            platform: 'web',
            currentUrl: 'https://preview.happier.test/',
        });

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
                    pluginAccountLifetime={accountLifetime}
                    pluginBrowserProjection={fixture.pluginBrowserProjection}
                    pluginBrowserActionContext={{
                        machineId: target.machineId,
                        serverId: 'srv_browser_client_action',
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
                expect(handler).not.toHaveBeenCalled();

                // Account A owns this Browser projection and action attempt.
                // Retiring it leaves the same machine/generation visible only
                // long enough to prove the late confirmation cannot execute.
                const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                await disconnectActiveServerConnection();
                expect(getActiveServerAccountScope()).toBeNull();
                await act(async () => {
                    browserActionModal.confirm();
                    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
                });

                expect(handler).not.toHaveBeenCalled();
            } finally {
                await screen.unmount();
            }
        } finally {
            await composition.unload();
        }
    });

    it.each(['current', 'retired', 'wrong-home'] as const)(
        'reads supplied current context only at admitted handler entry (%s)', async (currentness) => {
        const composition = getInstalledPluginUiClientExecutableComposition();
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the real Browser Account lifetime');
        let suppliedContext: CurrentUiContextSnapshotV1 = {
            navigation: { area: 'app', screen: 'old-browser' }, commands: [],
        };
        // This is an existing caller-supplied capability at the public Browser
        // Action port, not a substitute for AppShell's current-context owner.
        const readCurrentUiContext = vi.fn(() => suppliedContext);
        const handler = vi.fn<PluginClientActionHandler>((_input, context) => ({
            seenContext: context.currentUiContext ?? null,
        }));
        const fixture = createBrowserClientActionFixture(handler);
        const browserAction = fixture.pluginBrowserProjection.actionsById[
            `browserAction:${BROWSER_CLIENT_ACTION_PLUGIN_ID}:${BROWSER_CLIENT_ACTION_ID}`
        ];
        if (!browserAction) throw new Error('Expected projected Browser Action');
        await composition.unload();
        try {
            await expect(composition.reconcile([fixture.activation])).resolves.toEqual([
                expect.objectContaining({ result: { ok: true } }),
            ]);
            let invocationOutcome: unknown;
            const invoking = executePluginBrowserAction({
                action: browserAction, machineId: target.machineId,
                accountLifetime,
                serverId: accountLifetime.scope.serverId, sessionId: target.sessionId,
                input: { targetId: target.targetId },
                policyContext: { profileMode: 'session', isFeatureEnabled: () => true },
                resolveContributedAction: createPluginUiProjectedActionResolver(fixture.pluginUiProjection.actionsById),
                pluginUiProjection: fixture.pluginUiProjection,
                isCurrent: accountLifetime.isCurrent, readCurrentUiContext,
            }).then(outcome => { invocationOutcome = outcome; return outcome; });
            await vi.waitFor(() => expect(browserActionModal.shown(), JSON.stringify(invocationOutcome)).toBe(true));
            expect(readCurrentUiContext).not.toHaveBeenCalled();
            expect(handler).not.toHaveBeenCalled();
            suppliedContext = { navigation: { area: 'app', screen: 'fresh-browser' }, commands: [] };
            if (currentness === 'retired') {
                const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                await disconnectActiveServerConnection();
                expect(getActiveServerAccountScope()).toBeNull();
            } else if (currentness === 'wrong-home') {
                await browserAccountConnection?.dispose();
                browserAccountConnection = await restoreServerAccountForTest({
                    serverUrl: 'https://other-browser-home.example.test', accountId: 'account-1',
                    request: async (input) => new URL(String(input)).pathname === '/v1/account/encryption/currentness'
                        ? Response.json(createPlainAccountEncryptionCurrentnessFixture()) : new Response('{}', { status: 404 }),
                });
                expect(getActiveServerAccountScope()?.serverId).not.toBe(accountLifetime.scope.serverId);
                expect(getActiveServerAccountScope()?.accountId).toBe(accountLifetime.scope.accountId);
            }
            browserActionModal.confirm();
            if (currentness === 'current') {
                await expect(invoking).resolves.toEqual({ ok: true, result: { seenContext: suppliedContext } });
                expect(handler).toHaveBeenCalledWith({ targetId: target.targetId }, expect.objectContaining({ currentUiContext: suppliedContext }));
            } else {
                await expect(invoking).resolves.toMatchObject({ ok: false, code: 'stale_surface', reason: 'plugin_action_generation_retired' });
                expect(readCurrentUiContext).not.toHaveBeenCalled();
                expect(handler).not.toHaveBeenCalled();
            }
        } finally {
            await composition.unload();
        }
    });

    it('renders a typed unavailable state before mounting shell chrome when browser policy is disabled', async () => {
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

    it('offers on-demand daemon diagnostics without fabricating an injected iframe bridge', async () => {
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

        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        expect(screen.findByType(BrowserShell).props.browserDiagnostics?.bridge).toBeNull();
        expect(screen.findByTestId('browser-surface-diagnostics-container-closed')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-diagnostics-body')).toBeNull();
    });

    it('renders preview-proxy diagnostics in the single diagnostics drawer for local-preview web iframes', async () => {
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

        expect(screen.findByTestId('browser-surface-diagnostics')).not.toBeNull();
        expect(screen.findByTestId('browser-surface-supplemental-diagnostics')).toBeNull();
    });

    it('passes browser recording state into the reusable shell chrome', async () => {
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

        // Idle recording is a `⋯` tool (H-UX F-5): the shell offers it from the overflow menu.
        await screen.pressByTestIdAsync('browser-surface-overflow');
        expect(screen.findHostByTestId('browser-surface-overflow-item-start-recording')).not.toBeNull();
    });

    it('fails closed for browser recording when the recording policy is not explicitly enabled', async () => {
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

    it('forwards the reconciled presentation lifecycle to the desktop WebView owner', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            browserSessionId: 'browser_session_default',
            platform: 'desktop',
            currentUrl: 'https://docs.happier.test/',
            targetPolicyDecision: allowedExternalPolicy,
            desktopWebViewAvailability: availableDesktopWebView,
        });
        const renderHost = (visible: boolean) => (
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="desktop"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
                presentationSlotId="details:primary"
                visible={visible}
                active={visible}
                measuredRect={visible ? { x: 0, y: 0, width: 800, height: 600 } : null}
                productModels={{
                    browserProfile: {
                        profile: sessionBrowserProfile,
                        activePermissionGrantCount: 0,
                    },
                }}
                browserFeatureDecision={enabledBrowserDecision}
                desktopWebViewAvailability={availableDesktopWebView}
                testID="browser-surface"
            />
        );

        const screen = await renderScreen(renderHost(true));
        expect(screen.findByTestId('browser-surface-view-frame')?.props.lifecycleState).toBe('visible');

        await screen.update(renderHost(false));
        expect(screen.findByTestId('browser-surface-view-frame')?.props.lifecycleState).toBe('hidden');
    });

    it('leaves inline desktop WebView lifetime unchanged without a presentation slot', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            browserSessionId: 'browser_session_default',
            platform: 'desktop',
            currentUrl: 'https://docs.happier.test/',
            targetPolicyDecision: allowedExternalPolicy,
            desktopWebViewAvailability: availableDesktopWebView,
        });

        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="desktop"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                }}
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

        expect(screen.findByTestId('browser-surface-view-frame')?.props.lifecycleState).toBeUndefined();
    });

    it('reconciles lifecycle from the previous host snapshot when a presentation slot disappears', async () => {
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

        await vi.waitFor(() => expect(screen.findByType('iframe').props['data-browser-navigation-key']).toEqual(
            expect.stringContaining('browser_command:browser_view:preview_1:reload:'),
        ));

        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://preview.happier.test/dashboard');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard'));
    });

    it('navigates a streamed daemon view across origins without replacing its exact stream target', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const onViewTargetChange = vi.fn();
        const sendDaemonCommand = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), {
            kind: 'streamedBrowser', targetId: 'exact-stream', streamId: 'exact-stream',
        }, { browserSessionId: 'session_1', viewId: 'agent-view', platform: 'web', currentUrl: 'https://first.test/' });
        const screen = await renderScreen(<BrowserSurfaceHost
            browserSessionId="browser_surface:launchpad" platform="web" initialBrowserState={initialBrowserState}
            pluginBrowserActionContext={{ sessionId: 'session_1' }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            productModels={{ browserProfile: { profile: sessionBrowserProfile, activePermissionGrantCount: 0 } }}
            browserFeatureDecision={enabledBrowserDecision} sendDaemonCommand={sendDaemonCommand}
            onViewTargetChange={onViewTargetChange} testID="browser-surface"
        />);
        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://next.test/');
        });
        await act(async () => { screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.(); });
        await vi.waitFor(() => expect(sendDaemonCommand).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'navigate', browserSessionId: 'session_1', viewId: 'agent-view', url: 'https://next.test/',
        }), expect.any(Function)));
        expect(onViewTargetChange).not.toHaveBeenCalled();
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('first.test');
    });

    it('retargets the active local-preview view when typed navigation resolves to an external URL target', async () => {
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

        await act(async () => {
            screen.changeTextByTestId('browser-surface-address', 'https://example.com/');
        });
        await act(async () => {
            screen.findByTestId('browser-surface-address')?.props.onSubmitEditing?.();
        });

        expect(screen.findByType('iframe').props.src).toBe('https://example.com/');
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('example.com');
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

        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard'));

        await screen.update(renderHost('https://preview.happier.test/refreshed'));

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');
    });

    it('opens browser panel plugin placements through the exact Browser surface pane scope', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        // The preview and its plugin renderer are served by this addressed
        // Machine. Publish its real hydrated row rather than bypassing the
        // mounted host's daemon-reachability/offline boundary.
        storage.getState().applyMachines([createMachineFixture({ id: target.machineId, activeAt: Date.now() })], true,
            { sourceServerId: browserAccountConnection!.home.id });
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
            <AppPaneProvider><BrowserPanelPaneProbe /><BrowserSurfaceHost
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
                pluginBrowserActionContext={{
                    machineId: 'machine_1',
                    serverId: 'srv_browser_client_action',
                    sessionId: 'session_1',
                }}
                testID="browser-surface"
            /></AppPaneProvider>,
        );

        expect(screen.findByTestId('browser-surface-plugin-placement-surfacePlacement:acme.browser:panel')).toBeNull();
        await act(async () => browserPanelPane!.setRightTabState(browserPanelPlacement.id, { isOpen: true }));
        expect(screen.findByTestId('browser-surface-plugin-placement-surfacePlacement:acme.browser:panel')).not.toBeNull();
        await vi.waitFor(() => {
            const unavailableDiagnostics = screen.root.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.startsWith('plugin-surface-unavailable-diagnostic-')
            )).map((node) => node.props.testID);
            expect(
                screen.findAllByType('iframe').map((frame) => String(frame.props.src ?? '')),
                JSON.stringify(unavailableDiagnostics),
            ).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/^https:\/\/preview\.happier\.test\/plugin\/acme\/.*happierBridgeNonce=/),
                ]),
            );
        });
        await act(async () => browserPanelPane!.setRightTabState(browserPanelPlacement.id, { isOpen: false }));
        expect(screen.findByTestId('browser-surface-plugin-placement-surfacePlacement:acme.browser:panel')).toBeNull();
    });

    it('renders browser panel plugins inside the Browser column, between the diagnostics drawer and the bottom chrome', async () => {
        // The short-pane layout rule depends on this wiring: a plugin panel rendered as a SIBLING of
        // the shell (rounds 1–4) squeezed the shell's box, and its later-painted region caught the
        // pointer presses meant for Reload, Create public link and Hide diagnostics.
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
            <AppPaneProvider><BrowserPanelPaneProbe /><BrowserSurfaceHost
                browserSessionId="browser_session_default"
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: true,
                    contextEnabled: false,
                }}
                localServicePreviewState={localServicePreviewState}
                supplementalDiagnostics={previewDiagnostics}
                pluginUiProjection={hostedWebBrowserPanelProjection}
                pluginBrowserActionContext={{
                    machineId: 'machine_1',
                    serverId: 'srv_browser_client_action',
                    sessionId: 'session_1',
                }}
                testID="browser-surface"
            /></AppPaneProvider>,
        );
        await act(async () => browserPanelPane!.setRightTabState(browserPanelPlacement.id, { isOpen: true }));

        const placementTestID = 'browser-surface-plugin-placement-surfacePlacement:acme.browser:panel';
        const shell = screen.findByTestId('browser-surface');
        expect(shell).not.toBeNull();
        expect(shell!.findAll((node) => node.props.testID === placementTestID)).not.toHaveLength(0);

        const hostOrder = screen.root.findAll((node) => (
            typeof node.type === 'string' && typeof node.props.testID === 'string'
        )).map((node) => node.props.testID as string);
        const indexOf = (predicate: (id: string) => boolean) => hostOrder.findIndex(predicate);
        const page = indexOf((id) => id === 'browser-surface-page-region');
        const drawer = indexOf((id) => id.startsWith('browser-surface-diagnostics-container-'));
        const panel = indexOf((id) => id === placementTestID);
        const status = indexOf((id) => id.startsWith('browser-surface-status'));
        expect(page).toBeGreaterThanOrEqual(0);
        expect(drawer).toBeGreaterThan(page);
        expect(panel).toBeGreaterThan(drawer);
        if (status >= 0) expect(status).toBeGreaterThan(panel);
    });

    it('does not mount browser panel plugin placements without an active browser target', async () => {
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
        const onViewTargetChange = vi.fn();
        const registeredUrl = 'https://preview.happier.test/current-registration';
        const resource: LocalServicePreviewResourceV1 = {
            previewId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_1' },
            target: { scheme: 'https', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' },
            display: target.display,
            originMode: 'host',
            browserTarget: target,
        };
        const preview = {
            previewId: resource.previewId, resource, accessUrl: registeredUrl,
            expiresAt: null, diagnostics: [],
        };
        browserPreviewBoundary.response = {
            protocolVersion: 1,
            status: 'existing',
            preview,
            snapshot: {
                v: 1, machineId: resource.machineId, generatedAt: 100, refreshState: 'idle',
                resources: [resource], previews: [preview], diagnostics: [],
            },
        };
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
                browserFeatureDecision={enabledBrowserDecision}
                onViewTargetChange={onViewTargetChange}
                testID="browser-surface"
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-launchpad-card:localService:preview_1');
        });

        await vi.waitFor(() => expect(screen.findByTestId('browser-surface-launchpad')).toBeNull());
        // Blurred address field names a relay preview by the service it exposes, keeping the path.
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('localhost:5173/current-registration');
        expect(screen.findByType('iframe').props.src).toBe(registeredUrl);
        expect(onViewTargetChange).toHaveBeenCalledWith({
            browserSessionId: 'browser_session_default',
            viewId: 'browser_view:preview_1',
            target,
        });
    });

    it('opens desktop external URL launchpad rows through the reusable host with policy and native WebView context', async () => {
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

        expect(screen.findByTestId('browser-surface-launchpad')).toBeNull();
        expect(screen.findByTestId('browser-surface-view-frame')).not.toBeNull();
        // Blurred address field shows the pretty display URL (scheme/trailing-slash trimmed).
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('docs.happier.test');
    });

    it('keeps the address field editable and navigates the active desktop view in place (no new tab)', async () => {
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
        await vi.waitFor(() => expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('docs.happier.test/changelog'));
    });

    it.each(['machine', 'local'] as const)('releases the closed frozen source through the %s Action ingress while focus changes retain it', async (ingress) => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
        const { readRegisteredBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');
        const { BrowserCommandDispatchResultV1Schema} = await import('@happier-dev/protocol/browser/control/v1');
        const activeScope = getActiveServerAccountScope();
        if (!activeScope) throw new Error('Browser test Account was not restored');
        const scope = activeScope;
        const { useSessionBrowserContextRuntime } = await import('@/components/sessions/browser/sessionBrowserContextRuntime');
        const { startBrowserAnnotationDraft } = await import('@/sync/domains/browser/context/annotationDraft');
        const dispose = vi.fn();
        let hasDraft = () => false;
        const sendDaemonCommand = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), ingress === 'machine' ? {
            kind: 'streamedBrowser', targetId: 'exact-stream', streamId: 'exact-stream',
        } : target, { browserSessionId: 'session_1', viewId: 'agent-view', platform: 'web' });
        function FrozenBrowserHost() {
            const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 'session_1', accountScope: scope });
            hasDraft = () => Boolean(runtime?.browserShellContext.readState?.().annotationDraftByViewId['agent-view']);
            React.useEffect(() => {
                if (!runtime) return;
                runtime.browserShellContext.onStateChange(startBrowserAnnotationDraft(runtime.state, {
                    browserSessionId: 'session_1', viewId: 'agent-view', navigationGeneration: 0, nowMs: 100,
                    source: { uri: 'blob:closed-source', width: 40, height: 30, scale: 1 },
                    capture: { bytes: new Uint8Array([1]), mimeType: 'image/png', width: 40, height: 30, sizeBytes: 1 }, dispose,
                }));
            }, []);
            return <BrowserSurfaceHost
            browserSessionId="session_1" platform="web" initialBrowserState={initialBrowserState}
            browserContext={runtime?.browserShellContext}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            productModels={{ browserProfile: { profile: sessionBrowserProfile, activePermissionGrantCount: 0 } }}
            browserFeatureDecision={enabledBrowserDecision} sendDaemonCommand={sendDaemonCommand}
            testID="browser-surface"
            />;
        }
        const screen = await renderScreen(<FrozenBrowserHost />);
        const control = readRegisteredBrowserRuntimeControlAdapter('session_1', 'agent-view');
        expect(control?.readState()?.viewsById['agent-view']).toBeDefined();
        expect(hasDraft()).toBe(true);
        await act(async () => control?.applyDaemonEvents?.([{ kind: 'viewFocused', eventId: 'focus',
            browserSessionId: 'session_1', viewId: 'agent-view', occurredAt: 999 }]));
        expect(hasDraft()).toBe(true);
        expect(dispose).not.toHaveBeenCalled();
        const result = BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: 'close-machine',
            status: 'dispatched', adapterKind: 'chromiumSidecar', events: [{
                kind: 'viewClosed', eventId: 'machine-closed', browserSessionId: 'session_1',
                viewId: 'agent-view', occurredAt: 1000,
            }] });
        // The exact Machine Action transport is external; production registration and the
        // Browser host's real event projection must consume its authoritative response.
        const execute = createDefaultRuntimeActionExecutor({}, undefined, async () => result);
        await act(async () => {
            const outcome = await execute({ actionId: 'browser.view.close', input: { kind: 'closeView',
                commandId: 'close-machine', browserSessionId: 'session_1', viewId: 'agent-view' },
                context: { serverId: scope.serverId, runtimeAccountId: scope.accountId, authority: 'present_user',
                    ...(ingress === 'machine' ? { externalActionTarget: { kind: 'machine' as const, machineId: 'machine_1' } } : {}) } });
            expect(outcome).toMatchObject({ status: 'dispatched' });
        });
        expect(control?.readState()?.viewsById['agent-view']).toBeUndefined();
        expect(hasDraft()).toBe(false);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(sendDaemonCommand).not.toHaveBeenCalled();
        await screen.unmount();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('admits picker-derived selected context independently of the diagnostics picker policy', async () => {
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        const { storage } = await import('@/sync/domains/state/storage');
        const { BrowserDiagnosticsElementPickerResultV1Schema} = await import('@happier-dev/protocol/browser/diagnostics/v1');
        const { createBrowserContextState, createBrowserAnnotationCaptureProvider } = await import('@/sync/domains/browser/context');
        const previous = storage.getState().settings.actionsSettingsV1;
        const selectedContextCapabilities: BrowserContextCapabilities = { ...annotationContextCapabilities,
            supportedContextKinds: [...annotationContextCapabilities.supportedContextKinds, 'browserSelectedElement'] };
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
            diagnostics: { enabled: true }, context: { enabled: true },
        } } });
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            browserSessionId: 'browser_session_default', platform: 'desktop', currentUrl: 'https://docs.happier.test/',
            targetPolicyDecision: allowedExternalPolicy, desktopWebViewAvailability: annotationDesktopWebView,
        });
        const view = Object.values(initialBrowserState.viewsById)[0];
        if (!view) throw new Error('Expected the browser view');
        const initialContextState = createBrowserContextState();
        let contextState = initialContextState;
        // Pixels are a native boundary; the real capture provider,
        // annotation adapter, registry, diagnostics runtime and Action executor remain in process.
        const captureScreenshot = vi.fn(async () => ({ ok: true as const, snapshot: {
            bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' as const, width: 100, height: 100, sizeBytes: 3,
        } }));
        storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: { 'browser.context.captureSelectedElement': { enabled: false } },
        }) } });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform="desktop"
            initialBrowserState={initialBrowserState}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: true, contextEnabled: true }}
            browserContext={{ state: contextState, readState: () => contextState, contextCapabilities: selectedContextCapabilities,
                accountScope: getActiveServerAccountScope(),
                browserDiagnosticsEnabled: true, attachmentsUploadsEnabled: true,
                annotationCaptureProvider: createBrowserAnnotationCaptureProvider({ captureScreenshot }),
                onStateChange: next => { contextState = next; }, nowMs: () => 10_100,
            }} browserFeatureDecision={enabledBrowserDecision} desktopWebViewAvailability={annotationDesktopWebView}
            testID="picker-annotation-policy" />);
        const diagnostics = () => screen.findByType(BrowserShell).props.browserDiagnostics;
        expect(diagnostics().interaction.state).toBe('disabled');
        await act(async () => { diagnostics().interaction.onEnableInteraction(); });
        const pick = async (selectorPath: string, navigationGeneration = view.navigationGeneration) => {
            await act(async () => { diagnostics().interaction.onStartElementPicker(); });
            await vi.waitFor(() => expect(diagnostics().bridge?.elementPickerRequest).toBeDefined());
            const request = diagnostics().bridge.elementPickerRequest;
            await act(async () => {
                diagnostics().bridge.onElementPickerResult(BrowserDiagnosticsElementPickerResultV1Schema.parse({
                    v: 1, pickerRequestId: request.pickerRequestId, viewId: view.viewId,
                    navigationGeneration, tier: 'injectedPage', audited: true,
                    status: 'selected', selectorPath, rect: { x: 1, y: 1, width: 5, height: 5 },
                    componentName: 'PayButton', sourceLocation: { file: 'src/Pay.tsx', line: 8 },
                }));
                await flushHookEffects({ cycles: 4, turns: 4 });
            });
        };
        try {
            await pick('#refused-element');
            expect(captureScreenshot).not.toHaveBeenCalled();
            expect(contextState).toBe(initialContextState);
            storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) } });
            await pick('#stale-element', view.navigationGeneration + 1);
            expect(captureScreenshot).not.toHaveBeenCalled();
            expect(contextState).toBe(initialContextState);
            await pick('#allowed-element');
            await vi.waitFor(() => expect(Object.values(contextState.itemsById)).toMatchObject([
                { kind: 'browserSelectedElement', selectorPath: '#allowed-element',
                    componentName: 'PayButton', sourceLocation: { file: 'src/Pay.tsx', line: 8 } },
            ]));
            expect(captureScreenshot).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: previous } });
        }
    });
});
