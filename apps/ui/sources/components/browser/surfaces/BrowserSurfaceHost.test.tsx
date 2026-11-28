import { BrowserEventV1Schema } from '@happier-dev/protocol/browser/events/v1';
import type { BrowserPlatformV1 } from '@happier-dev/protocol/browser/view/v1';
import { replacePersistentUiStateForTest, PersistedPaneScopesSchema } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { browserRecentsState } from '@/sync/domains/state/browserRecentsUiState';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
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
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
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
import { createDeferred, flushHookEffects, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createMachineFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/specs/browser';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { reactNativeWebAppState as browserAppState } from '@/dev/testkit/mocks/reactNative';
import {
    createBrowserViewState,
    openBrowserTarget,
    resolveBrowserDaemonStreamTarget,
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
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildCooperativeNavigationRuntimeScript } from '@happier-dev/peer-mediation/browser/collector/build';

// The real shell names the presented page as its current-context owner. The
// retained Browser host inherits that fact; its own visibility provider cannot
// create a semantic owner for an otherwise standalone fixture.
function BrowserPresentationRoot({ children }: React.PropsWithChildren) {
    return <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>{children}</PluginSurfaceFocusEligibilityProvider>;
}
const renderScreen: typeof renderTestScreen = (element, options) => renderTestScreen(element, {
    ...options, wrapper: BrowserPresentationRoot,
});

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

// The renderer has no measured portal anchor; keep real menu rows and Actions beneath it.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

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
    accessRefusal: null as Readonly<{ status: number; error: string }> | null,
    emptySnapshot: false,
    servicesRpc: null as ((input: Readonly<{ method: string; machineId: string; payload: unknown; signal?: AbortSignal }>) => Promise<unknown | null>) | null,
}));
let browserFeatures: ReturnType<typeof createRootLayoutFeaturesResponse> | null = null;
let browserActionHttp: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response | null>) | null = null;

// Discovery and relay socket are genuine network boundaries; host/runtime/ingestion stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: { method: string; machineId: string; serverId?: string | null; payload: unknown; signal?: AbortSignal }) => {
        const servicesResponse = await browserPreviewBoundary.servicesRpc?.(input);
        if (servicesResponse != null) return servicesResponse;
        if (input.method === 'daemon.browser.view.list') return { protocolVersion: 1, views: browserStreamBoundary.views };
        if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return {
            protocolVersion: 1, snapshot: { v: 1, machineId: input.machineId, updatedAt: 1, targets: [] },
        };
        if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT && browserPreviewBoundary.emptySnapshot) {
            return { protocolVersion: 1, snapshot: { v: 1, machineId: input.machineId, generatedAt: 1,
                refreshState: 'idle', resources: [], previews: [], diagnostics: [] } };
        }
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

// The daemon includes authoritative opening facts in root-view discovery. Keep this
// network fixture aligned with controlAdapter.listViews; composed tests exercise that producer.
function managedDiscoveryOpening(view: Readonly<{ browserSessionId: string; viewId: string }>, platform: BrowserPlatformV1) {
    const opening = BrowserEventV1Schema.parse({ kind: 'viewOpened', eventId: `opened:${view.viewId}`, occurredAt: 1,
        ...view, target: externalTarget, platform, adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
        adapterCapabilities: { adapterKind: 'chromiumSidecar', supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['streamedSurface'], diagnosticsFidelityByFamily: { console: 'cdp', network: 'cdp' } },
    });
    if (opening.kind !== 'viewOpened') throw new Error('Expected a viewOpened event');
    return opening;
}

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
    (replacePersistentUiStateForTest(paneUiState, PersistedPaneScopesSchema.parse({})), storage.getState().applyLocalSettings({ }));
    browserSystemOpen.mockClear();
    browserPreviewBoundary.response = null;
    browserPreviewBoundary.accessRefusal = null;
    browserPreviewBoundary.emptySnapshot = false;
    browserPreviewBoundary.servicesRpc = null;
    browserFeatures = null;
    browserActionHttp = null;
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
    const previewActionBoundary = await createExternalActionAccountHttpBoundary({
        serverUrl, serverIdentityId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId,
        accountId: 'account-1', machineId: 'machine_1', tokenEpoch: 1,
        actionId: 'localServices.preview.openOrCreate',
        execute: () => {
            if (!browserPreviewBoundary.response) throw new Error('Expected a preview registration response');
            return browserPreviewBoundary.response;
        },
    });
    await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
    }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    browserAccountConnection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-1',
        credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-1', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature` },
        configureSocket: configureConnectedServerSocketBoundary, request: async (input, init) => {
        const actionResponse = await browserActionHttp?.(input, init);
        if (actionResponse) return actionResponse;
        const path = new URL(String(input)).pathname;
        if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
        const previewResponse = await previewActionBoundary.handle(new URL(String(input)), init);
        if (previewResponse) return previewResponse;
        if (path === '/v1/features' && browserFeatures) return Response.json(browserFeatures);
        if (path === '/v1/local-services/preview/preview_1/access' && browserFeatures) {
            if (browserPreviewBoundary.accessRefusal) {
                return Response.json({ error: browserPreviewBoundary.accessRefusal.error }, {
                    status: browserPreviewBoundary.accessRefusal.status,
                });
            }
            const { LocalServicePreviewServerAccessV1Schema } = await import('@happier-dev/protocol/local/services/preview/nativeDirect');
            return Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                previewId: 'preview_1', machineId: 'machine_1', accessUrl: 'https://preview.happier.test/', expiresAt: Date.now() + 60_000 }));
        }
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        return new Response('{}', { status: 404 });
    } });
    expect(getActiveServerAccountScope()).toEqual({ serverId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId, accountId: 'account-1' });
    if (browserAppState.appState.currentState !== 'active') browserAppState.emit('active');
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
    it('routes frozen annotation point queries to the managed Machine and retains late source facts', async () => {
        const { BrowserShell } = await import('../BrowserShell');
        const { createBrowserContextState } = await import('@/sync/domains/browser/context');
        const { applyBrowserControlEvent } = await import('@/sync/domains/browser/control');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
            diagnostics: { enabled: true }, context: { enabled: true },
        } } });
        let queries = 0;
        browserActionHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
            if (machineResponse) return machineResponse;
            if (path !== '/v1/actions/browser.diagnostics.elementPicker.start') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const request = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.diagnostics.elementPicker.start'].parse(envelope.input);
            queries += 1;
            return Response.json({ v: 1, actionId: 'browser.diagnostics.elementPicker.start', requestId: envelope.requestId,
                execution: { ok: true, result: { ...request, browserSessionId: undefined, action: undefined,
                    diagnosticsInteractionEnabled: undefined, point: undefined, audited: true, status: 'selected',
                    selectorPath: '#picked-source', rect: { x: 8, y: 8, width: 200, height: 24 },
                    ...(queries > 1 ? { componentName: 'PickSource1110', sourceLocation: { file: 'fixture.js', line: 42, column: 7 } } : {}),
                } } });
        };
        const initialBrowserState = applyBrowserControlEvent(createBrowserViewState(),
            managedDiscoveryOpening({ browserSessionId: 'session_1', viewId: 'managed_1' }, 'web'));
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="session_1" platform="web"
            initialBrowserState={initialBrowserState}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: true, contextEnabled: true }}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            browserContext={{ state: createBrowserContextState(), contextCapabilities: annotationContextCapabilities,
                accountScope: scope, onStateChange: () => {} }} browserFeatureDecision={enabledBrowserDecision} />);
        const query = screen.findByType(BrowserShell).props.browserContext.queryElementAtPoint;
        expect(await query({ x: 30, y: 15 }, 0)).toMatchObject({ status: 'selected', selectorPath: '#picked-source' });
        expect(await query({ x: 30, y: 15 }, 0)).toMatchObject({ status: 'selected', componentName: 'PickSource1110',
            sourceLocation: { file: 'fixture.js', line: 42, column: 7 } });
    });

    it('offers a managed open for a saved profile on a client-only Browser page', async () => {
        const { BrowserShell } = await import('../BrowserShell');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            browserSessionId: 'presentation-only', viewId: 'shown-page', platform: 'web',
            currentUrl: 'https://docs.happier.test/guide', targetPolicyDecision: allowedExternalPolicy,
        });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="presentation-only" platform="web"
            initialBrowserState={initialBrowserState} policy={{ browserEnabled: true, viewTargetsEnabled: true,
                diagnosticsEnabled: false, contextEnabled: false }} localServicePreviewState={createLocalServicePreviewState()}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }} />);
        try {
            const selection = screen.findByType(BrowserShell).props.browserProfile.management.source.selection;
            expect(selection).toMatchObject({ actionId: 'browser.view.open', command: {
                browserSessionId: 'session_1', viewId: 'shown-page', engineOverride: 'managed',
                target: expect.objectContaining({ kind: 'externalUrl', url: 'https://docs.happier.test/guide' }),
                currentUrl: 'https://docs.happier.test/guide',
            } });
        } finally { await screen.unmount(); }
    });

    it.each(['ios', 'web'] as const)('switches the shown embedded page through the real open Action on %s', async platform => {
        const { BrowserShell } = await import('../BrowserShell');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        const currentUrl = 'https://docs.happier.test/guide?section=browser';
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture({ id: 'session_1', metadata: {
            path: '/work/docs', host: 'studio.local', homeDir: '/work', machineId: 'machine_1' } })]);
        const opens: unknown[] = [];
        browserActionHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
            if (machineResponse) return machineResponse;
            if (path !== '/v1/actions/browser.view.open') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const command = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.view.open'].parse(envelope.input);
            opens.push(command);
            return Response.json({ v: 1, actionId: 'browser.view.open', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched',
                    adapterKind: 'chromiumSidecar', events: [{ ...managedDiscoveryOpening({ browserSessionId: command.browserSessionId, viewId: command.viewId }, platform),
                        target: command.target, currentUrl }] } } });
        };
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            platform, currentUrl, targetPolicyDecision: allowedExternalPolicy,
        });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform={platform}
            initialBrowserState={initialBrowserState} policy={{ browserEnabled: true, viewTargetsEnabled: true,
                diagnosticsEnabled: false, contextEnabled: false }} localServicePreviewState={createLocalServicePreviewState()}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            testID="engine-switch" />);
        await screen.pressByTestIdAsync('engine-switch-overflow');
        expect(screen.getTextContent()).toContain('browserShell.engineSwitch.signInAgain');
        await screen.pressByTestIdAsync('engine-switch-overflow-item-open-in-managed-browser');
        await vi.waitFor(() => expect(opens).toMatchObject([{ browserSessionId: 'session_1',
            target: { kind: 'externalUrl', url: currentUrl }, currentUrl }]));
        await vi.waitFor(() => expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById))
            .toEqual(expect.arrayContaining([expect.objectContaining({ engineKind: 'streamedSurface', currentUrl })])));
        await vi.waitFor(() => {
            const shell = screen.findByType(BrowserShell);
            expect(shell.props.state.viewsById[shell.props.viewId]).toMatchObject({
                engineKind: 'streamedSurface', currentUrl,
            });
        });
    });

    it('adopts a discovered root view without opening a second workspace presentation', async () => {
        const { BrowserScopedWorkspace } = await import('./BrowserScopedWorkspace');
        const { BrowserShell } = await import('../BrowserShell');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const { EMPTY_PLUGIN_BROWSER_PROJECTION } = await import('@/sync/domains/plugins/browser/targets');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture({ id: 'session_1', metadata: {
            path: '/work/docs', host: 'studio.local', homeDir: '/work', machineId: 'machine_1' } })]);
        const opening = managedDiscoveryOpening({ browserSessionId: 'session_1', viewId: 'discovered-root' }, 'web');
        browserActionHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
            if (machineResponse) return machineResponse;
            if (path !== '/v1/actions/browser.view.open') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const command = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.view.open'].parse(envelope.input);
            browserStreamBoundary.views = [{ browserSessionId: command.browserSessionId, viewId: command.viewId,
                sourceId: `source:${command.viewId}`, target: command.target, platform: 'web', adapterKind: 'chromiumSidecar',
                events: [{ ...opening, viewId: command.viewId }], captureSource: { v: 1,
                    sourceId: `source:${command.viewId}`, sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                    inputMode: 'shared', sidebands: [], health: { status: 'available' } } }];
            return Response.json({ v: 1, actionId: 'browser.view.open', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, commandId: command.commandId,
                    status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } });
        };
        expect(await createFrontDoorActionExecute()('browser.view.open', {
            kind: 'openView', commandId: 'discover-root', browserSessionId: 'session_1',
            viewId: opening.viewId, target: externalTarget,
            platform: 'web', focus: true,
        }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId,
            defaultSessionId: 'session_1', externalActionTarget: { kind: 'machine', machineId: 'machine_1' } })).toMatchObject({ ok: true });
        const render = (visible: boolean) => <AppPaneProvider>
            <BrowserPanelPaneProbe />
            <BrowserScopedWorkspace scopeId="browser-panels:browser_session_default"
                scope={{ kind: 'session', sessionId: 'session_1', serverId: scope.serverId }}
                openScope="sessionDetails" platform="web" presentation="viewer" visible={visible}
                pluginBrowserActionSessionId="session_1"
                pluginProjection={{ phase: 'current', interactionEnabled: true, machineId: 'machine_1', serverId: scope.serverId,
                    platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION }}
                localServicePreviewState={createLocalServicePreviewState()} />
        </AppPaneProvider>;
        const screen = await renderScreen(render(true));
        try {
            await vi.waitFor(() => expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById))
                .toEqual(expect.arrayContaining([expect.objectContaining({ viewId: opening.viewId })])));
            await flushHookEffects();
            expect(browserPanelPane!.scopeState?.details.isOpen ?? false).toBe(false);
            expect(browserPanelPane!.scopeState?.details.tabs).toMatchObject([
                { resource: { browserSessionId: 'session_1', viewId: opening.viewId,
                    target: { kind: 'streamedBrowser', targetId: 'source:discovered-root' } } },
            ]);
            // A real child announces its opener. Reconnect discovery with that popup present;
            // it must still use the existing workspace tab opener, unlike root adoption.
            await screen.update(render(false));
            browserStreamBoundary.views = [...browserStreamBoundary.views, {
                browserSessionId: 'session_1', viewId: 'discovered-child', sourceId: 'child-source',
                target: externalTarget, platform: 'web', adapterKind: 'chromiumSidecar',
                events: [{ ...opening, viewId: 'discovered-child', openerViewId: opening.viewId }],
                captureSource: { v: 1, sourceId: 'child-source', sourceKind: 'browser',
                    supportedCodecs: ['image.mjpeg'], inputMode: 'shared', sidebands: [], health: { status: 'available' } },
            }];
            await screen.update(render(true));
            await vi.waitFor(() => expect(browserPanelPane!.scopeState?.details.tabs).toMatchObject([
                { resource: { viewId: opening.viewId } },
                { resource: { viewId: 'discovered-child' } },
            ]));
        } finally { browserStreamBoundary.views = []; await screen.unmount(); }
    });

    it('opens a typed localhost address on the Session Machine on web, not this device', async () => {
        const { BrowserShell } = await import('../BrowserShell');
        const { resolveExternalUrlTargetFromInput } = await import('@/sync/domains/browser/shell');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture({ id: 'session_1', metadata: {
            path: '/work/docs', host: 'studio.local', homeDir: '/work', machineId: 'machine_1' } })]);
        const opens: unknown[] = [];
        browserActionHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
            if (machineResponse) return machineResponse;
            if (path !== '/v1/actions/browser.view.open') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const command = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.view.open'].parse(envelope.input);
            opens.push(command);
            return Response.json({ v: 1, actionId: 'browser.view.open', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched',
                    adapterKind: 'chromiumSidecar', events: [] } } });
        };
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform="web"
            initialBrowserState={createBrowserViewState()} policy={{ browserEnabled: true, viewTargetsEnabled: true,
                diagnosticsEnabled: false, contextEnabled: false }} localServicePreviewState={createLocalServicePreviewState()}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            testID="machine-localhost" />);
        const target = resolveExternalUrlTargetFromInput('http://localhost:42514/');
        if (!target) throw new Error('Expected a localhost target');
        await act(async () => { await screen.findByType(BrowserShell).props.onNavigateInPlace(target, { platform: 'web' }); });
        await vi.waitFor(() => expect(opens).toMatchObject([{ browserSessionId: 'session_1',
            target: { kind: 'externalUrl', url: 'http://localhost:42514/' } }]));
        // Nothing embeds this device's localhost.
        expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById)
            .some(view => (view as { engineKind: string }).engineKind === 'webIframe')).toBe(false);
    });

    it('does not offer the managed Browser for an embedded page without a Session Machine', async () => {
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), externalTarget, {
            platform: 'ios', currentUrl: externalTarget.url, targetPolicyDecision: allowedExternalPolicy,
        });
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform="ios"
            initialBrowserState={initialBrowserState} policy={{ browserEnabled: true, viewTargetsEnabled: true,
                diagnosticsEnabled: false, contextEnabled: false }} localServicePreviewState={createLocalServicePreviewState()}
            testID="engine-switch" />);
        await screen.pressByTestIdAsync('engine-switch-overflow');
        expect(screen.findByTestId('engine-switch-overflow-item-open-in-managed-browser')).toBeNull();
    });

    it.each(['web', 'ios', 'android', 'desktop'] as const)('offers managed Open here only on native/desktop (%s)', async platform => {
        const { applyBrowserControlEvent } = await import('@/sync/domains/browser/control');
        const { resolveExternalUrlTargetFromInput } = await import('@/sync/domains/browser/shell');
        const { resolveBrowserViewIdentityForTarget } = await import('@/sync/domains/browser/store');
        const { BrowserShell } = await import('../BrowserShell');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected Browser Account');
        const canonicalTarget = resolveExternalUrlTargetFromInput(externalTarget.url);
        if (!canonicalTarget) throw new Error('Expected an external URL target');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applySessions([createSessionFixture({ id: 'session_1', metadata: {
            path: '/work/docs', host: 'studio.local', homeDir: '/work', machineId: 'machine_1' } })]);
        const initialBrowserState = applyBrowserControlEvent(createBrowserViewState(), {
            ...managedDiscoveryOpening(resolveBrowserViewIdentityForTarget(canonicalTarget, { browserSessionId: 'session_1' }), platform),
            target: canonicalTarget, currentUrl: externalTarget.url,
        });
        // The pane's own presentation session, as in the app; the managed view lives in the Session's.
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="browser_session_default" platform={platform}
            initialBrowserState={initialBrowserState} policy={{ browserEnabled: true, viewTargetsEnabled: true,
                diagnosticsEnabled: false, contextEnabled: false }} localServicePreviewState={createLocalServicePreviewState()}
            desktopWebViewAvailability={platform === 'desktop' ? availableDesktopWebView : undefined}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            testID="engine-switch" />);
        await screen.pressByTestIdAsync('engine-switch-overflow');
        if (platform === 'web') {
            expect(screen.findByTestId('engine-switch-overflow-item-open-here')).toBeNull();
        } else {
            await screen.pressByTestIdAsync('engine-switch-overflow-item-open-here');
            await vi.waitFor(() => expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById))
                .toEqual(expect.arrayContaining([expect.objectContaining({ currentUrl: externalTarget.url,
                    engineKind: platform === 'desktop' ? 'desktopWebView' : 'nativeWebView' })])));
        }
    });
    it('retains navigation from an unheld Browser launchpad without opening a second column', async () => {
        const { BrowserScopedWorkspace } = await import('./BrowserScopedWorkspace');
        const { BrowserShell } = await import('../BrowserShell');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const resource: LocalServicePreviewResourceV1 = {
            previewId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_1' }, target: { scheme: 'https', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: target.display, originMode: 'host', browserTarget: target,
        };
        const preview = { previewId: resource.previewId, resource,
            accessUrl: 'https://preview.happier.test/', expiresAt: null, diagnostics: [] };
        browserPreviewBoundary.response = { protocolVersion: 1, status: 'existing', preview,
            snapshot: { v: 1, machineId: 'machine_1', generatedAt: 1, refreshState: 'idle',
                resources: [resource], previews: [preview], diagnostics: [] } };
        const launchpadRows = [{ id: 'localService:preview_1', section: 'running', sourceKind: 'localService',
            title: 'Preview', subtitle: 'localhost:5173', detail: 'vite', target,
            currentUrl: preview.accessUrl, disabledReason: null, lastSeenAt: 1, launchMode: 'currentView' }] as const;
        const workspace = (presentation: 'viewer' | 'workspace') => <AppPaneProvider>
            <BrowserPanelPaneProbe />
            <BrowserScopedWorkspace scopeId="browser-panels:browser_session_default"
                scope={{ kind: 'session', sessionId: 'session_1' }}
                openScope="sessionDetails" platform="web"
                presentation={presentation} collapseSingleTab launchpadRows={launchpadRows}
                localServicePreviewState={createLocalServicePreviewState()} />
        </AppPaneProvider>;
        const screen = await renderScreen(workspace('viewer'));
        try {
            await act(async () => browserPanelPane!.openRight({ tabId: 'browser', present: false }));
            expect(browserPanelPane!.scopeState?.details.tabs).toEqual([]);
            await screen.pressByTestIdAsync('browser-view-details-surface-launchpad-card:localService:preview_1');
            await vi.waitFor(() => {
                const shell = screen.findByType(BrowserShell).props;
                expect(Object.keys(shell.state.viewsById), JSON.stringify({
                    policy: shell.policy, decision: shell.browserFeatureDecision, state: shell.state,
                })).not.toEqual([]);
            });
            await vi.waitFor(() => expect(browserPanelPane!.scopeState?.details.tabs).toMatchObject([
                { kind: 'browser-view', resource: { kind: 'browser-view', target } },
            ]));
            expect(browserPanelPane!.scopeState?.details.isOpen).toBe(false);
            expect(browserPanelPane!.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'browser' });
            await screen.update(workspace('workspace'));
            expect(screen.findByType('iframe').props.src).toBe(preview.accessUrl);
            expect(browserPanelPane!.scopeState?.details.tabs).toHaveLength(1);
        } finally { await screen.unmount(); }
    });

    it('moves the open Service to Ended from the existing Machine watch without Reload', async () => {
        const { BrowserDetailsSurface } = await import('./browserDetailsSurfaceRenderer');
        const { BrowserShell } = await import('../BrowserShell');
        const { DaemonLocalServicePreviewSnapshotResponseV1Schema } = await import('@happier-dev/protocol/local/services/preview/v1');
        const { DaemonLocalServiceInventoryWatchRequestV1Schema } = await import('@happier-dev/protocol/local/services/inventory/v1');
        const { LocalServiceLauncherSnapshotV1Schema } = await import('@happier-dev/protocol/local/services/launcher/v1');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const resource: LocalServicePreviewResourceV1 = { previewId: target.targetId,
            sessionId: target.sessionId, machineId: target.machineId, owner: { kind: 'session', id: target.sessionId },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: target.display, originMode: 'host', browserTarget: target };
        const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview.happier.test/',
            expiresAt: Date.now() + 60_000, diagnostics: [] };
        const firstWatch = createDeferred<unknown>();
        const parkedWatch = createDeferred<unknown>();
        let ended = false;
        let previewReads = 0;
        let watches = 0;
        const watchSignals: AbortSignal[] = [];
        const launcher = () => LocalServiceLauncherSnapshotV1Schema.parse({ v: 1, machineId: target.machineId,
            sessionId: target.sessionId, updatedAt: ended ? 2 : 1, targets: ended ? [] : [{
                id: resource.previewId, source: 'registered_preview', machineId: target.machineId,
                sessionId: target.sessionId, title: 'Preview', confidence: 'high', state: 'available',
                actions: ['open_preview'], browserTarget: target,
            }] });
        // Only the daemon RPC is substituted. Both keyed stores, watch invalidation, the
        // production Details feed and the mounted Browser lifecycle remain real.
        browserPreviewBoundary.servicesRpc = async input => {
            if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT) {
                previewReads++;
                return DaemonLocalServicePreviewSnapshotResponseV1Schema.parse({ protocolVersion: 1,
                    snapshot: { v: 1, machineId: target.machineId, generatedAt: ended ? 2 : 1,
                        refreshState: 'idle', resources: ended ? [] : [resource], previews: ended ? [] : [preview], diagnostics: [] } });
            }
            if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                const request = DaemonLocalServiceInventoryWatchRequestV1Schema.parse(input.payload);
                expect(input.signal).toBeDefined();
                expect(request.launcherProjection).toBeDefined();
                watchSignals.push(input.signal!);
                watches++;
                return await (watches === 1 ? firstWatch.promise : parkedWatch.promise);
            }
            if (input.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT) return { protocolVersion: 1,
                snapshot: launcher() };
            return null;
        };
        const fetchProbe = vi.fn(async () => Response.json({ state: 'collector_available' }));
        vi.stubGlobal('fetch', fetchProbe);
        const renderSurface = (visible: boolean) => <BrowserDetailsSurface
            resource={{ kind: 'browserSurface', target, browserSessionId: 'stop-browser', viewId: 'stop-view', currentUrl: preview.accessUrl }}
            presentationSlotId="stop-preview" keepAliveAboveRouter={false} active={visible} visible={visible} platform="web"
            machineId={target.machineId} serverId={BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId} sessionId={target.sessionId}
            browserFeatureDecision={enabledBrowserDecision} testID="pushed-ended" />;
        const screen = await renderScreen(renderSurface(true));
        try {
            await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
            await act(async () => screen.findByType('iframe').props.onLoad());
            await vi.waitFor(() => expect(watches).toBe(1));
            await flushHookEffects();
            const reads = previewReads;
            const probes = fetchProbe.mock.calls.length;
            ended = true;
            await act(async () => firstWatch.resolve({ protocolVersion: 1, changed: true, snapshot: launcher() }));
            await vi.waitFor(() => expect(screen.findHostByTestId('pushed-ended-view-unavailable-diagnostic-preview_ended')).not.toBeNull());
            expect(screen.findAllByType('iframe')).toHaveLength(0);
            expect(screen.findByType(BrowserShell).props.state.viewsById['stop-view'])
                .toMatchObject({ loadingState: 'failed', lastError: 'preview_ended', currentUrl: preview.accessUrl });
            expect(previewReads - reads).toBe(1);
            expect(fetchProbe.mock.calls).toHaveLength(probes);
            await vi.waitFor(() => expect(watches).toBe(2));
            await screen.update(renderSurface(false));
            expect(watchSignals[watchSignals.length - 1]!.aborted).toBe(true);
            const hiddenReads = previewReads;
            await flushHookEffects();
            expect(previewReads).toBe(hiddenReads);
            expect(watches).toBe(2);
        } finally {
            await screen.unmount();
            firstWatch.resolve({ protocolVersion: 1, changed: false });
            parkedWatch.resolve({ protocolVersion: 1, changed: false });
            vi.unstubAllGlobals();
        }
    });

    it.each([
        { tunnelReason: 'preview_not_found', status: 404, outcome: 'preview_ended' },
        { tunnelReason: 'destination_port_not_allowed', status: 403, outcome: 'destination_port_not_allowed' },
    ])('settles reload through the real proxy refusal and renderer ($tunnelReason)', async ({ tunnelReason, status: expectedStatus, outcome }) => {
        // This seam deliberately composes the server's pure proxy presenter with the real UI.
        // Only HTTP/PMS transport is substituted; no refusal mapper or lifecycle owner is mocked.
        const { prepareCooperativePreview } = await import('../../../../../server/sources/app/local/services/preview/collectorBootstrap');
        const { proxyLocalServicePreviewHttpRequest } = await import('@happier-dev/peer-mediation/localServices/preview/httpAdapter');
        const { parseCooperativeCollectorConfig } = await import('@happier-dev/peer-mediation/browser/collector/cooperative');
        const { RightSidebarActionsContext } = await import('@/components/appShell/rightSidebar/rightSidebarActions');
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
        } } });
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const resource: LocalServicePreviewResourceV1 = { previewId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_1' }, target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: target.display, originMode: 'host', browserTarget: target };
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 100, refreshState: 'idle', diagnostics: [], previews: [{ resource,
                previewId: resource.previewId, accessUrl: 'https://preview.happier.test/', expiresAt: null, diagnostics: [] }],
        });
        let ended = false;
        let probes = 0;
        const probeStatuses: number[] = [];
        const fetchProbe = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            expect(url.searchParams.get('__happierCollectorState')).toBe('1');
            probes += 1;
            let status = 200;
            const chunks: Uint8Array[] = [];
            let body = JSON.stringify({ state: 'collector_available' });
            if (ended) {
                const prepared = await prepareCooperativePreview({ preview: resource,
                    request: { method: 'GET', path: url.pathname, search: url.search,
                        headers: { host: url.host, origin: parseCooperativeCollectorConfig(url.searchParams.get('__happierCollector'))
                            ?.webPostMessageTargetOrigin ?? 'https://browser-host.example.test' } },
                    openTunnel: async () => { throw Object.assign(new Error(tunnelReason), { reasonCode: tunnelReason }); },
                    response: { writeHead(code) { status = code; }, write(chunk) { chunks.push(chunk); }, end() {},
                        destroy(error) { throw error; } },
                });
                expect(prepared).not.toBeNull();
                if (prepared) await proxyLocalServicePreviewHttpRequest({ ...prepared, openTunnel: prepared.openTunnel! });
                body = Buffer.concat(chunks).toString('utf8');
            }
            const response = new Response(body, { status, headers: { 'content-type': 'application/json' } });
            probeStatuses.push(status);
            Object.defineProperty(response, 'url', { value: url.href });
            return response;
        });
        vi.stubGlobal('fetch', fetchProbe);
        const selectTab = vi.fn();
        const screen = await renderScreen(<RightSidebarActionsContext.Provider value={{ current: { tabs: ['services'], selectTab } }}>
            <BrowserSurfaceHost browserSessionId="browser_session_default" platform="web"
            initialBrowserState={openBrowserTarget(createBrowserViewState(), target, { platform: 'web' })}
            localServicePreviewState={previewState} keepAliveAboveRouter={false}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            testID="ended-reload" /></RightSidebarActionsContext.Provider>);
        try {
            await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
            await act(async () => screen.findByType('iframe').props.onLoad());
            await vi.waitFor(() => expect(probes).toBe(1));
            ended = true;
            await screen.pressByTestIdAsync('ended-reload-reload');
            await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
            // Browsers fire load even for an iframe's refused JSON document; the parent reads
            // the existing one-shot state probe, not inaccessible child status or content.
            await act(async () => screen.findByType('iframe').props.onLoad());
            await vi.waitFor(() => expect(probeStatuses).toEqual([200, expectedStatus]));
            const state = screen.findByType(BrowserShell).props.state;
            expect(Object.values(state.viewsById)[0]).toMatchObject({ loadingState: 'failed', lastError: outcome });
            expect(screen.findHostByTestId(`ended-reload-view-frame-unavailable-diagnostic-${outcome}`)).not.toBeNull();
            expect(screen.findAllByType('iframe')).toHaveLength(0);
            expect(screen.findHostByTestId('ended-reload-view-frame-ended-open-again')).toBeNull();
            if (outcome === 'preview_ended') {
                await screen.pressByTestIdAsync('ended-reload-view-frame-ended-services');
                expect(selectTab).toHaveBeenCalledWith('services');
            } else {
                const { BrowserFrameUnavailable } = await import('../frame/BrowserFrameUnavailable');
                expect(screen.findByType(BrowserFrameUnavailable).props.port).toBe(resource.target.port);
                expect(screen.findHostByTestId('ended-reload-view-frame-try-again')).toBeNull();
            }
            await flushHookEffects();
            expect(probes).toBe(2);
        } finally { await screen.unmount(); vi.unstubAllGlobals(); }
    });

    it.each(['refused', 'openAgain', 'services'] as const)('restores an ended preview with its last location and running-Service recovery without a retained inventory row (%s)', async (entry) => {
        const { createBrowserWorkspaceOpeningFixture } = await import('@/dev/testkit/fixtures/browserWorkspaceOpening');
        const { createBrowserRuntimeActionExecutor } = await import('@/sync/domains/browser/actions/runtimeActionExecutor');
        const { createLocalServicesRuntimeActionExecutor } = await import('@/sync/domains/local/services/actions/runtimeActionExecutor');
        const { BrowserFrameUnavailable } = await import('../frame/BrowserFrameUnavailable');
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const { createBrowserViewDetailsTab, readBrowserViewDetailsResource } = await import('./browserSurfaceDetailsTabModel');
        const { buildBrowserLaunchpadRows, selectRunningServiceForEndedPreview } = await import('@/sync/domains/browser/targets');
        const { bindServicesOpenInBrowser } = await import('./openBrowserTargetInWorkspace');
        const { useLocalServicePreviewStateController } = await import('@/sync/domains/local/services/preview/useLocalServicePreviewState');
        const { resetLocalServicePreviewStoreForTests } = await import('@/sync/domains/local/services/preview/sharedStore');
        resetLocalServicePreviewStoreForTests();
        browserPreviewBoundary.emptySnapshot = true;
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, viewTargets: { enabled: true }, internal: { enabled: true },
        } } });
        browserPreviewBoundary.accessRefusal = { status: 404, error: 'preview_not_found' };
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const declaration = { workspaceRefId: 'workspace_1', selection: { kind: 'manifest', name: 'web' } } as const;
        const restoredTarget = { kind: target.kind, targetId: target.targetId, machineId: target.machineId, display: target.display,
            serviceTarget: { kind: 'managed_service', managedServiceId: 'instance_old',
            machineId: 'machine_1', cwd: '/repo', declaration } } as const;
        const launcherSnapshot: import('@/sync/domains/local/services/launch').LocalServiceLauncherSnapshot = {
            v: 1, machineId: 'machine_1', sessionId: 'session_1', updatedAt: 1_000,
            targets: [{ id: 'managed:instance_new', source: 'managed_service', machineId: 'machine_1', sessionId: 'session_1',
                title: 'Web', subtitle: 'localhost:5173', sourceClass: { kind: 'managed_service', managedServiceId: 'instance_new' },
                cwd: '/repo', declaration, serviceState: 'running', endpointUrl: 'http://localhost:5173/', confidence: 'high',
                state: 'available', actions: ['register_preview'] }],
        };
        const launchpadRows = buildBrowserLaunchpadRows({ nowMs: 2_000, launcherSnapshot });
        let pane: AppPaneScopeApi | undefined;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the admitted Browser Account fixture');
        const serverId = accountLifetime.scope.serverId;
        let previewController: ReturnType<typeof useLocalServicePreviewStateController> | undefined;
        const openingSettings = normalizeActionsSettingsV1({ v: 1, actions: { 'browser.workspace.open': { enabled: entry !== 'refused' } } });
        let runtimeActionExecute = createBrowserRuntimeActionExecutor({});
        const opener = createBrowserWorkspaceOpeningFixture({
            scope: 'sessionDetails', platform: 'web', accountLifetime,
            browserFeatureDecision: enabledBrowserDecision,
            openDetailsTab: (tab, options) => pane!.openDetailsTab(tab, options),
        }, { runtimeActionExecute: args => runtimeActionExecute(args),
            isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, openingSettings, context) });
        const resource: LocalServicePreviewResourceV1 = {
            previewId: 'preview_1', sessionId: 'session_1', machineId: 'machine_1',
            owner: { kind: 'session', id: 'session_1' },
            target: { scheme: 'http', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' }, display: target.display,
            originMode: 'host', browserTarget: restoredTarget,
        };
        const preview = { previewId: resource.previewId, resource, accessUrl: 'https://preview.happier.test/current-registration', expiresAt: null, diagnostics: [] };
        browserPreviewBoundary.response = { protocolVersion: 1, status: 'existing', preview,
            snapshot: { v: 1, machineId: resource.machineId, generatedAt: 100, refreshState: 'idle',
                resources: [resource], previews: [preview], diagnostics: [] } };
        function Workspace() {
            pane = useAppPaneScope('restored-ended-preview');
            previewController = useLocalServicePreviewStateController({ machineId: target.machineId,
                serverId });
            const renderer = createBrowserViewDetailsSurfaceRenderer({ platform: 'web', keepAliveAboveRouter: false,
                launchpadRows, localServiceTargets: launcherSnapshot.targets,
                localServicePreviewState: previewController.state,
                localServicePreviewServerId: serverId, serverId,
                pluginAccountLifetime: accountLifetime,
                browserFeatureDecision: enabledBrowserDecision, onOpenTarget: opener.open });
            const current = pane.scopeState?.details.tabs[0];
            return current ? renderer.render({ tab: current, descriptor: {
                surfaceId: 'restored-ended-preview', resourceKey: 'restored-ended-preview',
                scope: { kind: 'global' }, region: 'details', status: 'available',
            }, scope: { kind: 'global' }, region: 'details', active: true,
            callbacks: { replaceTab: pane.replaceDetailsTab } }) : null;
        }
        let screen = await renderScreen(<AppPaneProvider><Workspace /></AppPaneProvider>);
        try {
            const tab = createBrowserViewDetailsTab({ target: restoredTarget,
                currentUrl: 'https://old-preview.test/last-page?query=1#section',
            });
            expect(readBrowserViewDetailsResource(tab.resource)).not.toBeNull();
            await act(async () => pane!.openDetailsTab(tab, { intent: 'pinned' }));
            await screen.unmount();
            screen = await renderScreen(<AppPaneProvider><Workspace /></AppPaneProvider>);
            await flushHookEffects({ cycles: 40 });
            await vi.waitFor(() => expect(screen.findHostByTestId(
                'browser-view-details-surface-view-unavailable-diagnostic-preview_ended',
            )).not.toBeNull());
            const state = screen.findByType(BrowserShell).props.state;
            const view = Object.values(state.viewsById)[0];
            expect(view).toMatchObject({ target: restoredTarget, currentUrl: '/last-page?query=1#section',
                loadingState: 'failed', lastError: 'preview_ended' });
            expect(screen.findHostByTestId('browser-view-details-surface-view-ended-close')).not.toBeNull();
            expect(screen.findHostByTestId('browser-view-details-surface-view-ended-open-again')).not.toBeNull();
            expect(screen.findAllByType('iframe')).toHaveLength(0);
            expect(pane!.scopeState?.details.tabs[0].resource).toMatchObject({
                target: restoredTarget, currentUrl: '/last-page?query=1#section',
            });
            const previewLifetime = previewController?.accountLifetime;
            const credentialKey = previewController?.credentialKey;
            if (!previewLifetime || !credentialKey) throw new Error('Expected the current preview Account binding');
            runtimeActionExecute = createLocalServicesRuntimeActionExecutor({
                catalogBinding: { lifetime: previewLifetime, credentialKey },
                executeOnMachine: async () => browserPreviewBoundary.response,
                fallback: createBrowserRuntimeActionExecutor({}),
            });
            if (entry !== 'refused') browserPreviewBoundary.accessRefusal = null;
            if (entry === 'services') {
                const service = selectRunningServiceForEndedPreview(launchpadRows, restoredTarget);
                expect(service).not.toBeNull();
                await act(async () => {
                    const deps = { onOpenTarget: opener.open, platform: 'web' as const,
                        serverId, accountLifetime: previewController?.accountLifetime,
                        credentialKey: previewController?.credentialKey,
                        actionExecute: (...args: Parameters<typeof opener.executor.execute>) => opener.executor.execute(args[0], args[1],
                            { ...args[2], ...opener.context }) };
                    const result = await bindServicesOpenInBrowser(deps)(service!);
                    expect(result).toEqual({ status: 'succeeded' });
                });
            } else {
                await screen.pressByTestIdAsync('browser-view-details-surface-view-ended-open-again');
            }
            await flushHookEffects();
            if (entry === 'refused') {
                // Registration alone is not a committed workspace open.
                await vi.waitFor(() => {
                    expect(screen.findByType(BrowserFrameUnavailable).props.recovery.openAgainFailure).toEqual(expect.any(String));
                    expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById)[0]).toMatchObject({
                        loadingState: 'failed', lastError: 'preview_ended',
                    });
                    expect(screen.findHostByTestId('browser-view-details-surface-view-ended-open-again')).not.toBeNull();
                });
            } else {
                // Registration can reuse the preview and the workspace tab. Both entry points
                // must retry admission at that retained view rather than strand or close it.
                await vi.waitFor(() => expect(previewController?.state.previewIds).toContain(resource.previewId));
                expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById)[0]).toMatchObject({ lastError: null });
                await vi.waitFor(() => expect(screen.findAllByType('iframe')).toHaveLength(1));
                await act(async () => screen.findByType('iframe').props.onLoad());
                expect(Object.values(screen.findByType(BrowserShell).props.state.viewsById)[0]).toMatchObject({
                    loadingState: 'ready', lastError: null,
                });
                expect(pane!.scopeState?.details.tabs).toHaveLength(1);
            }
        } finally { opener.dispose(); await screen.unmount(); resetLocalServicePreviewStoreForTests(); }
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
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected the admitted Browser Account fixture');
        const serverId = scope.serverId;
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
                serverId, snapshotClient, enabled: callerSnapshot });
            const props = useBrowserSurfaceHostProps({ scope: 'sessionDetails', sessionId: 'catalog_retry',
                machineId: 'machine_catalog_retry', serverId, launcherState,
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
            expect(requests.every((request) => request.machineId === 'machine_catalog_retry' && request.serverId === serverId)).toBe(true);
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
            target: externalTarget, platform: 'web', adapterKind: 'chromiumSidecar',
            events: [managedDiscoveryOpening({ browserSessionId: 'session_1', viewId: 'view_streamed' }, 'web')],
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

    it('offers embedded diagnostics while leaving the idle drawer closed', async () => {
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
        expect(screen.findByType(BrowserShell).props.browserDiagnostics?.bridge).toBeTruthy();
        // Idle, the drawer is not drawn at all: it opens from the chrome's ⋯ (lab Q).
        expect(screen.findByTestId('browser-surface-diagnostics-container-closed')).toBeNull();
        expect(screen.findByTestId('browser-surface-diagnostics-body')).toBeNull();
    });

    it.each([
        { platform: 'web', seeded: false, sessionId: 'human-session' },
        { platform: 'android', seeded: false, sessionId: 'human-session' },
        { platform: 'web', seeded: true, sessionId: 'human-session' },
        { platform: 'web', seeded: false, sessionId: null },
    ] as const)('opens Diagnostics for a managed browser (platform=$platform, seeded=$seeded, sessionId=$sessionId)', async ({ platform, seeded, sessionId }) => {
        const { BrowserDaemonViewV1Schema } = await import('@happier-dev/protocol/browser/control/v1');
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        const { resetBrowserDiagnosticsDrawerStateForTests } = await import('@/components/browser/diagnostics/BrowserDiagnosticsDrawer');
        resetBrowserDiagnosticsDrawerStateForTests();
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Browser test Account was not restored');
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, diagnostics: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const requests: unknown[] = [];
        browserActionHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            const machineResponse = createPlainMachineReadHttpResponseFixture(path, init, 'account-1');
            if (machineResponse) return machineResponse;
            if (path !== '/v1/actions/browser.diagnostics.eval') return null;
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(JSON.parse(String(init?.body)));
            const request = BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS['browser.diagnostics.eval'].parse(envelope.input);
            requests.push({ target: envelope.target, request });
            return Response.json({ v: 1, actionId: 'browser.diagnostics.eval', requestId: envelope.requestId,
                execution: { ok: true, result: { v: 1, evalRequestId: request.evalRequestId,
                    viewId: request.viewId, navigationGeneration: request.navigationGeneration, tier: 'cdp',
                    audited: true, status: 'completed', result: { type: 'number', value: 42 } } } });
        };
        const browser = await installBrowserRuntimeForTests({ url: 'https://browser-host.example.test/' });
        // Paint crosses ReactDOM's renderer boundary; retain the real menu and portal owner.
        const portalBoundary = installReactDomPortalBoundaryForTests();
        const { storage } = await import('@/sync/domains/state/storage');
        const humanSession = createSessionFixture({ id: 'human-session', metadata: {
            path: '/human/workspace', host: 'human.local', homeDir: '/human', machineId: 'enclosing-machine',
        } });
        storage.getState().applySessions([humanSession]);
        const view = { browserSessionId: seeded ? 'different-managed-session' : sessionId ?? 'browser_surface:details:browser_launchpad', viewId: 'managed-view', navigationGeneration: 0 };
        // The Session has no agent metadata or locally opened view. Its daemon discovery
        // supplies the exact identity through the existing stream-target/event owner.
        browserStreamBoundary.views = [BrowserDaemonViewV1Schema.parse({ browserSessionId: view.browserSessionId, viewId: view.viewId,
            sourceId: 'human-managed-source', target: externalTarget, platform,
            adapterKind: 'chromiumSidecar', events: [managedDiscoveryOpening(view, platform)], captureSource: { v: 1,
                sourceId: 'human-managed-source', sourceKind: 'browser', supportedCodecs: ['image.mjpeg'],
                inputMode: 'shared', sidebands: [], health: { status: 'available' } },
        })];
        const discoveredView = BrowserDaemonViewV1Schema.parse(browserStreamBoundary.views[0]);
        const streamTarget = resolveBrowserDaemonStreamTarget(discoveredView);
        if (!streamTarget) throw new Error('Expected the discovered managed stream');
        const initialBrowserState = seeded
            ? openBrowserTarget(createBrowserViewState(), streamTarget, { platform, browserSessionId: 'presentation-session' })
            : createBrowserViewState();
        if (!seeded) expect(initialBrowserState.viewsById).toEqual({});
        const reads = vi.fn(async (input: Parameters<NonNullable<typeof browserPreviewBoundary.servicesRpc>>[0]) => {
            if (input.method !== RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT) return null;
            const payload = input.payload as Readonly<{ sinceRevision?: number }>;
            if (payload.sinceRevision !== undefined) return new Promise<null>(resolve => {
                input.signal?.addEventListener('abort', () => resolve(null), { once: true });
            });
            return { protocolVersion: 1, revision: 0, snapshot: { v: 1, machineId: 'machine_1',
                generatedAt: 1, refreshState: 'idle', events: [] } };
        });
        browserPreviewBoundary.servicesRpc = input => input.method === RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT ? reads(input) : Promise.resolve(null);
        const host = (visible: boolean) => <PluginSurfaceFocusEligibilityProvider active={visible}><BrowserSurfaceHost browserSessionId={seeded || !sessionId ? view.browserSessionId : 'human-presentation'} platform={platform}
            initialBrowserState={initialBrowserState} visible={visible}
            pluginBrowserActionContext={{ sessionId, machineId: 'machine_1', serverId: scope.serverId }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: true, contextEnabled: false }}
            localServicePreviewState={createLocalServicePreviewState()} testID="human-browser" /></PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(host(true));
        try {
            await vi.waitFor(() => expect(screen.findByType(BrowserShell).props.state.viewsById[view.viewId]).toBeDefined());
            expect(screen.findByType(BrowserShell).props.browserDiagnostics).not.toBeNull();
            expect(reads).not.toHaveBeenCalled();
            await screen.pressByTestIdAsync('human-browser-overflow');
            expect(screen.findByTestId('human-browser-overflow-item-open-diagnostics')).not.toBeNull();
            await screen.pressByTestIdAsync('human-browser-overflow-item-open-diagnostics');
            await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
            expect(reads.mock.calls[0]?.[0]).toMatchObject({ machineId: 'machine_1', serverId: scope.serverId,
                payload: { machineId: 'machine_1', view } });
            expect(reads.mock.calls[1]?.[0].payload).toEqual({ machineId: 'machine_1', view, sinceRevision: 0 });
            expect(screen.findByTestId('human-browser-diagnostics-body')).not.toBeNull();
            // A managed CDP page has interactive diagnostics without an injected iframe bridge.
            // Enter through the real host/menu/drawer rather than supplying a product model.
            expect(screen.findByTestId('human-browser-diagnostics-body-interaction-enable')).not.toBeNull();
            await screen.pressByTestIdAsync('human-browser-diagnostics-body-interaction-enable');
            expect(screen.findByTestId('human-browser-diagnostics-body-eval-input')).not.toBeNull();
            await act(async () => screen.changeTextByTestId('human-browser-diagnostics-body-eval-input', '21 * 2'));
            await screen.pressByTestIdAsync('human-browser-diagnostics-body-eval-submit');
            await vi.waitFor(() => {
                const entries = screen.findByType(BrowserShell).props.browserDiagnostics?.interaction?.evalConsole?.entries;
                expect(entries, JSON.stringify(entries)).toMatchObject([{ expression: '21 * 2', status: 'completed', result: { value: 42 } }]);
            });
            expect(requests).toMatchObject([{ target: { kind: 'machine', machineId: 'machine_1' },
                request: { viewId: view.viewId, navigationGeneration: view.navigationGeneration, tier: 'cdp' } }]);
            const watchSignal = reads.mock.calls[1]?.[0].signal;
            await screen.update(host(false));
            expect(watchSignal?.aborted).toBe(true);
            expect(reads).toHaveBeenCalledTimes(2);
            await screen.update(host(true));
            await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(4));
        } finally {
            await screen.unmount();
            browserStreamBoundary.views = [];
            portalBoundary.restore();
            browser.restore();
        }
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

        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        expect(screen.findByType(BrowserShell).props.browserRecording?.enabled).toBe(true);
        // A preview iframe has no capture source, so the shell's `⋯` does not offer a recording it
        // could never start (H-UX F-5: idle recording lives in `⋯` only where it can run).
        expect(screen.findHostByTestId('browser-surface-overflow-item-start-recording')).toBeNull();
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

    it('retains ready navigation when a later event arrives between commit effects', async () => {
        const { readRegisteredBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), {
            kind: 'streamedBrowser', targetId: 'navigation-stream', streamId: 'navigation-stream',
        }, { browserSessionId: 'session_1', viewId: 'agent-view', platform: 'web', currentUrl: 'https://first.test/' });
        let control: ReturnType<typeof readRegisteredBrowserRuntimeControlAdapter>;
        let readyDelivered = false;
        let controllerDelivered = false;
        const navigation = { kind: 'navigationStateChanged' as const, browserSessionId: 'session_1', viewId: 'agent-view',
            currentUrl: 'https://next.test/', canGoBack: true, canGoForward: false };
        const renderHost = (width: number) => <BrowserSurfaceHost
            browserSessionId="session_1" platform="web" initialBrowserState={initialBrowserState}
            surfaceKey="navigation-race" presentationSlotId="details:navigation" visible active
            measuredRect={{ x: 0, y: 0, width, height: 600 }}
            pluginBrowserActionContext={{ sessionId: 'session_1' }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            productModels={{ browserProfile: { profile: sessionBrowserProfile } }}
            browserFeatureDecision={enabledBrowserDecision}
            onViewStateChange={view => {
                if (readyDelivered || view.currentUrl !== navigation.currentUrl) return;
                readyDelivered = true;
                // Loaded trace: navigation 57/ready reaches the owner before its prior commit's effects finish.
                void control?.applyDaemonEvents?.([{ ...navigation, eventId: 'ready-57', occurredAt: 57,
                    navigationGeneration: 57, loadingState: 'ready' }]);
            }}
            onLifecycleChange={() => {
                if (!readyDelivered || controllerDelivered) return;
                controllerDelivered = true;
                // The next received controller event must use the latest navigation projection.
                void control?.applyDaemonEvents?.([{ kind: 'controllerChanged', eventId: 'controller-56', occurredAt: 58,
                    browserSessionId: 'session_1', viewId: 'agent-view', navigationGeneration: 56,
                    state: { browserSessionId: 'session_1', viewId: 'agent-view', controller: 'human', controlEpoch: 17,
                        interruptionSettling: false, uncertain: false } }]);
            }} testID="browser-surface" />;
        const screen = await renderScreen(renderHost(800));
        control = readRegisteredBrowserRuntimeControlAdapter('session_1', 'agent-view');
        expect(control).toBeDefined();
        await act(async () => {
            void control?.applyDaemonEvents?.([{ ...navigation, eventId: 'loading-56', occurredAt: 56,
                navigationGeneration: 56, loadingState: 'loading' }]);
            await screen.update(renderHost(801));
        });
        expect(readyDelivered && controllerDelivered).toBe(true);
        expect(control?.readState()?.viewsById['agent-view']).toMatchObject({
            navigationGeneration: 57, loadingState: 'ready', currentUrl: navigation.currentUrl,
        });
    });

    it('keeps the workspace tab when a profile switch closes and reopens its logical view in one receipt', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { BrowserShell } = await import('../BrowserShell');
        const { readRegisteredBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Browser test Account was not restored');
        const streamedTarget = { kind: 'streamedBrowser' as const, targetId: 'profile-stream', streamId: 'profile-stream' };
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), streamedTarget, {
            browserSessionId: 'session_1', viewId: 'agent-view', platform: 'web',
        });
        const original = initialBrowserState.viewsById['agent-view']!;
        const onCloseTab = vi.fn();
        const screen = await renderScreen(<BrowserSurfaceHost browserSessionId="session_1" platform="web"
            initialBrowserState={initialBrowserState} onCloseTab={onCloseTab}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: scope.serverId }}
            productModels={{ browserProfile: { profile: sessionBrowserProfile } }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            browserFeatureDecision={enabledBrowserDecision} testID="browser-surface" />);
        const control = readRegisteredBrowserRuntimeControlAdapter('session_1', 'agent-view');
        expect(control).toBeDefined();
        const selectedProfile = { profileId: 'saved-work', displayName: 'Work', storageMode: 'user' as const,
            owner: { kind: 'user' as const, id: 'saved-work' }, cleanupOnSessionClose: false };
        const selection = screen.findByType(BrowserShell).props.browserProfile.management.source.selection;
        expect(screen.findByType(BrowserShell).props.browserProfile.profile.storageMode).toBe('session');
        await act(async () => selection.onSelected(selectedProfile, [
            { kind: 'viewClosed', eventId: 'switch-close', browserSessionId: 'session_1', viewId: 'agent-view', occurredAt: 1000 },
            { kind: 'sessionCreated', eventId: 'switch-profile', browserSessionId: 'session_1', profileId: selectedProfile.profileId, occurredAt: 1001 },
            { kind: 'viewOpened', eventId: 'switch-open', browserSessionId: 'session_1', viewId: 'agent-view', occurredAt: 1001,
                platform: 'web', target: streamedTarget, adapterKind: original.adapterKind, engineKind: original.engineKind,
                adapterCapabilities: original.adapterCapabilities },
        ]));
        expect(control?.readState()?.viewsById['agent-view']).toBeDefined();
        expect(onCloseTab).not.toHaveBeenCalled();
        expect(screen.findByType(BrowserShell).props.browserProfile.profile).toMatchObject(selectedProfile);
        await act(async () => control?.applyDaemonEvents?.([{ kind: 'sessionCreated', eventId: 'other-profile',
            browserSessionId: 'session_1', profileId: 'other-profile', occurredAt: 1002 }]));
        expect(screen.findByType(BrowserShell).props.browserProfile.profile.storageMode).toBe('session');
        await screen.unmount();
    });

    it('keeps the Browser region for restart recovery after the live view closes and on re-entry', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { BrowserShell } = await import('../BrowserShell');
        const { readRegisteredBrowserRuntimeControlAdapter } = await import('@/sync/domains/browser/actions/runtimeControlRegistry');
        const onCloseTab = vi.fn();
        const initialBrowserState = openBrowserTarget(createBrowserViewState(), {
            kind: 'streamedBrowser', targetId: 'restart-source', streamId: 'restart-source',
        }, { browserSessionId: 'session_1', viewId: 'agent-view', platform: 'web' });
        const command = { kind: 'openView', commandId: 'kept-open', browserSessionId: 'session_1',
            viewId: 'agent-view', platform: 'web', target: externalTarget, profileId: 'saved-work', focus: true };
        const closed = { kind: 'viewClosed' as const, eventId: 'restart-closed', browserSessionId: 'session_1',
            viewId: 'agent-view', occurredAt: 1000, reasonCode: 'daemon_restarted' };
        const host = (seeded: boolean) => <BrowserSurfaceHost browserSessionId="session_1" platform="web"
            initialBrowserState={seeded ? initialBrowserState : createBrowserViewState()} onCloseTab={onCloseTab}
            pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: 'srv_browser_client_action' }}
            policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
            browserFeatureDecision={enabledBrowserDecision} testID="restart-browser" />;
        const screen = await renderScreen(host(true));
        try {
            // Restart inventory has a terminal recovery record, with no live capture source.
            browserStreamBoundary.views = [{ browserSessionId: 'session_1', viewId: 'agent-view',
                sourceId: 'restarted:agent-view', target: externalTarget, platform: 'web',
                adapterKind: 'chromiumSidecar', closedAfterRestart: command, events: [closed] }];
            const control = readRegisteredBrowserRuntimeControlAdapter('session_1', 'agent-view');
            await act(async () => control?.applyDaemonEvents?.([closed]));
            expect(onCloseTab).not.toHaveBeenCalled();
            expect(screen.findByType(BrowserShell).props.state.viewsById['agent-view']).toBeUndefined();
            await screen.unmount();
            const reentered = await renderScreen(host(false));
            try {
                await flushHookEffects();
                const { BrowserLaunchpad } = await import('../launchpad/BrowserLaunchpad');
                expect(reentered.findByType(BrowserLaunchpad).props.agentBrowser).toMatchObject({
                    reasonCode: 'daemon_restarted', onRetry: expect.any(Function),
                });
            } finally { await reentered.unmount(); }
        } finally { browserStreamBoundary.views = []; await screen.unmount(); }
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
        const onCloseTab = vi.fn();
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
            onCloseTab={onCloseTab}
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
        await act(async () => control?.applyDaemonEvents?.([{
            kind: 'viewOpened', eventId: 'other-open', browserSessionId: 'session_1', viewId: 'other-view',
            occurredAt: 998, platform: 'web', target,
            adapterKind: initialBrowserState.viewsById['agent-view']!.adapterKind,
            engineKind: initialBrowserState.viewsById['agent-view']!.engineKind,
            adapterCapabilities: initialBrowserState.viewsById['agent-view']!.adapterCapabilities,
        }, { kind: 'viewClosed', eventId: 'other-close', browserSessionId: 'session_1', viewId: 'other-view', occurredAt: 999 }]));
        expect(onCloseTab).not.toHaveBeenCalled();
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
        expect(onCloseTab).toHaveBeenCalledTimes(1);
        await screen.unmount();
        expect(dispose).toHaveBeenCalledTimes(1);
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
        // Idle, the drawer is not drawn (lab Q); open it from ⋯ to place it.
        await screen.pressByTestIdAsync('browser-surface-overflow');
        await screen.pressByTestIdAsync('browser-surface-overflow-item-open-diagnostics');
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
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
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

    it.each(['registered Session', 'unregistered Project'] as const)('opens the running Service preview for a localhost port typed in the toolbar address (%s)', async scope => {
        replacePersistentUiStateForTest(browserRecentsState, {});
        const project = scope === 'unregistered Project';
        browserFeatures = createRootLayoutFeaturesResponse({ features: { browser: {
            enabled: true, internal: { enabled: true }, viewTargets: { enabled: true },
        } } });
        const { getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expect((await getServerFeaturesSnapshot({ force: true })).status).toBe('ready');
        const declaration = { workspaceRefId: 'project-web', selection: { kind: 'manifest', name: 'web' } } as const;
        const serviceTarget = { kind: 'managed_service', managedServiceId: 'project-web',
            machineId: 'machine_1', cwd: '/repo/project', declaration } as const;
        const previewTarget = project ? { ...target, sessionId: undefined, serviceTarget } : target;
        const registeredUrl = 'https://preview.happier.test/typed-port';
        const resource: LocalServicePreviewResourceV1 = {
            previewId: 'preview_1', ...(project ? { serviceTarget } : { sessionId: 'session_1' }), machineId: 'machine_1',
            owner: project ? { kind: 'user', id: 'account-1' } : { kind: 'session', id: 'session_1' },
            target: { scheme: 'https', host: 'localhost', port: 5173 },
            initialPath: { pathname: '/', search: '' },
            display: target.display, originMode: 'host', browserTarget: previewTarget,
        };
        const preview = { previewId: resource.previewId, resource, accessUrl: registeredUrl, expiresAt: null, diagnostics: [] };
        browserPreviewBoundary.response = { protocolVersion: 1, status: 'existing', preview,
            snapshot: { v: 1, machineId: resource.machineId, generatedAt: 100, refreshState: 'idle',
                resources: [resource], previews: [preview], diagnostics: [] } };
        const opens: unknown[] = [];
        browserActionHttp = async (input) => {
            if (new URL(String(input)).pathname === '/v1/actions/browser.view.open') opens.push(input);
            return null;
        };
        const localServiceTargets = project ? [{ id: 'managed:project-web', source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'project-web' },
            machineId: 'machine_1', cwd: '/repo/project', declaration, title: 'Project Web',
            confidence: 'high', state: 'available', serviceState: 'running',
            endpointUrl: 'http://127.0.0.1:5173/', actions: ['register_preview'],
        } satisfies import('@happier-dev/protocol/local/services/launcher/v1').LocalServiceLaunchTargetV1] : undefined;
        const { buildBrowserLaunchpadRows } = await import('@/sync/domains/browser/targets');
        const launchpadRows = localServiceTargets ? buildBrowserLaunchpadRows({ launcherSnapshot: {
            v: 1, machineId: 'machine_1', updatedAt: 100, targets: localServiceTargets,
        } }) : [{
            id: 'localService:preview_1', section: 'running', sourceKind: 'localService', title: 'Preview',
            subtitle: 'localhost:5173', detail: 'vite', target, currentUrl: 'https://preview.happier.test/',
            disabledReason: null, lastSeenAt: 100,
        }] as const;
        const { createBrowserViewDetailsSurfaceRenderer } = await import('./browserDetailsSurfaceRenderer');
        const { createBrowserLaunchpadDetailsTab } = await import('./browserSurfaceDetailsTabModel');
        const workspaceScope = { kind: 'project', workspaceRefId: 'project-web', serverId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId,
            machineId: 'machine_1', rootPath: '/repo/project', activeRootPath: '/repo/project' } as const;
        const renderer = createBrowserViewDetailsSurfaceRenderer({ machineId: workspaceScope.machineId,
            serverId: workspaceScope.serverId, pluginAccountLifetime: captureActiveServerAccountScopeLifetime(), platform: 'web',
            launchpadRows, localServiceTargets, localServicePreviewState: createLocalServicePreviewState(),
            browserFeatureDecision: enabledBrowserDecision });
        const screen = await renderScreen(project ? <>{renderer.render({
            tab: { ...createBrowserLaunchpadDetailsTab(), isPinned: true, isPreview: false },
            scope: workspaceScope, region: 'details', active: true, callbacks: {},
            descriptor: { surfaceId: 'project-web:browser', resourceKey: 'browser-launchpad',
                scope: workspaceScope, region: 'details', status: 'available' },
        })}</> : <BrowserSurfaceHost browserSessionId="browser_session_default" platform="web"
                initialBrowserState={createBrowserViewState()}
                policy={{ browserEnabled: true, viewTargetsEnabled: true, diagnosticsEnabled: false, contextEnabled: false }}
                launchpadRows={launchpadRows} localServiceTargets={localServiceTargets}
                localServicePreviewState={createLocalServicePreviewState()}
                browserFeatureDecision={enabledBrowserDecision}
                pluginBrowserActionContext={{ sessionId: 'session_1', machineId: 'machine_1', serverId: BROWSER_CLIENT_ACTION_ORIGIN.serverIdentityId }}
                testID="browser-surface" />,
        );
        const addressId = project ? 'browser-view-details-surface-address' : 'browser-surface-address';
        await act(async () => { screen.changeTextByTestId(addressId, 'localhost:5173'); });
        await act(async () => {
            (screen.findByTestId(addressId)?.props as { onSubmitEditing?: () => void }).onSubmitEditing?.();
        });
        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe(registeredUrl));
        expect(opens).toEqual([]);
        expect(browserRecentsState.read(serverAccountScopeKeySuffix(getActiveServerAccountScope()!)))
            .toEqual([expect.objectContaining({ target: previewTarget })]);
        await act(async () => { screen.changeTextByTestId(addressId, 'https://docs.happier.test/recents-followup'); });
        await act(async () => { screen.findByTestId(addressId)?.props.onSubmitEditing?.(); });
        await vi.waitFor(() => expect(screen.findByType('iframe').props.src).toBe('https://docs.happier.test/recents-followup'));
        expect(browserRecentsState.read(serverAccountScopeKeySuffix(getActiveServerAccountScope()!))?.[0]?.target)
            .toMatchObject({ kind: 'externalUrl', url: 'https://docs.happier.test/recents-followup' });
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
});
