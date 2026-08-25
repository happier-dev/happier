import * as React from 'react';
import { readFile } from 'node:fs/promises';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    PluginProjectionInstalledPackageV2Schema,
    PluginProjectedActionV2Schema,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';
import {
    computePluginUiArtifactSha256DigestV1,
    normalizePluginUiDestinationBindingV1,
    PluginUiArtifactsManifestEntryV1Schema,
    type CurrentUiContextSnapshotV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces/PluginSurfaceHost';
import type { PluginSurfaceHostApiV1 } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import {
    getInstalledPluginUiClientExecutableComposition,
    type PluginUiClientExecutableActivation,
    type PluginUiClientExecutableComposition,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import type {
    PluginReactNativeExecutableExport,
    PluginReactNativeLoaderBackend,
} from '@/components/plugins/reactNative/loader';
import { loadPluginReactNativeBundleExport } from '@/components/plugins/reactNative/loader';
import { createReactNativeWebLoaderBackend } from '@/components/plugins/reactNative/webLoaderBackend.web';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    clearTabActiveServerId,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { storage } from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

import {
    CurrentUiContextProvider,
    type CurrentUiContextReader,
    useOptionalCurrentUiContextReader,
} from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accountCredentials = vi.hoisted(() => ({
    value: { token: 'acme.current-ui-composition-test-token' } as Readonly<{ token: string }> | null,
}));

const accountServerFetch = vi.hoisted(() => vi.fn<
    typeof import('@/sync/http/client').serverFetch
>());

const nativeHostLifecycle = vi.hoisted(() => ({
    appState: 'active' as 'active' | 'background',
    appStateListeners: new Set<(state: string) => void>(),
}));

const hostedRenderer = vi.hoisted(() => ({
    currentUiReader: null as CurrentUiContextReader | null,
    currentUiLabelBeforeBPublication: undefined as string | null | undefined,
    hostApi: null as PluginSurfaceHostApiV1 | null,
    packedRenderSurface: null as ((context: RenderContext) => React.ReactElement | null) | null,
    surfaceContext: null as PluginUiSurfaceContextV1 | null,
    responses: [] as Array<Readonly<{ subPath: string; response: unknown }>>,
}));

vi.mock('expo-router', () => ({
    useGlobalSearchParams: () => ({ pluginId: 'acme.current-ui-composition', localId: 'notes' }),
    usePathname: () => '/plugins/acme.current-ui-composition/notes',
    useSegments: () => ['(app)', 'plugins', '[pluginId]', '[localId]'],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        AppState: {
            get currentState() {
                return nativeHostLifecycle.appState;
            },
            addEventListener: (_event: string, listener: (state: string) => void) => {
                nativeHostLifecycle.appStateListeners.add(listener);
                return { remove: () => nativeHostLifecycle.appStateListeners.delete(listener) };
            },
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

vi.mock('@/hooks/ui/useScreenReaderEnabled', () => ({
    useScreenReaderEnabled: () => false,
}));

vi.mock('@/hooks/ui/useHighContrastPreference', () => ({
    useHighContrastPreference: () => false,
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', async () => {
    const { createMainAppTabStateProviderMock } = await import(
        '@/dev/testkit/mocks/mainAppTabState'
    );
    return createMainAppTabStateProviderMock().module;
});

vi.mock('@/sync/http/client', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/http/client')>();
    return {
        ...original,
        serverFetch: (...args: Parameters<typeof original.serverFetch>) => (
            accountServerFetch(...args)
        ),
    };
});

vi.mock('@/sync/sync', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/sync')>();
    return {
        ...original,
        // Credentials are a process boundary. Keep the real Sync owner for
        // every other method while the account-mode request stays deterministic.
        sync: new Proxy(original.sync, {
            get(target, property) {
                if (property === 'getCredentials') {
                    return () => accountCredentials.value;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

type HostedWebPaneBoundaryProps = Readonly<{
    hostApi: PluginSurfaceHostApiV1;
    surfaceContext: PluginUiSurfaceContextV1;
    subPath?: string;
}>;

/**
 * The physical hosted-web renderer is outside the current-context owner. It
 * emits the author-facing raw request; the real bound host parses, qualifies,
 * and publishes it through the real provider-local mount capability.
 */
vi.mock('@/components/plugins/hostedWeb/PluginHostedWebPane', async () => {
    const ReactModule = await import('react');
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import(
        '@/components/plugins/reactNative/hostApi'
    );
    const { createPluginSurfaceContextFixture } = await import(
        '@/dev/testkit/fixtures/pluginSurfaceContextFixture'
    );
    const PackedArtifactSurface = (props: HostedWebPaneBoundaryProps): React.ReactElement | null => {
        const renderSurface = hostedRenderer.packedRenderSurface;
        const abortController = ReactModule.useMemo(() => new AbortController(), []);
        const surface = ReactModule.useMemo(
            () => createPluginSurfaceContextFixture(),
            [],
        );
        const adapter = ReactModule.useMemo(() => createCanonicalPluginReactNativeHostApiAdapter({
            surface,
            requestSurface: props.surfaceContext,
            requestIdPrefix: `packed-current-context:${props.subPath ?? ''}`,
            handleRequest: props.hostApi.handleRequest,
            installedMethods: props.hostApi.installedMethods,
            getInstalledMethods: () => props.hostApi.installedMethods,
            getAdmissionMethods: () => props.hostApi.admissionMethods,
        }), [props.hostApi, props.subPath, props.surfaceContext, surface]);
        ReactModule.useLayoutEffect(() => () => {
            abortController.abort();
            adapter.dispose();
        }, [abortController, adapter]);
        const context = ReactModule.useMemo(() => Object.freeze({
            plugin: Object.freeze({ id: props.surfaceContext.pluginId, version: '1.0.0' }),
            surface,
            hostApi: adapter.api,
            signal: abortController.signal,
        }) satisfies RenderContext, [abortController.signal, adapter.api, props.surfaceContext.pluginId, surface]);
        return renderSurface ? renderSurface(context) as React.ReactElement : null;
    };
    const PluginHostedWebPane = (props: HostedWebPaneBoundaryProps): React.ReactElement => {
        ReactModule.useLayoutEffect(() => {
            hostedRenderer.hostApi = props.hostApi;
            hostedRenderer.surfaceContext = props.surfaceContext;
            const subPath = props.subPath ?? '';
            if (hostedRenderer.packedRenderSurface) return;
            if (subPath === 'notes/b') {
                hostedRenderer.currentUiLabelBeforeBPublication = (
                    hostedRenderer.currentUiReader?.readCurrentUiContext()?.entity?.label ?? null
                );
            }
            const enrichment = subPath === 'notes/a'
                ? {
                    entity: { kind: 'issue', label: 'Issue A', reference: { number: 1 } },
                    commands: [{
                        title: 'Open issue B',
                        command: {
                            kind: 'openSurface',
                            // This author-facing local id must be qualified by
                            // the real bound controller, not by this fixture.
                            destination: 'notes',
                            input: { issueNumber: 2 },
                        },
                    }],
                }
                : {
                    entity: { kind: 'issue', label: 'Issue B', reference: { number: 2 } },
                    commands: [{
                        title: 'Open issue C',
                        command: {
                            kind: 'openSurface',
                            destination: 'notes',
                            input: { issueNumber: 3 },
                        },
                    }],
                };
            const request: PluginUiHostApiRequestEnvelopeV1 = {
                version: 1,
                requestId: `acme.current-ui-composition:${subPath}`,
                surface: props.surfaceContext,
                method: 'publishCurrentUiContext',
                payload: { enrichment },
            };
            void Promise.resolve(props.hostApi.handleRequest(request)).then(
                (response) => {
                    hostedRenderer.responses.push(Object.freeze({ subPath, response }));
                },
                () => {
                    hostedRenderer.responses.push(Object.freeze({ subPath, response: 'rejected' }));
                },
            );
        }, [props.hostApi, props.subPath, props.surfaceContext]);
        if (hostedRenderer.packedRenderSurface) {
            return ReactModule.createElement(PackedArtifactSurface, props);
        }
        return ReactModule.createElement('View', {
            testID: `hosted-current-ui:${props.subPath ?? 'root'}`,
        });
    };
    return { PluginHostedWebPane };
});

function requireReader(reader: CurrentUiContextReader | null): CurrentUiContextReader {
    if (reader === null) throw new Error('Expected the real CurrentUiContextProvider reader.');
    return reader;
}

function setNativeAppState(nextState: 'active' | 'background'): void {
    nativeHostLifecycle.appState = nextState;
    for (const listener of [...nativeHostLifecycle.appStateListeners]) {
        listener(nextState);
    }
}

const destinationBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'acme.current-ui-composition',
    destinationId: 'notes',
    rendererId: 'panel',
    container: 'appPage',
    target: { kind: 'app' },
});

if (destinationBinding === null) {
    throw new Error('Expected the app-page fixture binding to normalize.');
}

const CLIENT_ACTION_ORIGIN: PluginMachineExecutionOriginV1 = Object.freeze({
    serverIdentityId: 'srv_current_ui_context_client_action',
    materializationRef: Object.freeze({
        pluginId: destinationBinding.destination.pluginId,
        machineId: 'machine-current-ui-context-client-action',
        materializationId: 'materialization-current-ui-context-client-action',
    }),
});

const placement = Object.freeze({
    id: 'surfacePlacement:acme.current-ui-composition:notes',
    pluginId: 'acme.current-ui-composition',
    serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
    materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
    contributionKind: 'surfacePlacement',
    descriptorId: 'notes',
    binding: destinationBinding,
    target: destinationBinding.target,
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Notes' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
} satisfies PluginUiSurfacePlacementProjection);

const projection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    generation: 1,
    surfacePlacementsById: {
        [placement.id]: placement,
    },
    hostedWebById: {
        'hostedWeb:acme.current-ui-composition:panel': {
            id: 'hostedWeb:acme.current-ui-composition:panel',
            pluginId: 'acme.current-ui-composition',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['hostApi'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: { state: 'render', reason: 'available', diagnostics: [] },
            },
        },
    },
};
if (projection.generation === null) {
    throw new Error('Expected the current test plugin UI projection generation.');
}
// Annotated at the declaration: a module-scope control-flow narrowing does not
// reach the closures below, so the fixture's generation has to be `number` here.
const projectionGeneration: number = projection.generation;

const CLIENT_ACTION_ID = 'read-current-ui-context';
const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'current-ui-context-client-action',
    modulePath: './actions/readCurrentUiContext',
    exportName: 'execute',
    platform: 'ios' as const,
});
const CLIENT_ACTION_ORIGIN_PROJECTION = Object.freeze({
    machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
    serverId: 'server-current-ui-context-client-action',
    generation: projectionGeneration,
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: CLIENT_ACTION_ORIGIN,
});
const CLIENT_ACTION_AUTHORIZATION = Object.freeze({
    generation: Object.freeze({
        targetGeneration: String(projectionGeneration),
        desiredGeneration: String(projectionGeneration),
        appliedGeneration: String(projectionGeneration),
    }),
    resourceSelections: Object.freeze([]),
    scopedGrants: Object.freeze([]),
    serviceAvailability: Object.freeze([]),
    operatingSystemAuthorization: Object.freeze([]),
});

function createMountedClientActionFixture(handler: PluginClientActionHandler): Readonly<{
    activation: PluginUiClientExecutableActivation;
    composition: PluginUiClientExecutableComposition;
    projection: PluginUiProjectionModel;
}> {
    const action = PluginProjectedActionV2Schema.parse({
        id: CLIENT_ACTION_ID,
        pluginId: placement.pluginId,
        title: 'Read current UI context',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                modulePath: CLIENT_ACTION_TARGET.modulePath,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
        materializationRef: CLIENT_ACTION_ORIGIN.materializationRef,
        dangerLevel: 'safe',
        available: true,
        authorization: CLIENT_ACTION_AUTHORIZATION,
    });
    const projectedAction = Object.freeze({
        ...action,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: CLIENT_ACTION_ORIGIN_PROJECTION,
    });
    const artifactGraph = PluginUiArtifactsManifestEntryV1Schema.parse({
        contributionId: CLIENT_ACTION_TARGET.artifactId,
        tier: 'reactNative',
        platform: CLIENT_ACTION_TARGET.platform,
        entry: 'react-native/current-ui-context-client-action/ios.bundle',
        files: [{
            relativePath: 'react-native/current-ui-context-client-action/ios.bundle',
            digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
            byteSize: 10,
        }],
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        builtWith: { bundler: 'repack', version: '5.2.5' },
        repack: {
            containerName: 'current_ui_context_client_action',
            modulePath: CLIENT_ACTION_TARGET.modulePath,
            exportName: CLIENT_ACTION_TARGET.exportName,
        },
        hostUiApiVersion: '1.0.0',
        compat: { react: '19.0.0', reactNative: '0.83.4' },
    });
    const cacheIdentity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: placement.pluginId,
        contributionId: CLIENT_ACTION_ID,
        artifactDigest: artifactGraph.digest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        platform: CLIENT_ACTION_TARGET.platform,
        channel: 'internal',
        nativeCapabilitiesDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectionGeneration,
    });
    const fixtureProjection = Object.freeze({
        ...projection,
        installedPackagesById: Object.freeze({
            ...projection.installedPackagesById,
            [placement.pluginId]: PluginProjectionInstalledPackageV2Schema.parse({
                id: placement.pluginId,
                displayName: 'Current UI composition',
                version: '1.2.3',
                enabled: true,
                source: { kind: 'localPath', locator: placement.pluginId },
            }),
        }),
        actionsById: Object.freeze({
            [`${placement.pluginId}/${CLIENT_ACTION_ID}`]: projectedAction,
        }),
        reactNativeBundlesById: Object.freeze({
            [`reactNativeBundle:${placement.pluginId}:${CLIENT_ACTION_ID}`]: Object.freeze({
                id: `reactNativeBundle:${placement.pluginId}:${CLIENT_ACTION_ID}`,
                pluginId: placement.pluginId,
                contributionKind: 'reactNativeBundle' as const,
                contributionId: CLIENT_ACTION_ID,
                generatedOwnerKind: 'clientContribution' as const,
                artifactGraph,
                runtime: Object.freeze({
                    decision: Object.freeze({ state: 'load' }),
                    loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                    cacheIdentity,
                }),
                [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: CLIENT_ACTION_ORIGIN_PROJECTION,
            }),
        }),
    }) satisfies PluginUiProjectionModel;
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection: fixtureProjection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const resolvedAction = resolved[0];
    if (!resolvedAction || resolved.length !== 1) {
        throw new Error('Expected the real client executable projection to resolve one Action.');
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: resolvedAction.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]),
        format: 'plainJs',
    });
    const activate = (api: PluginClientApi): void => {
        api.actions.register(CLIENT_ACTION_ID, handler);
    };
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'repackScriptManager',
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
    return Object.freeze({
        activation,
        composition: getInstalledPluginUiClientExecutableComposition(),
        projection: fixtureProjection,
    });
}

function CurrentUiReaderProbe(props: Readonly<{
    onReader: (reader: CurrentUiContextReader | null) => void;
}>): null {
    const reader = useOptionalCurrentUiContextReader();
    hostedRenderer.currentUiReader = reader;
    props.onReader(reader);
    return null;
}

function renderComposedSurface(input: Readonly<{
    serverId: string;
    subPath: string;
    focusEligible?: boolean;
    showSurface?: boolean;
    pluginUiProjection?: PluginUiProjectionModel;
    onReader: (reader: CurrentUiContextReader | null) => void;
}>): React.ReactElement {
    const focusEligible = input.focusEligible ?? true;
    return (
        <AppPaneProvider>
            <CurrentUiContextProvider>
                <PluginSurfaceFocusEligibilityProvider
                    active={focusEligible}
                    currentUiContextActive={focusEligible}
                >
                    {input.showSurface !== false ? (
                        <PluginSurfacePlacementHost
                            placement={placement}
                            serverId={input.serverId}
                            pluginUiProjection={input.pluginUiProjection ?? projection}
                            platform="web"
                            projectionInteractionEnabled
                            subPath={input.subPath}
                        />
                    ) : null}
                </PluginSurfaceFocusEligibilityProvider>
                <CurrentUiReaderProbe onReader={input.onReader} />
            </CurrentUiContextProvider>
        </AppPaneProvider>
    );
}

async function loadPackedExternalVoiceFixtureRenderSurface(): Promise<(
    context: RenderContext,
) => React.ReactElement | null> {
    const fixtureRoot = new URL(
        '../../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
        import.meta.url,
    );
    const artifactBytes = await readFile(new URL(
        'dist/happier-plugin-ui/react-native-web/voice-runtime-web/entry.mjs.bundle',
        fixtureRoot,
    ));
    const bytes = new Uint8Array(artifactBytes);
    const digest = computePluginUiArtifactSha256DigestV1(bytes);
    const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: 'acme.packed-voice',
        contributionId: 'voice-runtime-web',
        artifactDigest: digest,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.2.0',
        reactNativeVersion: '0.83.5',
        platform: 'web',
        channel: 'internal',
        nativeCapabilitiesDigest: `sha256:${'a'.repeat(64)}`,
        projectionGeneration: 12,
    });
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
    const source = new TextDecoder().decode(bytes);
    const backend = createReactNativeWebLoaderBackend({
        importModule: async () => import(
            /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}#${digest}`
        ) as Promise<Readonly<{ default?: unknown } & Record<string, unknown>>>,
    });
    const loaded = await loadPluginReactNativeBundleExport({
        cache,
        identity,
        moduleReference: { exportName: 'renderSurface' },
        backend,
        hostPlatform: 'web',
    });
    if (!loaded.ok) {
        throw new Error(`packed_external_voice_fixture_render_surface_unavailable:${loaded.code}`);
    }
    return loaded.exported as unknown as (context: RenderContext) => React.ReactElement | null;
}

beforeEach(async () => {
    await getInstalledPluginUiClientExecutableComposition().unload();
    nativeHostLifecycle.appState = 'active';
    hostedRenderer.currentUiReader = null;
    hostedRenderer.currentUiLabelBeforeBPublication = undefined;
    hostedRenderer.hostApi = null;
    hostedRenderer.packedRenderSurface = null;
    hostedRenderer.surfaceContext = null;
    hostedRenderer.responses.length = 0;
    accountCredentials.value = { token: 'acme.current-ui-composition-test-token' };
    accountServerFetch.mockReset();
    accountServerFetch.mockImplementation(async (path) => {
        if (path !== '/v1/account/encryption') {
            throw new Error(`Unexpected network request: ${path}`);
        }
        return new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    invalidateAccountEncryptionModeCache();
});

afterEach(async () => {
    standardCleanup();
    await getInstalledPluginUiClientExecutableComposition().unload();
    retireActiveServerAccountScopeLifetime();
    storage.getState().clearProfileScope();
    clearTabActiveServerId();
    registerStorageStateReader(() => storage.getState());
    invalidateAccountEncryptionModeCache();
    accountCredentials.value = null;
    accountServerFetch.mockReset();
    hostedRenderer.currentUiReader = null;
    hostedRenderer.currentUiLabelBeforeBPublication = undefined;
    hostedRenderer.hostApi = null;
    hostedRenderer.packedRenderSurface = null;
    hostedRenderer.surfaceContext = null;
    hostedRenderer.responses.length = 0;
    nativeHostLifecycle.appState = 'active';
});

describe('CurrentUiContextProvider + PluginSurfaceHost composition', () => {
    it('lends the current provider snapshot to a registered client Action through the real mounted Host API', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://acme.current-ui-client-action.test',
            name: 'Current UI client Action',
        });
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-client-action-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());

        let handlerCalls = 0;
        let receivedContext: CurrentUiContextSnapshotV1 | undefined;
        const fixture = createMountedClientActionFixture(async (_input, context) => {
            handlerCalls += 1;
            receivedContext = context.currentUiContext;
            return { currentEntityLabel: context.currentUiContext?.entity?.label ?? null };
        });
        const [activation] = await fixture.composition.reconcile([fixture.activation]);
        expect(activation?.result).toEqual({ ok: true });

        let reader: CurrentUiContextReader | null = null;
        const screen = await renderScreen(renderComposedSurface({
            serverId: profile.id,
            subPath: 'notes/a',
            pluginUiProjection: fixture.projection,
            onReader: (next) => { reader = next; },
        }));
        const currentReader = requireReader(reader);
        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
            expect(hostedRenderer.hostApi).not.toBeNull();
            expect(hostedRenderer.surfaceContext).not.toBeNull();
        });

        const hostApi = hostedRenderer.hostApi;
        const surfaceContext = hostedRenderer.surfaceContext;
        if (!hostApi || !surfaceContext) throw new Error('Expected the real mounted Host API.');
        await expect(hostApi.handleRequest({
            version: 1,
            requestId: 'current-ui-client-action',
            surface: surfaceContext,
            method: 'executeAction',
            payload: {
                action: { pluginId: placement.pluginId, localId: CLIENT_ACTION_ID },
                input: null,
            },
        })).resolves.toEqual({ currentEntityLabel: 'Issue A' });
        expect(handlerCalls).toBe(1);
        expect(receivedContext).toEqual(currentReader.readCurrentUiContext());

        await screen.unmount();
    });

    it('publishes the packed external Voice artifact through the mounted SDK Host API and retires its opaque command with the mount', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://packed-external-voice-current-context.test',
            name: 'Packed external Voice current context',
        });
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'packed-external-voice-current-context-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());

        hostedRenderer.packedRenderSurface = await loadPackedExternalVoiceFixtureRenderSurface();
        let reader: CurrentUiContextReader | null = null;
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            screen = await renderScreen(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/a',
                onReader: (next) => { reader = next; },
            }));
            const currentReader = requireReader(reader);
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.entity).toEqual({
                    kind: 'voice',
                    label: 'Packed Voice current context',
                    summary: 'The packed external Voice fixture publishes this mounted semantic context.',
                });
            });
            const commandA = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
            expect(commandA).toMatch(/^current-ui-command:/);
            expect(currentReader.resolveCurrentUiCommand(commandA)?.command).toEqual({
                kind: 'executeAction',
                action: {
                    pluginId: placement.pluginId,
                    localId: 'open-packed-current-context',
                },
            });

            await screen.update(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/a',
                showSurface: false,
                onReader: (next) => { reader = next; },
            }));
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()).toEqual({
                    navigation: {
                        area: 'plugin',
                        presentation: 'screen',
                        screen: 'page',
                    },
                    commands: [],
                });
                expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
            });

            await screen.update(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/a',
                onReader: (next) => { reader = next; },
            }));
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.entity?.label)
                    .toBe('Packed Voice current context');
            });
            const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
            expect(commandB).toMatch(/^current-ui-command:/);
            expect(commandB).not.toBe(commandA);
            expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
            expect(currentReader.resolveCurrentUiCommand(commandB)?.command).toEqual({
                kind: 'executeAction',
                action: {
                    pluginId: placement.pluginId,
                    localId: 'open-packed-current-context',
                },
            });
        } finally {
            await screen?.unmount();
            hostedRenderer.packedRenderSurface = null;
        }
    });

    it('publishes through the real bound host, retires A before B, and leaves no reader or Voice port record after unmount', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://acme.current-ui-composition.test',
            name: 'Current UI composition',
        });
        // This test's native host has no tab-scoped server selection, so use
        // the real device-default selection that the Account lifetime reads.
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());
        expect(storage.getState().profileScope).toEqual(accountScope);
        expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);

        let reader: CurrentUiContextReader | null = null;
        const screen = await renderScreen(renderComposedSurface({
            serverId: profile.id,
            subPath: 'notes/a',
            onReader: (next) => { reader = next; },
        }));
        const currentReader = requireReader(reader);
        const voicePort = createCurrentUiContextVoiceToolPort({
            reader: currentReader,
            readProjection: () => null,
            readNavigationBinding: () => null,
        });

        await vi.waitFor(() => {
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
            expect(screen.findByTestId('hosted-current-ui:notes/a')).toBeTruthy();
        });
        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity).toEqual({
                kind: 'issue',
                label: 'Issue A',
                reference: { number: 1 },
            });
            expect(hostedRenderer.responses).toContainEqual({ subPath: 'notes/a', response: null });
        });
        const commandA = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandA).toMatch(/^current-ui-command:/);
        expect(voicePort.readCurrentUiContext()?.entity?.label).toBe('Issue A');
        expect(currentReader.resolveCurrentUiCommand(commandA)?.command).toEqual({
            kind: 'openSurface',
            destination: { pluginId: 'acme.current-ui-composition', localId: 'notes' },
            input: { issueNumber: 2 },
        });

        await screen.update(renderComposedSurface({
            serverId: profile.id,
            subPath: 'notes/b',
            onReader: (next) => { reader = next; },
        }));

        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity).toEqual({
                kind: 'issue',
                label: 'Issue B',
                reference: { number: 2 },
            });
            expect(hostedRenderer.responses).toContainEqual({ subPath: 'notes/b', response: null });
        });
        const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandB).toMatch(/^current-ui-command:/);
        expect(hostedRenderer.currentUiLabelBeforeBPublication).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(voicePort.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(voicePort.readCurrentUiContext()?.entity?.label).toBe('Issue B');
        expect(currentReader.resolveCurrentUiCommand(commandB)?.command).toEqual({
            kind: 'openSurface',
            destination: { pluginId: 'acme.current-ui-composition', localId: 'notes' },
            input: { issueNumber: 3 },
        });

        await screen.unmount();
        expect(currentReader.readCurrentUiContext()).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();
        expect(voicePort.readCurrentUiContext()).toBeNull();
        expect(voicePort.resolveCurrentUiCommand(commandB)).toBeNull();
    });

    it('retires the exact mounted provider record on controller replacement and host removal without an insertion-effect update', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://acme.current-ui-insertion-disposal.test',
            name: 'Current UI insertion disposal',
        });
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-insertion-disposal-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());

        let reader: CurrentUiContextReader | null = null;
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const screen = await renderScreen(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/a',
                onReader: (next) => { reader = next; },
            }));
            const currentReader = requireReader(reader);
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
            });
            const commandA = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
            expect(commandA).toMatch(/^current-ui-command:/);

            const replacementProjection = Object.freeze({
                ...projection,
                generation: projectionGeneration + 1,
            }) satisfies PluginUiProjectionModel;
            await screen.update(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/b',
                pluginUiProjection: replacementProjection,
                onReader: (next) => { reader = next; },
            }));

            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue B');
                expect(hostedRenderer.currentUiLabelBeforeBPublication).toBeNull();
            });
            const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
            expect(commandB).toMatch(/^current-ui-command:/);
            expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();

            await screen.update(renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/b',
                showSurface: false,
                pluginUiProjection: replacementProjection,
                onReader: (next) => { reader = next; },
            }));
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
                expect(currentReader.readCurrentUiContext()?.commands).toEqual([]);
                expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();
            });
            expect(consoleError.mock.calls.some((call) => (
                call.join(' ').includes('useInsertionEffect must not schedule updates.')
            ))).toBe(false);

            await screen.unmount();
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps the real bound publisher current across StrictMode effect replay', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://acme.current-ui-strict-composition.test',
            name: 'Current UI StrictMode composition',
        });
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-strict-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());

        let reader: CurrentUiContextReader | null = null;
        const screen = await renderScreen(
            <React.StrictMode>
                {renderComposedSurface({
                    serverId: profile.id,
                    subPath: 'notes/a',
                    onReader: (next) => { reader = next; },
                })}
            </React.StrictMode>,
        );
        const currentReader = requireReader(reader);

        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
        });
        const commandId = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandId).toMatch(/^current-ui-command:\d+$/);
        expect(currentReader.resolveCurrentUiCommand(commandId)?.retirementSignal.aborted).toBe(false);

        await screen.unmount();
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();
    });

    it('retires the real plugin command on native background and republishes it exactly once after focus returns', async () => {
        const profile = upsertServerProfile({
            serverUrl: 'https://acme.current-ui-native-composition.test',
            name: 'Current UI native composition',
        });
        setActiveServerId(profile.id, { scope: 'device' });
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-native-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);
        registerStorageStateReader(() => storage.getState());

        let reader: CurrentUiContextReader | null = null;
        const LifecycleBoundSurface = (): React.ReactElement => {
            const activelyViewed = useHostActivelyViewed();
            return renderComposedSurface({
                serverId: profile.id,
                subPath: 'notes/a',
                focusEligible: activelyViewed,
                onReader: (next) => { reader = next; },
            });
        };
        const screen = await renderScreen(<LifecycleBoundSurface />);
        const currentReader = requireReader(reader);
        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
        });
        const commandA = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        const signalA = currentReader.resolveCurrentUiCommand(commandA)?.retirementSignal;
        expect(commandA).toMatch(/^current-ui-command:\d+$/);
        expect(signalA?.aborted).toBe(false);

        await act(async () => {
            setNativeAppState('background');
        });
        expect(currentReader.readCurrentUiContext()).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(signalA?.aborted).toBe(true);

        // The same host-view transition changes provider visibility and
        // surface eligibility in one React commit. A competing consumer
        // replay would allocate another command id and fail the +1 assertion.
        await act(async () => {
            setNativeAppState('active');
        });
        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
        });
        const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        const sequenceA = Number(commandA.split(':').at(-1));
        const sequenceB = Number(commandB.split(':').at(-1));
        expect(commandB).toMatch(/^current-ui-command:\d+$/);
        expect(sequenceB).toBe(sequenceA + 1);
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandB)?.retirementSignal.aborted).toBe(false);

        await screen.unmount();
        expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();
    });
});
