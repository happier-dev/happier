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
    type PluginMachineExecutionOriginV1,
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
import { AppState } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationCaptureSurface } from '@/components/browser/annotation';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import {
    getInstalledPluginUiClientExecutableComposition,
    type PluginUiClientExecutableActivation,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { createReactNativeAppStateEmitter } from '@/dev/testkit/mocks/reactNative';
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

installTerminalRouteCommonModuleMocks();

// Metro's lazy require is a module-loading boundary absent in Vitest. Inject the
// actual executor through the existing port; policy and Browser owners stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    return { ...actual, createFrontDoorActionExecute: (
        executor?: Parameters<typeof actual.createFrontDoorActionExecute>[0],
        options?: Parameters<typeof actual.createFrontDoorActionExecute>[1],
    ) => actual.createFrontDoorActionExecute(executor ?? createDefaultActionExecutor(options), options) };
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
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            occurrenceId: 'acme-browser-occurrence-1',
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
    serverId: 'srv_browser_client_action',
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
beforeEach(async () => {
    browserPreviewBoundary.response = null;
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
    browserAccountConnection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-1', request: async (input) => {
        const path = new URL(String(input)).pathname;
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
});

describe('BrowserSurfaceHost', () => {
    it('does not reload the mounted page when the Browser Action is disabled for UI', async () => {
        const { BrowserSurfaceHost } = await import('./BrowserSurfaceHost');
        const { BrowserShell } = await import('@/components/browser/BrowserShell');
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState().settings.actionsSettingsV1;
        storage.setState({ settings: { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { 'browser.reload': { enabled: false } } }),
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
            await flushHookEffects();
            expect(screen.findByType('iframe').props['data-browser-navigation-key']).toBe(previousNavigation);
        } finally {
            storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: previous } });
        }
    });

    it('subscribes only while both the host and browser surface are visible', async () => {
        const appState = createReactNativeAppStateEmitter('background');
        const restore = appState.install(AppState);
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
            expect(browserStreamBoundary.listeners.size).toBe(0);
            await act(async () => appState.emit('active'));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(1);
            await screen.update(renderHost(false));
            expect(browserStreamBoundary.listeners.size).toBe(0);
            await screen.update(renderHost(true));
            await flushHookEffects({ cycles: 6, turns: 6 });
            expect(browserStreamBoundary.listeners.size).toBe(1);
            await screen.unmount();
            expect(browserStreamBoundary.listeners.size).toBe(0);
        } finally {
            appState.emit('active');
            restore();
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
            const invoking = executePluginBrowserAction({
                action: browserAction, machineId: target.machineId,
                serverId: accountLifetime.scope.serverId, sessionId: target.sessionId,
                input: { targetId: target.targetId },
                policyContext: { profileMode: 'session', isFeatureEnabled: () => true },
                resolveContributedAction: createPluginUiProjectedActionResolver(fixture.pluginUiProjection.actionsById),
                pluginUiProjection: fixture.pluginUiProjection,
                isCurrent: accountLifetime.isCurrent, readCurrentUiContext,
            });
            await vi.waitFor(() => expect(browserActionModal.shown()).toBe(true));
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

    it('does not mount the injected diagnostics drawer for local-preview web iframes without a supported producer', async () => {
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
        expect(sendDaemonCommand).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'navigate', browserSessionId: 'session_1', viewId: 'agent-view', url: 'https://next.test/',
        }), expect.any(Function));
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

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');

        await screen.update(renderHost('https://preview.happier.test/refreshed'));

        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/dashboard');
    });

    it('renders browser panel plugin placements for the active browser target', async () => {
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
                pluginBrowserActionContext={{
                    machineId: 'machine_1',
                    serverId: 'srv_browser_client_action',
                    sessionId: 'session_1',
                }}
                testID="browser-surface"
            />,
        );

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
                onViewTargetChange={onViewTargetChange}
                testID="browser-surface"
            />,
        );

        await act(async () => {
            await screen.pressByTestIdAsync('browser-surface-launchpad-card:localService:preview_1');
        });

        expect(screen.findByTestId('browser-surface-launchpad')).toBeNull();
        // Blurred address field shows the pretty display URL (scheme/trailing-slash trimmed).
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('preview.happier.test/current-registration');
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

    it('routes annotation Select through the diagnostics element picker for the active surface view', async () => {
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

        expect(screen.findHostByTestId('browser-surface-annotation-editor-tool:select')?.props.accessibilityState?.disabled).not.toBe(true);
        screen.findByType(AnnotationCaptureSurface).props.onPick({ x: 18, y: 24 });

        expect(onStartElementPicker).toHaveBeenCalledTimes(1);
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
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('docs.happier.test/changelog');
    });
});
