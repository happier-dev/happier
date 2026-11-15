import * as React from 'react';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPluginArtifactTransferBoundary, pluginArtifactTransferDaemonState } from '@/dev/testkit/harness/pluginArtifactTransferBoundary';
import { readFile } from 'node:fs/promises';

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import {
    DaemonPluginActionSchemasReadResponseSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    PluginProjectionV2Schema,
    DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
    DaemonPluginActionSchemasReadRequestSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import {
    encodeBase64} from '@happier-dev/protocol/crypto/base64';
import {
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import {
    computePluginUiArtifactSha256DigestV1,
    computePluginUiArtifactFileSetSha256DigestV1,
    ComposerSnapshotV1Schema,
    CurrentUiContextSnapshotV1Schema,
    normalizePluginUiDestinationBindingV1,
    PluginUiArtifactsManifestEntryV2Schema,
    PluginUiJsonObjectV1Schema,
    type CurrentUiContextSnapshotV1,
    type PluginUiArtifactsManifestEntryV2,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';

import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces/PluginSurfaceHost';
import { Modal } from '@/modal';
import { ModalProvider } from '@/modal/ModalProvider';
import { useCurrentUiContextCommandBridge } from './CurrentUiContextCommands';
import { presentPluginEphemeralInputSurface } from '@/components/automations/editor/presentPluginEventAutomationSetupSurface';
import { useComposerScopePluginPresentation, type ComposerScopePluginPresentation } from '@/components/sessions/presentation/useComposerScopePluginPresentation';
import { registerComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { PluginSurfaceHostApiV1 } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { createPluginPageLocationOwner } from '@/components/plugins/pages/pluginPageLocation';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
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
import { createPluginUiCommonJsLoaderBackend } from '@/components/plugins/reactNative/commonJsLoaderBackend';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    isPluginUiDestinationSurfacePlacementProjection,
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginProjectContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    clearTabActiveServerId,
    getServerProfileById,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    retireActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

import {
    CurrentUiContextProvider,
    usePublishCurrentUiContext,
    type CurrentUiContextReader,
    useOptionalCurrentUiContextReader,
} from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from './currentUiContextActionRuntime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const daemonRpcBoundary = vi.hoisted(() => vi.fn<(method: string, payload: unknown) => Promise<unknown>>());
const artifactTransfers = createPluginArtifactTransferBoundary(request => daemonRpcBoundary(request.method, request.payload));
// Static surface imports reach Sync, so install the external Socket boundary before that graph loads.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

// Only the external Socket transport answers for the daemon. Projection reads,
// scoped routing, Sync and the applied Account lifetime remain real.
installDisconnectedServerSocketBoundary((socket) => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) {
            throw new Error('Malformed daemon transport request');
        }
        const method = payload.method.slice(payload.method.indexOf(':') + 1);
        const machineId = payload.method.slice(0, payload.method.indexOf(':'));
        return { ok: true, result: await (artifactTransfers.handles(method)
            ? artifactTransfers.request({ method, machineId, payload: payload.params }) : daemonRpcBoundary(method, payload.params)) };
    });
});

const nativeHostLifecycle = vi.hoisted(() => ({
    appState: 'active' as 'active' | 'background',
    appStateListeners: new Set<(state: string) => void>(),
}));

const hostedRenderer = vi.hoisted(() => ({
    currentUiReader: null as CurrentUiContextReader | null,
    currentUiLabelBeforeBPublication: undefined as string | null | undefined,
    hostApi: null as PluginSurfaceHostApiV1 | null,
    focusEligible: false,
    publishOnLocationChange: true,
    packedRenderSurface: null as ((context: RenderContext) => React.ReactElement | null) | null,
    surfaceContext: null as PluginUiSurfaceContextV1 | null,
    responses: [] as Array<Readonly<{ subPath: string; response: unknown }>>,
}));
const routeIdentity = vi.hoisted(() => ({ pluginId: 'acme.current-ui-composition', localId: 'notes' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => ({ ...routeIdentity }),
        pathname: () => `/plugins/${routeIdentity.pluginId}/${routeIdentity.localId}`,
        segments: ['(app)', 'plugins', '[pluginId]', '[localId]'],
    }).module;
});

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

type HostedWebPaneBoundaryProps = Readonly<{
    hostApi: PluginSurfaceHostApiV1;
    surfaceContext: PluginUiSurfaceContextV1;
    subPath?: string;
    focusEligible?: boolean;
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
            handleRequest: async (request, options) => {
                const response = await props.hostApi.handleRequest(request, options);
                if (request.method === 'publishCurrentUiContext') {
                    hostedRenderer.responses.push(Object.freeze({ subPath: props.subPath ?? '', response }));
                }
                return response;
            },
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
            hostedRenderer.focusEligible = props.focusEligible === true;
            hostedRenderer.surfaceContext = props.surfaceContext;
            const subPath = props.subPath ?? '';
            if (hostedRenderer.packedRenderSurface) return;
            if (!hostedRenderer.publishOnLocationChange) return;
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
        }, [props.focusEligible, props.hostApi, props.subPath, props.surfaceContext]);
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

const CLIENT_ACTION_ORIGIN = Object.freeze({
    serverIdentityId: 'srv_current_ui_context_client_action',
    materializationRef: Object.freeze({
        pluginId: destinationBinding.destination.pluginId,
        machineId: 'machine-current-ui-context-client-action',
        materializationId: 'materialization-current-ui-context-client-action',
    }),
}) satisfies PluginMachineExecutionOriginV1;
const PLUGIN_OCCURRENCE_ID = 'current-ui-composition-occurrence-a';

const placement = Object.freeze({
    id: 'surfacePlacement:acme.current-ui-composition:notes',
    pluginId: 'acme.current-ui-composition',
    occurrenceId: PLUGIN_OCCURRENCE_ID,
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
            occurrenceId: PLUGIN_OCCURRENCE_ID,
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
let daemonProjection = PluginProjectionV2Schema.parse({ v: 2, generation: projectionGeneration, familiesById: {} });

const CLIENT_ACTION_ID = 'read-current-ui-context';
const CLIENT_ACTION_TARGET = Object.freeze({
    artifactId: 'current-ui-context-client-action',
    exportName: 'execute',
    platform: 'ios' as const,
});
async function createMountedClientActionFixture(handler: PluginClientActionHandler, options?: Readonly<{
    pluginId: string;
    actionId: string;
    declaration: Readonly<Record<string, unknown>>;
    artifactId: string;
    occurrenceId: string;
    manifest: unknown;
    activate: (api: PluginClientApi) => void;
}>): Promise<Readonly<{
    activation: PluginUiClientExecutableActivation;
    composition: PluginUiClientExecutableComposition;
    projection: PluginUiProjectionModel;
    artifact: PluginUiArtifactsManifestEntryV2;
    bytes: Uint8Array;
}>> {
    const pluginId = options?.pluginId ?? placement.pluginId;
    const actionId = options?.actionId ?? CLIENT_ACTION_ID;
    const artifactId = options?.artifactId ?? CLIENT_ACTION_TARGET.artifactId;
    const occurrenceId = options?.occurrenceId ?? PLUGIN_OCCURRENCE_ID;
    const bytes = new Uint8Array([47, 47, 32, 99, 108, 105, 101, 110, 116]);
    const artifactEntry = `react-native/${artifactId}/entry.cjs.bundle`;
    const executionOrigin = options ? {
        ...CLIENT_ACTION_ORIGIN, materializationRef: { ...CLIENT_ACTION_ORIGIN.materializationRef, pluginId },
    } : CLIENT_ACTION_ORIGIN;
    const declaration = options?.declaration ?? {
        title: 'Read current UI context',
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        execution: {
            target: 'client',
            client: {
                artifactId: CLIENT_ACTION_TARGET.artifactId,
                exportName: CLIENT_ACTION_TARGET.exportName,
            },
            platforms: [CLIENT_ACTION_TARGET.platform],
        },
        dangerLevel: 'safe',
        inputSchema: { type: 'null' },
    };
    const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
        artifactId,
        tier: 'reactNative',
        entry: artifactEntry,
        files: [{
            relativePath: artifactEntry,
            digest: computePluginUiArtifactSha256DigestV1(bytes),
            byteSize: bytes.byteLength,
        }],
        digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: artifactEntry, bytes }]),
        builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: options ? ['activate', 'renderSurface'] : [CLIENT_ACTION_TARGET.exportName] },
        hostUiApiRange: '^1.0.0',
    });
    // The daemon is the external boundary. Its same manifest/current-policy/source
    // facts feed the real registry, raw projection, union and mounted Action route.
    // URL imports retain the CLI owner's compiler aliases (the inverse host
    // composition uses the same pattern in projection/ui/projection.composed.test).
    const { normalizePluginManifestV2 }: Readonly<{ normalizePluginManifestV2(input: unknown): Readonly<{ version: string }> }> =
        await import(new URL('../../../../../cli/src/plugins/manifest/normalize.ts', import.meta.url).href);
    const { projectLoadedPluginContributes }: Readonly<{ projectLoadedPluginContributes(input: unknown): Readonly<Record<string, unknown>> }> =
        await import(new URL('../../../../../cli/src/plugins/projection/registry/fullProjection.ts', import.meta.url).href);
    const { createResolvedContributionRegistry }: Readonly<{ createResolvedContributionRegistry(input: unknown): unknown }> =
        await import(new URL('../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry.ts', import.meta.url).href);
    const { buildPluginProjectionV2 }: Readonly<{ buildPluginProjectionV2(input: unknown): unknown }> =
        await import(new URL('../../../../../cli/src/plugins/projection/registry/projection/v2.ts', import.meta.url).href);
    const { projectBundledPluginCatalogEntries }: Readonly<{ projectBundledPluginCatalogEntries(input: unknown): readonly unknown[] }> =
        await import(new URL('../../../../../cli/src/plugins/projection/catalog/installed.ts', import.meta.url).href);
    const { createManagedPluginSourceCustody }: Readonly<{ createManagedPluginSourceCustody(id: string): unknown }> =
        await import(new URL('../../../../../cli/src/plugins/runtime/lifecycle/contributions/runtimeIdentity.testkit.ts', import.meta.url).href);
    const { resolvePluginFinalPolicyAuthorizationFacts }: Readonly<{ resolvePluginFinalPolicyAuthorizationFacts(input: unknown): Readonly<Record<string, unknown>> }> =
        await import(new URL('../../../../../cli/src/plugins/runtime/policy/facts.ts', import.meta.url).href);
    const { loadCurrentBundledPluginLocatorResult }: Readonly<{ loadCurrentBundledPluginLocatorResult(): Readonly<{
        loadedPlugins: readonly Readonly<{ pluginId: string; [key: string]: unknown }>[];
    }> }> = await import(new URL('../../../../../cli/src/plugins/projection/registry/builtIn/locators.ts', import.meta.url).href);
    const manifest = normalizePluginManifestV2(options?.manifest ?? { schemaVersion: 2, id: pluginId,
        version: '1.2.3', displayName: 'Current UI composition', runtime: { apiVersion: 1 },
        contributes: { actions: [{ ...declaration, id: actionId }] },
    });
    const loadedPlugins = options ? loadCurrentBundledPluginLocatorResult().loadedPlugins.map(plugin => plugin.pluginId === pluginId
        ? { ...plugin, manifest, generatedUiArtifactsManifest: { version: 2, entries: [artifactGraph] } } : plugin)
        : [{ pluginId, pluginRootPath: '/plugins/current-ui-composition', manifestPath: '/plugins/current-ui-composition/.happier-plugin/plugin.json',
            daemonEntryPath: null, devDaemonEntryPath: null, manifest,
            sourceSpec: { kind: 'path', locator: '/plugins/current-ui-composition', trustPolicy: 'local_trusted', installPolicy: 'link',
                resolvedVersion: manifest.version },
            generatedUiArtifactsManifest: { version: 2, entries: [artifactGraph] } }];
    const immutableGenerationId = 'current-ui-composition-artifact-generation-a';
    const registry = createResolvedContributionRegistry({ ...projectLoadedPluginContributes({ provenance: options ? 'first_party' : 'external',
        loadResult: { loadedPlugins, diagnosticsByPluginId: {} } }),
        occurrenceIdsByPluginId: { [pluginId]: occurrenceId }, immutableGenerationIdsByPluginId: { [pluginId]: immutableGenerationId },
    });
    const current = { occurrenceId, sourceCustody: createManagedPluginSourceCustody(immutableGenerationId),
        desiredOccurrenceId: occurrenceId, appliedOccurrenceId: occurrenceId, applied: true, selectedAccess: [] };
    const authorization = resolvePluginFinalPolicyAuthorizationFacts({ pluginId, current });
    daemonProjection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({ registry, generation: projectionGeneration,
        ...(options ? { installedPackages: projectBundledPluginCatalogEntries({ loadedPlugins }) } : {}),
        pluginExecutionOriginsByPluginId: { [pluginId]: executionOrigin },
        pluginFinalPolicyCurrentRuntimesById: new Map([[pluginId, current]]),
        resolveActionPresentUserGatePolicy: (candidate: string, localId: string) => candidate === pluginId && localId === actionId
            ? { qualifiedId: `${pluginId}/actions/${actionId}`, occurrenceId, ...declaration,
                authorization: { ...authorization, serviceAvailability: [] } } : null,
        pluginUiHostRuntime: { reactNativeBundles: { featureEnabled: true,
            hostRuntime: { hostUiApiVersion: '1.0.0', platform: 'ios', channel: 'internal' } } }, requestedLocale: 'en',
    }));
    const union = unionPluginUiProjections([{ machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
        serverId: connection!.home.id, serverIdentityId: CLIENT_ACTION_ORIGIN.serverIdentityId,
        projection: normalizePluginUiProjection(daemonProjection, 'ios'), phase: 'current', interactionEnabled: true,
        selectableExecutionOrigins: [executionOrigin] }], new Map([[pluginId, executionOrigin]])).pluginUiProjection;
    if (!union) throw new Error('Expected the canonical client Action union');
    const fixtureProjection: PluginUiProjectionModel = { ...union,
        surfacePlacementsById: { ...projection.surfacePlacementsById, ...union.surfacePlacementsById },
        hostedWebById: { ...projection.hostedWebById, ...union.hostedWebById },
    };
    const resolved = resolveProjectedPluginUiClientExecutables({
        actionProjection: Object.freeze({ projection: fixtureProjection }),
        platform: CLIENT_ACTION_TARGET.platform,
    });
    const resolvedAction = resolved[0];
    if (!resolvedAction || resolved.length !== 1) {
        throw new Error(`Canonical client executable setup did not resolve one target: ${JSON.stringify({
            resolvedCount: resolved.length,
            action: fixtureProjection.actionsById[`${pluginId}/${actionId}`],
            bundle: fixtureProjection.reactNativeBundlesById[`reactNativeBundle:${pluginId}:${actionId}`],
            installed: fixtureProjection.installedPackagesById[pluginId],
            diagnostics: daemonProjection.diagnostics.filter(diagnostic => diagnostic.plugin.id === pluginId),
        })}`);
    }
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({
        identity: resolvedAction.cacheIdentity,
        bytes,
        format: 'plainJs',
    });
    const activate = (api: PluginClientApi): void => {
        if (options) options.activate(api);
        else api.actions.register(CLIENT_ACTION_ID, handler);
    };
    const backend: PluginReactNativeLoaderBackend = Object.freeze({
        backendId: 'commonJs',
        available: true,
        loadInstalledBundle: async () => activate as PluginReactNativeExecutableExport,
    });
    const activation: PluginUiClientExecutableActivation = Object.freeze({
        pluginId: resolvedAction.pluginId,
        ...(resolvedAction.pluginVersion === undefined ? {} : { pluginVersion: resolvedAction.pluginVersion }),
        hostUiApiRange: resolvedAction.hostUiApiRange,
        contributes: resolvedAction.contributes,
        target: resolvedAction.target,
        executionOrigin: resolvedAction.executionOrigin,
        occurrenceId,
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
        artifact: artifactGraph,
        bytes,
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
    binding?: BoundPluginSurfaceBinding;
    native?: Readonly<{ placement: PluginUiSurfacePlacementProjection; backend: PluginReactNativeLoaderBackend;
        projectContext: React.ComponentProps<typeof PluginSurfacePlacementHost>['projectContext'] }>;
    onReader: (reader: CurrentUiContextReader | null) => void;
}>): React.ReactElement {
    const focusEligible = input.focusEligible ?? true;
    return (
        <InjectedAuthProvider credentials={connection?.credentials ?? null}>
            <MainAppTabStateProvider>
                <AppPaneProvider>
                    <CurrentUiContextProvider>
                        <PluginSurfaceFocusEligibilityProvider
                            active={focusEligible}
                            currentUiContextActive={focusEligible}
                        >
                            {input.showSurface !== false ? (
                                <PluginSurfacePlacementHost
                                    placement={input.native?.placement ?? placement}
                                    machineId={input.native ? CLIENT_ACTION_ORIGIN.materializationRef.machineId : 'machine-current-ui-composition'}
                                    serverId={input.serverId}
                                    pluginUiProjection={input.pluginUiProjection ?? projection}
                                    platform={input.native ? 'ios' : 'web'}
                                    reactNativeLoaderBackend={input.native?.backend}
                                    projectContext={input.native?.projectContext}
                                    projectionInteractionEnabled
                                    subPath={input.subPath}
                                    binding={input.binding}
                                />
                            ) : null}
                        </PluginSurfaceFocusEligibilityProvider>
                        <CurrentUiReaderProbe onReader={input.onReader} />
                    </CurrentUiContextProvider>
                </AppPaneProvider>
            </MainAppTabStateProvider>
        </InjectedAuthProvider>
    );
}

async function establishActiveServer(serverId: string, accountId: string, nativeBundles = false): Promise<void> {
    const profile = getServerProfileById(serverId);
    if (!profile) throw new Error('Expected the saved fixture Home.');
    connection = await restoreServerAccountForTest({
        serverUrl: profile.serverUrl,
        accountId,
        request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse(nativeBundles ? {
                features: { machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: false }, serverRouted: { enabled: false } } }, plugins: { enabled: true, webhooks: { enabled: false }, ui: { enabled: true,
                    hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } } },
            } : {}));
            if (path === '/v1/kv/bulk') return Response.json({ values: [] });
            const machineRead = createPlainMachineReadHttpResponseFixture(path, init, accountId, { daemonState: pluginArtifactTransferDaemonState });
            if (machineRead) return machineRead;
            if (path.startsWith('/v1/machines/')) return Response.json({ machine: {
                id: decodeURIComponent(path.slice('/v1/machines/'.length)),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            return Response.json({}, { status: 404 });
        },
    });
    expect(connection.home.id).toBe(serverId);
    storage.getState().applyMachines([createMachineFixture({
        id: CLIENT_ACTION_ORIGIN.materializationRef.machineId,
        activeAt: Date.now(),
        daemonState: pluginArtifactTransferDaemonState,
    })], true, { sourceServerId: serverId });
}

async function loadPackedExternalVoiceFixtureRenderSurface(): Promise<(
    context: RenderContext,
) => React.ReactElement | null> {
    const fixtureRoot = new URL(
        '../../../../../cli/src/plugins/testkit/fixtures/packed-external-voice-provider/',
        import.meta.url,
    );
    const artifactBytes = await readFile(new URL(
        'dist/happier-plugin-ui/react-native/voice-runtime-web/entry.cjs.bundle',
        fixtureRoot,
    ));
    const bytes = new Uint8Array(artifactBytes);
    const digest = computePluginUiArtifactSha256DigestV1(bytes);
    const identity: PluginReactNativeBundleCacheIdentity = Object.freeze({
        pluginId: 'acme.packed-voice',
        contributionId: 'voice-runtime-web',
        artifactId: 'voice-runtime-web',
        artifactDigest: digest,
        platform: 'web',
    });
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
    const backend = createPluginUiCommonJsLoaderBackend();
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
    routeIdentity.pluginId = 'acme.current-ui-composition';
    routeIdentity.localId = 'notes';
    daemonProjection = PluginProjectionV2Schema.parse({ v: 2, generation: projectionGeneration, familiesById: {} });
    await loadSyncSingletonForTests();
    await getInstalledPluginUiClientExecutableComposition().unload();
    nativeHostLifecycle.appState = 'active';
    hostedRenderer.currentUiReader = null;
    hostedRenderer.currentUiLabelBeforeBPublication = undefined;
    hostedRenderer.hostApi = null;
    hostedRenderer.focusEligible = false;
    hostedRenderer.publishOnLocationChange = true;
    hostedRenderer.packedRenderSurface = null;
    hostedRenderer.surfaceContext = null;
    hostedRenderer.responses.length = 0;
    daemonRpcBoundary.mockReset();
    daemonRpcBoundary.mockImplementation(async (method, payload) => {
        if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
            const request = DaemonPluginActionSchemasReadRequestSchema.parse(payload);
            expect(request.expectedOccurrenceId).toBe(PLUGIN_OCCURRENCE_ID);
            expect(request.qualifiedActionId).toBe(`${placement.pluginId}/${CLIENT_ACTION_ID}`);
            return { ok: true, inputSchema: { type: 'null' } };
        }
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
            protocolVersion: 1,
            projection: daemonProjection,
        };
        if (method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
            status: 'current',
            targetedContributions: {
                target: {
                    pluginId: placement.pluginId,
                    occurrenceId: PLUGIN_OCCURRENCE_ID,
                    sourceCustody: {
                        kind: 'development',
                        registeredRootId: 'current-ui-composition-root',
                    },
                },
                points: [],
            },
            targetedSurfaceMounts: [],
        };
        throw new Error(`Unexpected daemon transport method: ${method}`);
    });
    invalidateAccountEncryptionModeCache();
});

afterEach(async () => {
    standardCleanup();
    await getInstalledPluginUiClientExecutableComposition().unload();
    if (connection) storage.getState().applyMachines([], true, { sourceServerId: connection.home.id });
    await connection?.dispose();
    connection = null;
    retireActiveServerAccountScopeLifetime();
    storage.getState().clearProfileScope();
    clearTabActiveServerId();
    invalidateAccountEncryptionModeCache();
    daemonRpcBoundary.mockReset();
    hostedRenderer.currentUiReader = null;
    hostedRenderer.currentUiLabelBeforeBPublication = undefined;
    hostedRenderer.hostApi = null;
    hostedRenderer.focusEligible = false;
    hostedRenderer.publishOnLocationChange = true;
    hostedRenderer.packedRenderSurface = null;
    hostedRenderer.surfaceContext = null;
    hostedRenderer.responses.length = 0;
    nativeHostLifecycle.appState = 'active';
});

describe('CurrentUiContextProvider + PluginSurfaceHost composition', () => {
    it('executes the mounted release Preview through its real opaque current-context command and retires it', async () => {
        const { activate: activateForgeClient, renderSurface: renderForgeSurface } = await import('../../../../../../packages/plugins/scm-github/src/ui/forge/renderForgeSurface');
        const { GITHUB_RELEASE_ACTIONS_V1, GITHUB_RELEASE_ACTION_IDS_V1, GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 } = await import('../../../../../../packages/plugins/scm-github/src/releases/contribution');
        const { GITHUB_PLUGIN_ID } = await import('../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts');
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
        const { GITHUB_FORGE_RENDERER_ID_V1 } = await import('../../../../../../packages/plugins/scm-github/src/ui/forge/surfaceIds');
        // As in the incumbent CLI→UI projection composition, URL imports retain each host's
        // compiler aliases. Intermediate producer data stays unknown until the real strict schema.
        const { createPluginRuntimeOccurrenceId }: Readonly<{ createPluginRuntimeOccurrenceId(pluginId: string): string }> =
            await import(new URL('../../../../../cli/src/plugins/runtime/runtimeSlots.ts', import.meta.url).href);
        const { ForgeReleaseActionInputSchemasV1, ForgeReleaseActionResultSchemasV1 } = await import('@happier-dev/triage-protocol/releases/v1');
        routeIdentity.pluginId = GITHUB_PLUGIN_ID;
        routeIdentity.localId = 'releases';
        const profile = await upsertServerProfile({ serverUrl: 'https://mounted-release-current-context.test', name: 'Mounted release command' });
        await establishActiveServer(profile.id, 'mounted-release-current-context-account', true);
        storage.getState().activateProfileScope({ serverId: profile.id, accountId: 'mounted-release-current-context-account' });
        const declaration = GITHUB_RELEASE_ACTIONS_V1[GITHUB_RELEASE_MOUNTED_ACTION_ID_V1];
        const occurrenceId = createPluginRuntimeOccurrenceId(GITHUB_PLUGIN_ID);
        // Projection carries declarations; the real daemon schema-read boundary below supplies schemas.
        const { inputSchema: _inputSchema, resultSchema: _resultSchema, ...projectedDeclaration } = declaration;
        const fixture = await createMountedClientActionFixture(async () => { throw new Error('Unused synthetic handler'); }, {
            pluginId: GITHUB_PLUGIN_ID, actionId: GITHUB_RELEASE_MOUNTED_ACTION_ID_V1,
            declaration: projectedDeclaration, artifactId: declaration.execution.client.artifactId, occurrenceId,
            activate: activateForgeClient, manifest: PLUGIN_MANIFEST,
        });
        const renderer = PLUGIN_MANIFEST.contributes.ui?.renderers?.find(entry => entry.id === GITHUB_FORGE_RENDERER_ID_V1);
        if (renderer?.kind !== 'reactNative') throw new Error('Expected the authored GitHub forge renderer');
        const releaseProjection = fixture.projection;
        const releasePlacement = releaseProjection.surfacePlacementsById[`surfacePlacement:${GITHUB_PLUGIN_ID}:releases`];
        if (!releasePlacement || !isPluginUiDestinationSurfacePlacementProjection(releasePlacement))
            throw new Error('Expected the real producer Releases destination placement');
        replacePluginAccountAvailabilityProjection({ scope: captureActiveServerAccountScopeLifetime()!.scope,
            snapshot: { availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [] } });
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
        // Module loading is the physical boundary. The real authored renderer owns
        // the page, editor, mounted binder, context publication and visible Preview.
        const backend: PluginReactNativeLoaderBackend = { backendId: 'commonJs', available: true,
            loadInstalledBundle: async ({ moduleReference }) => moduleReference?.exportName === 'activate'
                ? activateForgeClient as PluginReactNativeExecutableExport
                : renderForgeSurface as PluginReactNativeExecutableExport };
        const [target] = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: releaseProjection }, platform: 'ios' });
        if (!target) throw new Error('Expected the canonical release client executable target');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the actual admitted Account activation lifetime');
        expect(accountLifetime.scope).toEqual({ serverId: profile.id, accountId: 'mounted-release-current-context-account' });
        const [activation] = await fixture.composition.reconcile([{ ...fixture.activation, backend, accountLifetime,
            contributes: target.contributes, target: target.target, executionOrigin: target.executionOrigin,
            authority: target.authority, identity: target.cacheIdentity, moduleReference: target.moduleReference }]);
        expect(activation?.result).toEqual({ ok: true });
        const originalRpc = daemonRpcBoundary.getMockImplementation()!;
        const actionDeclarations = new Map<string, typeof GITHUB_RELEASE_ACTIONS_V1[keyof typeof GITHUB_RELEASE_ACTIONS_V1]>(Object.entries(GITHUB_RELEASE_ACTIONS_V1)
            .map(([localId, action]) => [`${GITHUB_PLUGIN_ID}/${localId}`, action] as const));
        const releasePageResponse = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true,
            result: ForgeReleaseActionResultSchemasV1.listReleases.parse({ kind: 'value', value: {
                rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
            } }) });
        const latestReleaseResponse = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({ ok: true,
            result: ForgeReleaseActionResultSchemasV1.readLatestRelease.parse({ kind: 'value', value: null }) });
        const readInvocations: string[] = [];
        daemonRpcBoundary.mockImplementation(async (method, payload) => {
            if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE) return DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily: 'reactNative',
                cacheIdentity: { artifactDigest: fixture.artifact.digest }, artifact: { artifactKind: 'reactNativeBundle',
                    digest: fixture.artifact.digest, format: 'plainJs', byteSize: fixture.bytes.byteLength },
                files: fixture.artifact.files.map(file => ({ ...file, bytesBase64: encodeBase64(fixture.bytes, 'base64') })) });
            if (method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return { status: 'current',
                targetedContributions: { target: { pluginId: GITHUB_PLUGIN_ID, occurrenceId,
                    sourceCustody: daemonProjection.installedPackagesById[GITHUB_PLUGIN_ID]!.sourceCustody }, points: [] }, targetedSurfaceMounts: [] };
            if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
                const request = DaemonPluginActionSchemasReadRequestSchema.parse(payload);
                expect(request.expectedOccurrenceId).toBe(occurrenceId);
                const action = actionDeclarations.get(request.qualifiedActionId);
                if (!action) throw new Error(`Unexpected release Action schema read: ${request.qualifiedActionId}`);
                return DaemonPluginActionSchemasReadResponseSchema.parse({ ok: true,
                    inputSchema: action.inputSchema, outputSchema: action.resultSchema });
            }
            if (method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(payload);
                expect(request.expectedContributorOccurrenceId).toBe(occurrenceId);
                expect(request.executionSurface).toBe('ui');
                readInvocations.push(request.qualifiedActionId);
                if (request.qualifiedActionId === `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_ACTION_IDS_V1.listReleases}`) {
                    expect(ForgeReleaseActionInputSchemasV1.listReleases.parse(request.input)).toEqual({ repository });
                    return releasePageResponse;
                }
                if (request.qualifiedActionId === `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease}`) {
                    expect(ForgeReleaseActionInputSchemasV1.readLatestRelease.parse(request.input)).toEqual({ repository });
                    return latestReleaseResponse;
                }
                throw new Error(`Unexpected release provider Action: ${request.qualifiedActionId}`);
            }
            return originalRpc(method, payload);
        });
        let reader: CurrentUiContextReader | null = null;
        const projectContext = createPluginProjectContextFixture({ serverId: profile.id,
            machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, repositoryIdentity: repository });
        expect(projectContext.target?.repository).toEqual(repository);
        expect(evaluatePluginUiPolicy(releasePlacement, projectContext.policyContext)).toMatchObject({ visible: true, enabled: true });
        const screen = await renderScreen(renderComposedSurface({ serverId: profile.id, subPath: 'compose',
            pluginUiProjection: releaseProjection, native: { placement: releasePlacement, backend,
                projectContext }, onReader: value => { reader = value; } }));
        const currentReader = requireReader(reader);
        const unregister = registerCurrentUiContextActionPort(invocationSurface => createCurrentUiContextVoiceToolPort({
            reader: currentReader, invocationSurface, readProjection: () => releaseProjection, readNavigationBinding: () => null,
        }));
        try {
            await vi.waitFor(() => expect(currentReader.readCurrentUiContext()?.commands, JSON.stringify({
                phase: 'actual Releases page command publication',
                diagnostics: screen.root.findAll(node => typeof node.props.testID === 'string'
                    && node.props.testID.includes('diagnostic')).map(node => node.props.testID),
                rpcMethods: daemonRpcBoundary.mock.calls.map(([method]) => method),
            })).toHaveLength(1));
            const read = await executeCurrentUiContextAction({ actionId: 'ui.current_context.read', input: {}, context: { surface: 'agent' } });
            expect(read.ok).toBe(true);
            if (!read.ok) throw new Error('Expected current-context read');
            const snapshot = CurrentUiContextSnapshotV1Schema.parse(read.result);
            const detail = PluginUiJsonObjectV1Schema.parse(snapshot.detail);
            if (typeof detail.mountId !== 'string')
                throw new Error('Expected the actual page to publish its public mountId');
            const mountedId = detail.mountId;
            expect(detail.preview).toBe(false);
            const command = snapshot.commands[0]!;
            expect(command.id).toMatch(/^current-ui-command:/);
            expect(currentReader.resolveCurrentUiCommand(command.id)?.command).toEqual({ kind: 'executeAction',
                action: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_RELEASE_MOUNTED_ACTION_ID_V1 },
                input: { mountId: mountedId, operation: { kind: 'setPreview', value: true } } });
            await vi.waitFor(() => expect(screen.root.findAll(node => typeof node.type === 'string'
                && node.children.includes('Start the notes')).length).toBeGreaterThan(0));
            const readsBeforePreview = [...readInvocations];
            expect(readsBeforePreview).toEqual(expect.arrayContaining([
                `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_ACTION_IDS_V1.listReleases}`,
                `${GITHUB_PLUGIN_ID}/${GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease}`,
            ]));
            await act(async () => {
                expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command.id },
                    context: { surface: 'agent' } })).toEqual({ ok: true, result: { status: 'applied' } });
            });
            await vi.waitFor(() => {
                expect(currentReader.readCurrentUiContext()?.detail).toMatchObject({ mountId: mountedId, preview: true });
                expect(screen.root.findAll(node => typeof node.type === 'string'
                    && node.children.includes('Nothing to preview yet.')).length).toBeGreaterThan(0);
            });
            expect(readInvocations).toEqual(readsBeforePreview);
            const retirement = currentReader.resolveCurrentUiCommand(command.id)!.retirementSignal;
            await screen.unmount();
            expect(retirement.aborted).toBe(true);
            expect(await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: { commandId: command.id },
                context: { surface: 'agent' } })).toMatchObject({ ok: false });
        } finally { unregister(); await screen.unmount(); }
    });

    it.each([
        { packed: false, ephemeral: false, coreBackground: false },
        { packed: true, ephemeral: false, coreBackground: false },
        { packed: false, ephemeral: true, coreBackground: false },
        { packed: false, ephemeral: true, coreBackground: true },
    ])('publishes only the visible plugin picker through its real modal Host API (%j)', async ({ packed, ephemeral, coreBackground }) => {
        const profile = await upsertServerProfile({ serverUrl: 'https://composer-context-modal.test', name: 'Composer context modal' });
        await establishActiveServer(profile.id, 'composer-context-modal-account');
        storage.getState().activateProfileScope({ serverId: profile.id, accountId: 'composer-context-modal-account' });
        const composer = { kind: 'newSession', instanceId: 'current-context-picker' } as const;
        const snapshot = ComposerSnapshotV1Schema.parse({
            ref: composer, revision: 1, text: '', references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
        });
        const unregister = registerComposerPresentationTarget(composer, {
            readRevision: () => snapshot.revision, replace: () => snapshot.revision, readSnapshot: () => snapshot,
        });
        const contribution = { pluginId: placement.pluginId, localId: 'entry' };
        const catalogEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
            contribution, occurrenceId: PLUGIN_OCCURRENCE_ID, projectionGeneration,
            role: 'attachmentPicker', rendererChain: [{ pluginId: placement.pluginId, localId: 'panel' }],
            selectedRenderer: {
                identity: { pluginId: placement.pluginId, localId: 'panel' },
                renderer: { kind: 'hostedWeb', contributionId: 'panel', source: { kind: 'artifact', artifact: 'panel' }, requiredHostMethods: [] },
                artifactProjection: projection.hostedWebById[`hostedWeb:${placement.pluginId}:panel`],
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: CLIENT_ACTION_ORIGIN,
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: { target: { pluginId: placement.pluginId, occurrenceId: PLUGIN_OCCURRENCE_ID,
                sourceCustody: { kind: 'managed', immutableGenerationId: 'external-composer-generation', installSource: 'archive' } }, points: [] },
        });
        const projectionInputs = publishDaemonMergedProjectionInputs({
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: projectionGeneration, familiesById: {} }),
            composerSurfaceCatalog: [catalogEntry],
        });
        let presentation: ComposerScopePluginPresentation | null = null;
        let reader: CurrentUiContextReader | null = null;
        let commandBridge: ReturnType<typeof useCurrentUiContextCommandBridge> | undefined;
        const isScopeCurrent = () => true;
        if (packed) hostedRenderer.packedRenderSurface = await loadPackedExternalVoiceFixtureRenderSurface();
        function ComposerScope(): null {
            commandBridge = useCurrentUiContextCommandBridge();
            presentation = useComposerScopePluginPresentation({ composer, physicalTarget: { kind: 'app' }, resourceContext: { kind: 'global' },
                machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: profile.id, projectionPhase: 'ready', projectionInputs,
                accountLifetime: captureActiveServerAccountScopeLifetime(), isScopeCurrent, attachmentsEnabled: true, includeSessionActions: false });
            return null;
        }
        function CoreBackground(): null {
            const enrichment = React.useMemo(() => ({ entity: { kind: 'issue', label: 'Issue A' } }), []);
            usePublishCurrentUiContext(enrichment);
            return null;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection?.credentials ?? null}>
            <MainAppTabStateProvider><AppPaneProvider><ModalProvider>
                <CurrentUiContextProvider><PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    {coreBackground ? <CoreBackground /> : <PluginSurfacePlacementHost placement={placement} machineId="machine-current-ui-composition"
                        serverId={profile.id} pluginUiProjection={projection} platform="web" projectionInteractionEnabled subPath="notes/a" />}
                    <ComposerScope /><CurrentUiReaderProbe onReader={next => { reader = next; }} />
                </PluginSurfaceFocusEligibilityProvider></CurrentUiContextProvider>
            </ModalProvider></AppPaneProvider></MainAppTabStateProvider>
        </InjectedAuthProvider>);
        try {
            if (!presentation) throw new Error('Expected the real Composer scope presentation.');
            const interaction = (presentation as ComposerScopePluginPresentation).resolveAttachmentInteraction({
                attachment: { v: 1, instanceId: 'entry-42', attachment: contribution, key: '42', value: { id: 42 },
                    presentation: { typeLabel: 'Issue', label: 'Issue 42' }, availability: { status: 'ready' } },
                catalog: { identity: contribution, occurrenceId: PLUGIN_OCCURRENCE_ID, picker: { renderer: 'panel' } },
            });
            expect(interaction?.onPress).toBeTypeOf('function');
            await act(async () => {
                if (!ephemeral) return interaction?.onPress?.();
                const facts = projectionInputs.composerSurfaceActionInputSelectionFacts.get(projectionInputs.composerSurfaceCatalog![0]);
                if (!facts) throw new Error('Expected canonical input selection facts.');
                // The daemon projection is the external boundary. Reuse its admitted renderer and input-facts fixture.
                const openPicker = (bridge: typeof commandBridge) => void presentPluginEphemeralInputSurface({
                    surface: catalogEntry, title: 'Choose comparison', presentation: 'picker', commandBridge: bridge,
                    projection: { ...projectionInputs, pluginUiProjection: projection,
                        pluginProjectionById: { [placement.pluginId]: {
                            pluginId: placement.pluginId, title: 'Fixture', description: null, version: '1.0.0', enabled: true,
                            generation: projectionGeneration, generationLabel: null, status: null, provenance: null,
                            diagnostics: [], actions: [], resources: [], editableSettingsGroups: [],
                        } },
                        ephemeralInputSurfaceActionInputSelectionFacts: new Map([[catalogEntry, facts]]),
                    }, machineId: CLIENT_ACTION_ORIGIN.materializationRef.machineId, serverId: profile.id,
                    accountLifetime: captureActiveServerAccountScopeLifetime()!,
                });
                if (coreBackground) {
                    function ParentDialog(): null {
                        const bridge = useCurrentUiContextCommandBridge();
                        React.useEffect(() => { openPicker(bridge); }, [bridge]);
                        return null;
                    }
                    Modal.show({ component: ParentDialog, commandBridge });
                } else openPicker(commandBridge);
            });
            await vi.waitFor(() => expect(hostedRenderer.hostApi).not.toBeNull());
            expect(hostedRenderer.hostApi!.installedMethods).toContain('publishCurrentUiContext');
            expect(hostedRenderer.focusEligible).toBe(true);
            await vi.waitFor(() => expect(hostedRenderer.responses.at(-1)?.response).toBeNull());
            expect(requireReader(reader).readCurrentUiContext()?.navigation.area).toBe('modal');
            expect(requireReader(reader).readCurrentUiContext()?.entity?.label).toBe(packed ? 'Packed Voice current context' : 'Issue B');
            expect(requireReader(reader).readCurrentUiContext()?.commands.length).toBeGreaterThan(0);
            const pickerCommands = requireReader(reader).readCurrentUiContext()!.commands;
            expect(CurrentUiContextSnapshotV1Schema.safeParse(requireReader(reader).readCurrentUiContext()).success).toBe(true);
            await act(async () => { Modal.hideAll(); });
            await vi.waitFor(() => expect(requireReader(reader).readCurrentUiContext()?.entity?.label)
                .toBe(packed ? 'Packed Voice current context' : 'Issue A'));
            for (const command of pickerCommands) expect(requireReader(reader).resolveCurrentUiCommand(command.id)).toBeNull();
        } finally {
            await screen.unmount();
            unregister();
            hostedRenderer.packedRenderSurface = null;
        }
    });

    it('lends the current provider snapshot to a registered client Action through the real mounted Host API', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-client-action.test',
            name: 'Current UI client Action',
        });
        await establishActiveServer(profile.id, 'acme.current-ui-client-action-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-client-action-account',
        });
        storage.getState().activateProfileScope(accountScope);

        let handlerCalls = 0;
        let receivedContext: CurrentUiContextSnapshotV1 | undefined;
        const fixture = await createMountedClientActionFixture(async (_input, context) => {
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
        const profile = await upsertServerProfile({
            serverUrl: 'https://packed-external-voice-current-context.test',
            name: 'Packed external Voice current context',
        });
        await establishActiveServer(profile.id, 'packed-external-voice-current-context-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'packed-external-voice-current-context-account',
        });
        storage.getState().activateProfileScope(accountScope);

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
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-composition.test',
            name: 'Current UI composition',
        });
        // This test's native host has no tab-scoped server selection, so use
        // the real device-default selection that the Account lifetime reads.
        await establishActiveServer(profile.id, 'acme.current-ui-composition-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);
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

        const signalA = currentReader.resolveCurrentUiCommand(commandA)!.retirementSignal;
        await act(async () => {
            expect(await hostedRenderer.hostApi!.handleRequest({
                version: 1, requestId: 'acme.current-ui-composition:refresh',
                surface: hostedRenderer.surfaceContext!, method: 'publishCurrentUiContext', payload: { enrichment: {
                    entity: { kind: 'issue', label: 'Issue A', reference: { number: 1 } },
                    commands: [{ title: 'Open issue B', command: { kind: 'openSurface', destination: 'notes', input: { issueNumber: 2 } } }],
                } },
            })).toBeNull();
        });
        expect(currentReader.readCurrentUiContext()?.commands[0]?.id).toBe(commandA);
        expect(signalA.aborted).toBe(false);

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
        expect(signalA.aborted).toBe(true);
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

    it('keeps a page publication when its own settled location returns through the retained host', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-location-echo.test',
            name: 'Current UI location echo',
        });
        await establishActiveServer(profile.id, 'acme.current-ui-location-echo-account');
        storage.getState().activateProfileScope({ serverId: profile.id, accountId: 'acme.current-ui-location-echo-account' });

        let renderedSubPath = 'notes/a';
        let requestedSubPath: string | null = null;
        const locationOwner = createPluginPageLocationOwner({
            currentSubPath: () => renderedSubPath,
            routePathFor: subPath => subPath,
            replaceLocation: subPath => { requestedSubPath = subPath; },
            pushLocation: subPath => { requestedSubPath = subPath; },
            isCurrent: () => true,
        });
        const binding: BoundPluginSurfaceBinding = {
            mountedHostApiHandlers: { replacePageLocation: locationOwner.handleReplaceRequest },
            isCurrentUiContextLocationOwned: locationOwner.ownsCurrentLocation,
        };
        let reader: CurrentUiContextReader | null = null;
        const render = () => renderComposedSurface({ serverId: profile.id, subPath: renderedSubPath, binding,
            onReader: next => { reader = next; } });
        const screen = await renderScreen(render());
        try {
            const currentReader = requireReader(reader);
            await vi.waitFor(() => expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A'));
            const commandA = currentReader.readCurrentUiContext()!.commands[0]!.id;
            await act(async () => {
                expect(await hostedRenderer.hostApi!.handleRequest({
                    version: 1, requestId: 'local-page-selection', surface: hostedRenderer.surfaceContext!,
                    method: 'replacePageLocation', payload: { subPath: 'notes/b', backLocation: 'notes/a' },
                })).toEqual({ subPath: 'notes/b' });
                // The mounted page applies the settled selection and publishes it
                // before the router delivers that location back to its parent.
                expect(await hostedRenderer.hostApi!.handleRequest({
                    version: 1, requestId: 'local-page-selection-context', surface: hostedRenderer.surfaceContext!,
                    method: 'publishCurrentUiContext', payload: { enrichment: {
                        entity: { kind: 'issue', label: 'Issue B', reference: { number: 2 } },
                        commands: [{ title: 'Close detail', command: { kind: 'openSurface', destination: 'notes', input: { issueNumber: null } } }],
                    } },
                })).toBeNull();
            });
            expect(requestedSubPath).toBe('notes/b');
            const commandB = currentReader.readCurrentUiContext()!.commands[0]!.id;
            expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
            expect(currentReader.resolveCurrentUiCommand(commandB)).not.toBeNull();

            // A location echo changes no semantic input in the author subtree.
            // It must not require a duplicate author publication to keep B live.
            hostedRenderer.publishOnLocationChange = false;
            renderedSubPath = requestedSubPath!;
            locationOwner.retireForeignLocationChange(renderedSubPath);
            await screen.update(render());
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue B');
            expect(currentReader.readCurrentUiContext()?.commands[0]?.id).toBe(commandB);
            expect(currentReader.resolveCurrentUiCommand(commandB)).not.toBeNull();

            renderedSubPath = 'notes/c';
            await screen.update(render());
            expect(currentReader.readCurrentUiContext()?.entity).toBeUndefined();
            expect(currentReader.readCurrentUiContext()?.commands).toEqual([]);
            expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();
            locationOwner.retireForeignLocationChange(renderedSubPath);
        } finally {
            await screen.unmount();
            locationOwner.dispose();
        }
    });

    it('retires the exact mounted provider record on controller replacement and host removal without an insertion-effect update', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-insertion-disposal.test',
            name: 'Current UI insertion disposal',
        });
        await establishActiveServer(profile.id, 'acme.current-ui-insertion-disposal-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-insertion-disposal-account',
        });
        storage.getState().activateProfileScope(accountScope);

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
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-strict-composition.test',
            name: 'Current UI StrictMode composition',
        });
        await establishActiveServer(profile.id, 'acme.current-ui-strict-composition-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-strict-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);

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
        expect(commandId).toMatch(/^current-ui-command:.+$/);
        expect(currentReader.resolveCurrentUiCommand(commandId)?.retirementSignal.aborted).toBe(false);

        await screen.unmount();
        expect(currentReader.resolveCurrentUiCommand(commandId)).toBeNull();
    });

    it('retires the real plugin command on native background and republishes it exactly once after focus returns', async () => {
        const profile = await upsertServerProfile({
            serverUrl: 'https://acme.current-ui-native-composition.test',
            name: 'Current UI native composition',
        });
        await establishActiveServer(profile.id, 'acme.current-ui-native-composition-account');
        const accountScope = Object.freeze({
            serverId: profile.id,
            accountId: 'acme.current-ui-native-composition-account',
        });
        storage.getState().activateProfileScope(accountScope);

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
        expect(commandA).toMatch(/^current-ui-command:.+$/);
        expect(signalA?.aborted).toBe(false);

        await act(async () => {
            setNativeAppState('background');
        });
        expect(currentReader.readCurrentUiContext()).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(signalA?.aborted).toBe(true);

        const republishedCommandIds = new Set<string>();
        const stopObserving = currentReader.subscribe(() => {
            const commandId = currentReader.readCurrentUiContext()?.commands[0]?.id;
            if (commandId) republishedCommandIds.add(commandId);
        });
        // Observe opaque command identity through the real reader; UUID allocation
        // is not the publication contract. Replayed active notifications retain it.
        await act(async () => {
            setNativeAppState('active');
        });
        await vi.waitFor(() => {
            expect(currentReader.readCurrentUiContext()?.entity?.label).toBe('Issue A');
        });
        const commandB = currentReader.readCurrentUiContext()?.commands[0]?.id ?? '';
        expect(commandB).toMatch(/^current-ui-command:.+$/);
        expect(commandB).not.toBe(commandA);
        expect([...republishedCommandIds]).toEqual([commandB]);
        expect(currentReader.resolveCurrentUiCommand(commandA)).toBeNull();
        expect(currentReader.resolveCurrentUiCommand(commandB)?.retirementSignal.aborted).toBe(false);

        await act(async () => { setNativeAppState('active'); });
        expect(currentReader.readCurrentUiContext()?.commands[0]?.id).toBe(commandB);
        expect([...republishedCommandIds]).toEqual([commandB]);
        stopObserving();

        await screen.unmount();
        expect(currentReader.resolveCurrentUiCommand(commandB)).toBeNull();
    });
});
