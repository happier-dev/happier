import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    PluginProjectionV2Schema,
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonPluginUiTargetedContributionsReadRequestSchema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import {
    normalizePluginUiDestinationBindingV1,
    type PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createMachineFixture, renderScreen, standardCleanup, withPopoverWebGlobals } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import type {
    StackScreenOptions,
    StackScreenOptionsInput,
} from '@/dev/testkit/runtime/routerRuntime';
import type { CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { usePluginSettingsPageDestinationHandler } from '@/components/settings/plugins/pluginSettingsPageNavigation';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    unionPluginUiProjections,
} from '@/sync/domains/plugins/ui/projectionUnion';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { AppShellClientExecutableActivationState } from './AppShellPluginUiProjection';

import {
    resolvePluginPages,
    selectPluginPagePlacements,
} from '@/components/plugins/pages/pluginPages';
import { usePluginPageDestinationHandler } from '@/components/plugins/pages/pluginPageNavigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
    reactNativeSurfaceProps,
    reactNativeSurfaceInstanceRefs,
    routerPushes,
    routerReplacements,
    routerLocation,
    stackOptions,
} = vi.hoisted(() => ({
    reactNativeSurfaceProps: [] as unknown[],
    reactNativeSurfaceInstanceRefs: [] as unknown[],
    routerPushes: [] as unknown[],
    routerReplacements: [] as unknown[],
    stackOptions: [] as StackScreenOptions[],
    // The host route the screen is currently mounted at. Real, because the
    // duplicate-entry guard compares the generated route against it.
    routerLocation: { pathname: '/' },
}));

const targetedContributionsReadMock = vi.hoisted(() => vi.fn<(machineId: string,
    options: Readonly<{ pluginId: string; serverId?: string | null }>) => Promise<unknown>>());
const preparationRpc = vi.hoisted(() => ({ answer: null as null | ((method: string, payload: unknown) => Promise<unknown>) }));
// The daemon answers a target read with its current occurrence: the one the
// most recently built fixture projection names.
const fixtureDaemonGeneration = vi.hoisted(() => ({ value: 9 }));
const contributionProjectionDescribeMock = vi.hoisted(() => vi.fn<(machineId: string,
    options: Readonly<Record<string, unknown>>) => Promise<unknown>>());

const compactDestinationState = vi.hoisted(() => ({
    destinations: [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Notes',
        icon: 'note',
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
        order: 10,
        routePath: '/plugins/acme.notes/notes',
        availability: 'available',
    }] as const satisfies readonly CompactAppDestination[],
}));

/**
 * The device's own Back, and the platform it is dispatched on.
 *
 * Registration ORDER is the fact under test — React Native dispatches
 * `hardwareBackPress` in reverse registration order — so this keeps the real
 * list rather than a single handler slot.
 */
const nativeBack = vi.hoisted(() => {
    type HardwareBackHandler = () => boolean | null | undefined;
    let handlers: HardwareBackHandler[] = [];
    return {
        platformOS: 'web' as 'web' | 'android',
        addEventListener: (eventName: string, handler: HardwareBackHandler) => {
            if (eventName !== 'hardwareBackPress') {
                throw new Error(`Unexpected native BackHandler event: ${eventName}`);
            }
            handlers = [...handlers, handler];
            return {
                remove: () => { handlers = handlers.filter((candidate) => candidate !== handler); },
            };
        },
        /** `false` means every listener yielded and the host would navigate. */
        press(): boolean {
            for (const handler of [...handlers].reverse()) {
                if (handler() === true) return true;
            }
            return false;
        },
        registeredCount: () => handlers.length,
        reset() {
            handlers = [];
            this.platformOS = 'web';
        },
    };
});

/**
 * React Navigation removing this screen — the ONE fact behind a browser Back
 * button, an iOS header Back and an iOS edge-swipe.
 *
 * `usePreventRemove` is re-invoked on every render, so only the newest pair
 * speaks for the mounted tree; keeping older ones would let a retired render
 * answer a removal.
 */
const routeRemoval = vi.hoisted(() => {
    type RemovalCallback = (event: Readonly<{ data: Readonly<{ action: unknown }> }>) => void;
    let current: Readonly<{ preventRemove: boolean; callback: RemovalCallback }> | null = null;
    return {
        dispatched: [] as unknown[],
        observe(preventRemove: boolean, callback: RemovalCallback) {
            current = { preventRemove, callback };
        },
        /**
         * Perform the removal React Navigation was asked for. Nothing armed, or
         * an armed participant that redispatches, means the user leaves.
         */
        remove(action: unknown) {
            if (current?.preventRemove !== true) {
                this.dispatched.push(action);
                return;
            }
            current.callback({ data: { action } });
        },
        reset() {
            current = null;
            this.dispatched.length = 0;
        },
    };
});

const pluginSurfaceAccountLifetime: { value: ActiveServerAccountScopeLifetime | null } = { value: null };
let pageConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let pageAccountEncryptionRead: Promise<Response> | null = null;
let pageProfileRead: Promise<Response> | null = null;
let pageSettingsStatus = 200;
let pageRequestPaths: string[] = [];

function deferPageAccountEncryptionRead() {
    const response = createDeferred<Response>();
    pageAccountEncryptionRead = response.promise;
    return () => {
        pageAccountEncryptionRead = null;
        response.resolve(Response.json({ mode: 'plain', updatedAt: 1 }));
    };
}
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

// Only external RPC replies are replaced. Parsing, cached target admission,
// currentness and exact-origin selection use their actual internal owners.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(async params => {
        if (params.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(params.payload);
            return contributionProjectionDescribeMock(params.machineId, { ...payload, serverId: params.serverId });
        }
        if (params.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            const payload = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(params.payload);
            return targetedContributionsReadMock(params.machineId, { ...payload, serverId: params.serverId });
        }
        if (preparationRpc.answer) return preparationRpc.answer(params.method, params.payload);
        throw new Error(`Unexpected AppPage fixture RPC: ${params.method}`);
    });
});

async function restorePageAccount(serverId = 'server-1') {
    await pageConnection?.dispose();
    pageConnection = await restoreServerAccountForTest({ serverUrl: `https://${serverId}`,
        serverIdentityId: serverId === 'server-1' ? 'srv_account_one' : 'srv_account_two', accountId: 'account-1',
        request: async url => {
            const path = new URL(String(url)).pathname;
            pageRequestPaths.push(path);
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/account/encryption') return pageAccountEncryptionRead ?? Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }));
            if (path === '/v1/account/profile' && pageProfileRead) return (await pageProfileRead).clone();
            if (path === '/v2/account/settings') return pageSettingsStatus === 200
                ? Response.json({ content: { t: 'plain', v: {} }, version: 1 })
                : Response.json({ error: 'forbidden' }, { status: pageSettingsStatus });
            if (path === '/v1/features' || path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({ features: {
                    plugins: { enabled: true, ui: { enabled: true,
                        hostedWeb: { enabled: true }, reactNativeBundles: { enabled: true } } },
                } }));
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        } });
    if (pageConnection.home.id !== serverId) throw new Error('AppPage fixture must route through its restored Home');
    pluginSurfaceAccountLifetime.value = captureActiveServerAccountScopeLifetime();
    if (!pluginSurfaceAccountLifetime.value) throw new Error('AppPage fixture has no applied Account lifetime');
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: 0, daemonStateVersion: 1 });
    storage.setState({ profileScope: pluginSurfaceAccountLifetime.value.scope,
        settingsScope: pluginSurfaceAccountLifetime.value.scope, endpointStatus: 'online', isDataReady: true,
        machines: { 'machine-1': machine }, machineListByServerId: { [serverId]: [machine] },
        machineListStatusByServerId: { [serverId]: 'idle' },
        settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } });
    replacePluginAccountAvailabilityProjection({ scope: pluginSurfaceAccountLifetime.value.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        // A device Back is the only Back a page can participate in, so the
        // platform has to be switchable inside one fixture rather than forked
        // into a second copy of this whole harness.
        Platform: { get OS() { return nativeBack.platformOS; } },
        BackHandler: { addEventListener: nativeBack.addEventListener },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: React.PropsWithChildren) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/ui/icons/Icon')>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('@/components/appShell/destinations/compactAppDestinationCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/destinations/compactAppDestinationCatalog')>()),
    useCompactAppDestinations: () => compactDestinationState.destinations,
}));

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/search/UniversalSearchRuntimeContext')>()),
    useUniversalSearchRuntime: () => ({ open: () => {}, buildCommands: () => [] }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { en } = await import('@/text/translations/en');
    const defaultText = createTextModuleMock();
    const translate = (key: string, params?: Record<string, unknown>) => {
        if (key === 'pluginSurfaces.state.namedUnavailable' || key === 'pluginSurfaces.state.namedPageUnavailable') return defaultText.t(key, params);
        if (key !== 'settingsPlugins.managePlugin') return key;
        const value = (en.settingsPlugins as Readonly<Record<string, unknown>>).managePlugin;
        return typeof value === 'string' ? value : key;
    };
    return {
        ...createTextModuleMock({
            translate,
            translateLoose: translate,
            getPreferredLanguage: () => 'en',
        }),
        hasTranslation: () => false,
    };
});

vi.mock('expo-router', async () => {
    const { createExpoRouterRuntime } = await import('@/dev/testkit/runtime/routerRuntime');
    const runtime = createExpoRouterRuntime({
        pathname: () => routerLocation.pathname,
        router: {
            push: (value: unknown) => { routerPushes.push(value); },
            replace: (value: unknown) => { routerReplacements.push(value); },
        },
        stackOptionsCapture: {
            record: (options: StackScreenOptionsInput) => {
                stackOptions.push(typeof options === 'function' ? options() : options);
            },
            reset: () => { stackOptions.length = 0; },
            getRaw: () => stackOptions.at(-1) ?? null,
            getResolved: () => stackOptions.at(-1) ?? null,
        },
    });
    return runtime.module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        navigation: { dispatch: (action: unknown) => { routeRemoval.dispatched.push(action); } },
        usePreventRemove: (preventRemove, callback) => { routeRemoval.observe(preventRemove, callback); },
    });
});

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async () => {
    const ReactModule = await import('react');
    const { PluginSurfaceInteractionBoundary } = await import('@/components/plugins/shared/PluginSurfaceInteractionBoundary');
    return {
        PluginReactNativeSurface: (props: any) => {
            const instance = ReactModule.useRef({});
            // Compose the real route controls in this fixture's single root,
            // so its picker shares the addressed page's presentation lifetime.
            const renderHeader = stackOptions.at(-1)?.headerRight as (() => React.ReactNode) | undefined;
            reactNativeSurfaceProps.push(props);
            reactNativeSurfaceInstanceRefs.push(instance.current);
            // Keep the real host availability presentation around the external
            // plugin renderer, including the loaded-module/read-only case.
            return ReactModule.createElement(PluginSurfaceInteractionBoundary, {
                surfaceId: props.surfaceId, snapshotTitle: props.surfaceId,
                enabled: props.interactionEnabled, hasContent: true,
                children: ReactModule.createElement(ReactModule.Fragment, null, renderHeader?.(), ReactModule.createElement('PluginReactNativeSurfaceMock', {
                    testID: 'plugin-react-native-surface-proxy',
                })),
            });
        },
    };
});

/**
 * EU-5b gate, client half — page catalog -> host navigation -> real renderer ->
 * destination context.
 *
 * The fixture is the WIRE projection shape the daemon half produces
 * (`apps/cli/.../projection/v2.appPage.test.ts` asserts the same
 * `surfacePlacement:<pluginId>:<localId>` entry with its direct Registry
 * binding), fed through the real client normalizer. The
 * observable is the plugin author's own `RenderContext`, taken from the real
 * `PluginSurfacePlacementHost` mount — not a hand-built context.
 */

const PAGE_ARTIFACT_ENTRY = 'react-native/notes-renderer/entry.cjs.bundle';
const PAGE_ARTIFACT_BYTES = new TextEncoder().encode('module.exports.renderSurface = function renderSurface() { return null; };');
const PAGE_FILE_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAGE_ARTIFACT_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOTES_PLUGIN_ID = 'acme.notes';
const JOURNAL_PLUGIN_ID = 'acme.journal';
const NOTES_PAGE_PATH = `/plugins/${NOTES_PLUGIN_ID}/notes`;

function pagePopoverWebGlobals() {
    return { window: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
        location: new URL(NOTES_PAGE_PATH, 'https://ui.test'),
        performance: { getEntriesByType: () => [{ type: 'reload' }] },
    } };
}

const pageCacheIdentity = {
    pluginId: NOTES_PLUGIN_ID,
    contributionId: 'notes-renderer',
    artifactId: 'notes-renderer',
    artifactDigest: PAGE_ARTIFACT_DIGEST,
    platform: 'web',
} as const;

function daemonProjection(input: Readonly<{
    description?: string | Readonly<{ key: string; fallback: string }>;
    headerStyle?: 'page' | 'toolbar';
    availability?: Readonly<{ state: string; reason: string; diagnostics: readonly string[] }>;
    headerActions?: readonly unknown[];
    secondPlugin?: boolean;
    generation?: number;
    /** Simulates the plugin being uninstalled while its page is selected. */
    omitPage?: boolean;
    /** The catalog row states the plugin declares no contribution points. */
    withoutContributionPoints?: boolean;
    /** Notes also declares a sibling `tasks` app page, a view the notes page can present a lens apart. */
    tasksView?: boolean;
}> = {}) {
    const generation = input.generation ?? 9;
    fixtureDaemonGeneration.value = generation;
    const sourceCustody = { kind: 'bundled_first_party',
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'plugin-app-page-fixture-root' } } as const;
    const serverIdentityId = getServerProfileById(pluginSurfaceAccountLifetime.value!.scope.serverId)?.serverIdentityId;
    const packageEntry = (pluginId: string) => ({
        id: pluginId,
        displayName: pluginId === NOTES_PLUGIN_ID ? 'Notes' : 'Journal',
        version: '1.0.0',
        enabled: true,
        source: { kind: 'bundled', locator: pluginId },
        // The package owner is the sole source of this target identity. It is
        // deliberately distinct from the aggregate projection generation.
        immutableGenerationId: `${pluginId}-generation-${generation}`,
        occurrenceId: `${pluginId}-generation-${generation}`,
        sourceCustody,
        executionOrigin: PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId,
            sourceRef: { machineId: 'machine-1', pluginId, sourceCustody } }),
        declaresContributionPoints: input.withoutContributionPoints !== true,
        brand: { state: 'missing' },
    });
    const placementEntry = (pluginId: string, destinationId = 'notes') => {
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId,
            destinationId,
            rendererId: 'notes-renderer',
            container: 'appPage',
            target: { kind: 'app' },
        });
        if (!binding) throw new Error('test fixture must use an admitted V2 page binding');
        return {
            id: `surfacePlacement:${pluginId}:${destinationId}`,
            pluginId,
            occurrenceId: `${pluginId}-generation-${generation}`,
            pluginVersion: '1.0.0',
            contributionKind: 'surfacePlacement',
            descriptorId: destinationId,
            generatedV2: true,
            binding,
            target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
            display: { titleKey: destinationId, developerFallback: destinationId === 'tasks' ? 'Tasks'
                : pluginId === NOTES_PLUGIN_ID ? 'Notes' : 'Journal',
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.headerStyle === undefined ? {} : { headerStyle: input.headerStyle }) },
            actions: [],
            ...(input.headerActions === undefined ? {} : { headerActions: input.headerActions }),
            availability: input.availability
                ?? { state: 'available', reason: 'available', diagnostics: [] },
        };
    };
    const bundleEntry = (pluginId: string) => ({
        id: `reactNativeBundle:${pluginId}:notes-renderer`,
        pluginId,
        occurrenceId: `${pluginId}-generation-${generation}`,
        pluginVersion: '1.0.0',
        contributionKind: 'reactNativeBundle',
        contributionId: 'notes-renderer',
        generatedV2: true,
        hostApi: { minVersion: '1.0.0', methods: ['context'] },
        // This fixture exercises a daemon-backed page (its refresh Action is
        // declared below). The renderer must request that capability before
        // Administration selects an exact Machine and admits its target slice.
        requiredHostMethods: ['executeAction'],
        artifactGraph: {
            artifactId: 'notes-renderer',
            tier: 'reactNative',
            entry: PAGE_ARTIFACT_ENTRY,
            files: [{
                relativePath: PAGE_ARTIFACT_ENTRY,
                digest: PAGE_FILE_DIGEST,
                byteSize: PAGE_ARTIFACT_BYTES.byteLength,
            }],
            digest: PAGE_ARTIFACT_DIGEST,
            builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: ['renderSurface'] },
            hostUiApiRange: '^1.0.0',
        },
        runtime: {
            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
            loadPolicy: { source: 'installedArtifact' },
            cacheKey: `${pluginId}-page-cache-key`,
            cacheIdentity: { artifactDigest: PAGE_ARTIFACT_DIGEST },
        },
    });
    const entries: Record<string, unknown> = {
        ...(input.omitPage ? {} : { [`surfacePlacement:${NOTES_PLUGIN_ID}:notes`]: placementEntry(NOTES_PLUGIN_ID) }),
        [`reactNativeBundle:${NOTES_PLUGIN_ID}:notes-renderer`]: bundleEntry(NOTES_PLUGIN_ID),
        ...(input.tasksView ? { [`surfacePlacement:${NOTES_PLUGIN_ID}:tasks`]: placementEntry(NOTES_PLUGIN_ID, 'tasks') } : {}),
    };
    if (input.secondPlugin) {
        entries[`surfacePlacement:${JOURNAL_PLUGIN_ID}:notes`] = placementEntry(JOURNAL_PLUGIN_ID);
        entries[`reactNativeBundle:${JOURNAL_PLUGIN_ID}:notes-renderer`] = bundleEntry(JOURNAL_PLUGIN_ID);
    }
    return {
        v: 2,
        generation,
        installedPackagesById: {
            [NOTES_PLUGIN_ID]: packageEntry(NOTES_PLUGIN_ID),
            ...(input.secondPlugin ? { [JOURNAL_PLUGIN_ID]: packageEntry(JOURNAL_PLUGIN_ID) } : {}),
        },
        agentsById: {},
        // Header Actions execute the daemon-admitted contributed declaration,
        // never a header-local reconstruction, so the page header can only be
        // enabled for an Action this projection actually carries.
        actionsById: {
            [`${NOTES_PLUGIN_ID}/refresh`]: {
                id: 'refresh',
                pluginId: NOTES_PLUGIN_ID,
                occurrenceId: `${NOTES_PLUGIN_ID}-generation-${generation}`,
                title: 'Refresh notes',
                scopes: ['global'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                dangerLevel: 'safe',
                available: true,
            },
        },
        resourcesById: {},
        settingsById: {},
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: entries } },
        diagnostics: [],
    } as never;
}

function composeAppProjection(rawProjection: unknown, serverId = 'server-1'): PluginUiProjectionModel {
    const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse(rawProjection));
    const serverIdentityId = serverId === 'server-1' ? 'srv_account_one' : 'srv_account_two';
    // The shell publishes the union after Administration chooses the exact
    // producer. A declaration-only union deliberately carries no launch authority.
    const origins = new Map(Object.values(projection.installedPackagesById).map(plugin => [plugin.id,
        PluginMachineExecutionOriginV1Schema.parse(plugin.executionOrigin),
    ]));
    return unionPluginUiProjections([{
        machineId: 'machine-1',
        serverId,
        serverIdentityId,
        projection,
        phase: 'current',
        interactionEnabled: true,
    }], origins).pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
}

async function primePageArtifact(pluginId: string) {
    const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
    getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
        identity: { ...pageCacheIdentity, pluginId } as never,
        bytes: PAGE_ARTIFACT_BYTES,
        entryRelativePath: PAGE_ARTIFACT_ENTRY,
        format: 'plainJs',
        files: [{
            relativePath: PAGE_ARTIFACT_ENTRY,
            digest: PAGE_FILE_DIGEST,
            byteSize: PAGE_ARTIFACT_BYTES.byteLength,
            bytes: PAGE_ARTIFACT_BYTES,
        }],
    });
}

function readRenderContext(): RenderContext {
    const props = reactNativeSurfaceProps.at(-1) as { renderContext?: RenderContext };
    expect(props?.renderContext, 'the page must mount a canonical render context').toBeTruthy();
    return props!.renderContext!;
}

async function createPageRenderer(input: Readonly<{
    pluginId?: string;
    localId?: string;
    subPath?: string | null;
    projection?: unknown;
    /** `null` models a multi-member app projection with no coarse execution origin. */
    machineId?: string | null;
    serverId?: string | null;
    withTargetNavigation?: boolean;
    clientExecutableActivation?: AppShellClientExecutableActivationState;
    reloadClientExecutables?: () => void;
    /** Wraps the page the way a real enclosing pane/underlay would. */
    wrap?: (children: React.ReactNode) => React.ReactElement;
    /** The declared view the route names (`?view=`). */
    view?: string;
}> = {}) {
    const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
    const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');
    const wrap = input.wrap ?? ((children: React.ReactNode) => <>{children}</>);
    // The page stands in the app's pane host (its details pane), which the app root provides.
    return (model: PluginUiProjectionModel) => (
        <AppPaneProvider>
        <AppShellPluginUiProjectionValueProvider
            value={{
                pluginUiProjection: model,
                pluginBrowserProjection: null,
                phase: 'current',
                interactionEnabled: true,
                machineId: input.machineId === undefined ? 'machine-1' : input.machineId,
                serverId: input.serverId === undefined ? 'server-1' : input.serverId,
                platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: input.clientExecutableActivation ?? { status: 'ready' },
                reloadClientExecutables: input.reloadClientExecutables ?? (() => {}),
                reloadConnectedAccountProjection: () => {},
            }}
        >
            <AppTargetNavigationScope model={model} enabled={input.withTargetNavigation !== false}>
                {wrap(
                    <PluginAppPageScreen
                        pluginId={input.pluginId ?? NOTES_PLUGIN_ID}
                        localId={input.localId ?? 'notes'}
                        subPath={input.subPath === undefined ? '' : input.subPath}
                        {...(input.view === undefined ? {} : { view: input.view })}
                    />,
                )}
            </AppTargetNavigationScope>
        </AppShellPluginUiProjectionValueProvider>
        </AppPaneProvider>
    );
}

async function renderPage(input: Parameters<typeof createPageRenderer>[0] = {}) {
    const render = await createPageRenderer(input);
    // Drain Account-mode disclosure and host effects. Tests of daemon-backed
    // capabilities await their target admission separately from page rendering.
    return await renderScreen(render(composeAppProjection(input.projection ?? daemonProjection())));
}

async function renderAndroidPage(input: Parameters<typeof createPageRenderer>[0] = {}) {
    nativeBack.platformOS = 'android';
    // Credentials belong to the device's storage boundary. Restoring on web
    // and then changing OS leaves native SecureStore signed out.
    await restorePageAccount();
    await primePageArtifact(NOTES_PLUGIN_ID);
    await primePageArtifact(JOURNAL_PLUGIN_ID);
    return renderPage(input);
}

type PageHostProps = Readonly<{
    model: PluginUiProjectionModel;
    serverId?: string;
    machineId?: string;
    /** `null` is the user having navigated off the page entirely. */
    location?: Readonly<{ pluginId?: string; localId?: string; subPath?: string }> | null;
    showCompactSidebar?: boolean;
    showCompactCommandPaletteActivation?: boolean;
}>;

function pageModel(
    input: Parameters<typeof daemonProjection>[0] = {},
    serverId = 'server-1',
): PluginUiProjectionModel {
    return composeAppProjection(daemonProjection(input), serverId);
}

function AppTargetNavigationScope(props: React.PropsWithChildren<Readonly<{
    model: PluginUiProjectionModel;
    enabled?: boolean;
}>>): React.ReactElement {
    const pages = React.useMemo(() => resolvePluginPages({ target: { kind: 'app' },
        placements: selectPluginPagePlacements(props.model, { container: 'appPage', targetKind: 'app' }),
    }), [props.model]);
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: selectPluginDestinationSurfacePlacements(props.model),
        settingsPages: Object.values(props.model.settingsPagesById),
        targetKind: 'app',
        accountLifetime: pluginSurfaceAccountLifetime.value,
    });
    const openPage = usePluginPageDestinationHandler({ pages });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({ projection: props.model });
    const pageOwner = React.useMemo(() => ({
        container: 'appPage' as const,
        handler: openPage,
    }), [openPage]);
    const settingsOwner = React.useMemo(() => ({
        container: 'settingsPage' as const,
        handler: openSettingsPage,
    }), [openSettingsPage]);
    useRegisterPluginSurfaceDestinationNavigationOwner(
        props.enabled === false ? null : pageOwner,
        binding,
    );
    useRegisterPluginSurfaceDestinationNavigationOwner(
        props.enabled === false ? null : settingsOwner,
        binding,
    );
    return (
        <PluginSurfaceDestinationNavigationBindingProvider binding={props.enabled === false ? null : binding}>
            {props.children}
        </PluginSurfaceDestinationNavigationBindingProvider>
    );
}

/**
 * One app-shell host, re-rendered across authority and location changes.
 *
 * The launch input's lifetime is the thing under test, so it has to be observed
 * across REAL transitions inside one live host — a fresh `renderScreen` per step
 * would start a new app shell and could not tell a retired value from a value
 * that merely never crossed process boundaries.
 */
async function loadPageHost(): Promise<React.ComponentType<PageHostProps>> {
    const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
    const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');
    const { PhoneMainAppTabBar } = await import('@/components/appShell/destinations/PhoneDestinationsMenu');
    const { InboxSummaryProvider } = await import('@/hooks/inbox/useInboxSummary');
    const { buildCommandPaletteCommands } = await import('@/components/appShell/commandPalette/buildCommandPaletteCommands');
    const { usePluginPageCatalogActivationHandler } = await import('@/components/plugins/pages/pluginPageNavigation');

    function CompactCommandPaletteActivation(): React.ReactElement {
        const activatePage = usePluginPageCatalogActivationHandler();
        const command = React.useMemo(() => {
            // The command builder owns command creation; this is the same host
            // activation boundary the web provider supplies to it.
            const input = {
                sessionsById: {},
                isDev: false,
                activeSessionId: null,
                features: { executionRunsEnabled: false, voiceEnabled: false },
                compactAppDestinations: compactDestinationState.destinations,
                onActivateCompactAppDestination: (destination: CompactAppDestination) => {
                    if (destination.kind !== 'plugin' || destination.container !== 'appPage') {
                        throw new Error('compact activation fixture must address an app page');
                    }
                    activatePage(destination);
                },
                nav: {
                    push: (routePath: string) => { routerPushes.push(routePath); },
                    openNewSession: () => {},
                    navigateToSession: () => {},
                },
                actions: { execute: async () => ({ ok: true, result: {} }) },
                alert: async () => {},
            };
            return buildCommandPaletteCommands(input).find((entry) => (
                entry.id === 'app-destination:plugin:acme.notes:notes'
            ));
        }, [activatePage]);
        if (!command) throw new Error('compact app-page command must be available');
        return React.createElement('CompactCommandPaletteActivation', {
            testID: 'compact-command-palette-app-page-activation',
            onPress: command.action,
        });
    }

    return function PageHost(props: PageHostProps): React.ReactElement {
        return (
            <AppPaneProvider>
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: props.model,
                    pluginBrowserProjection: null,
                    phase: 'current',
                    interactionEnabled: true,
                    machineId: props.machineId ?? 'machine-1',
                    serverId: props.serverId ?? 'server-1',
                    platform: 'web',
                    accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' },
                    reloadClientExecutables: () => {},
                    reloadConnectedAccountProjection: () => {},
                }}
            >
                <AppTargetNavigationScope model={props.model}>
                    {props.location === null ? null : (
                        <PluginAppPageScreen
                            pluginId={props.location?.pluginId ?? NOTES_PLUGIN_ID}
                            localId={props.location?.localId ?? 'notes'}
                            subPath={props.location?.subPath ?? ''}
                        />
                    )}
                    {props.showCompactSidebar ? <InboxSummaryProvider><PhoneMainAppTabBar activeTab="sessions" onTabPress={() => {}} /></InboxSummaryProvider> : null}
                    {props.showCompactCommandPaletteActivation ? <CompactCommandPaletteActivation /> : null}
                </AppTargetNavigationScope>
            </AppShellPluginUiProjectionValueProvider>
            </AppPaneProvider>
        );
    };
}

async function openFromMountedPage(
    input: PluginUiLaunchInputV1 | undefined,
    options?: Readonly<{ subPath?: string }>,
): Promise<void> {
    const { act } = await import('react-test-renderer');
    const hostApi = readRenderContext().hostApi;
    await act(async () => {
        await hostApi.openSurface('notes', input, options);
    });
}

beforeEach(async () => {
    preparationRpc.answer = null;
    reactNativeSurfaceProps.length = 0;
    reactNativeSurfaceInstanceRefs.length = 0;
    routerPushes.length = 0;
    routerReplacements.length = 0;
    nativeBack.reset();
    routeRemoval.reset();
    stackOptions.length = 0;
    routerLocation.pathname = '/';
    await restorePageAccount();
    const { resetServerReachabilitySupervisors } = await import(
        '@/sync/runtime/connectivity/serverReachabilitySupervisorPool'
    );
    await resetServerReachabilitySupervisors();
    const { invalidateAccountEncryptionModeCache } = await import(
        '@/sync/api/account/apiAccountEncryptionMode'
    );
    invalidateAccountEncryptionModeCache();
    // The target snapshot is cached by its exact daemon-owned target key.
    // Isolate each route test so its daemon-boundary assertion cannot inherit a
    // prior route's cached answer.
    const { clearDaemonMergedProjectionCacheForTests } = await import(
        '@/agents/backendCatalog/loadDaemonMergedProjectionInputs'
    );
    clearDaemonMergedProjectionCacheForTests();
    contributionProjectionDescribeMock.mockReset();
    contributionProjectionDescribeMock.mockImplementation(async () => ({
        protocolVersion: 1,
        projection: daemonProjection({ generation: fixtureDaemonGeneration.value }),
    }));
    targetedContributionsReadMock.mockReset();
    targetedContributionsReadMock.mockImplementation(async (_machineId, options) => ({
        status: 'current',
        targetedContributions: {
            target: {
                pluginId: options.pluginId,
                occurrenceId: `${options.pluginId}-generation-${fixtureDaemonGeneration.value}`,
                sourceCustody: {
                    kind: 'bundled_first_party',
                    packagedRuntime: {
                        kind: 'cli_version_root',
                        versionRootId: 'plugin-app-page-fixture-root',
                    },
                },
            },
            points: [],
        },
        targetedSurfaceMounts: [],
    }));
    await primePageArtifact(NOTES_PLUGIN_ID);
    await primePageArtifact(JOURNAL_PLUGIN_ID);
});

afterEach(async () => {
    await standardCleanup();
    clearPluginAccountAvailabilityProjection();
    await pageConnection?.dispose();
    pageConnection = null;
    pageProfileRead = null;
    pageSettingsStatus = 200;
    pluginSurfaceAccountLifetime.value = null;
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
    const { resetServerReachabilitySupervisors } = await import(
        '@/sync/runtime/connectivity/serverReachabilitySupervisorPool'
    );
    await resetServerReachabilitySupervisors();
});

describe('plugin app page host route (EU-5b)', () => {
    it('lets the page\u2019s own Machine chip say a Machine is connecting, with no notice over the page\u2019s footer', async () => {
        contributionProjectionDescribeMock.mockImplementation(() => new Promise(() => {}));
        const screen = await renderPage();
        await vi.waitFor(() => expect(readRenderContext().surface.machineConnectionPending).toBe(true));
        expect(screen.findByProps({ testIDPrefix: 'plugin-page-execution' })).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-execution-preparing')).toBeNull();
    });
    it('settles an online Machine with unverified availability into recovery instead of endless loading', () => withPopoverWebGlobals(async () => {
        // The census knows this online Machine, but its scoped content has not
        // been opened: Administration reports unknown execution availability.
        const machine = createMachineFixture({ active: true, activeAt: Date.now(), metadata: null,
            availability: { kind: 'locked', reason: 'content_unpublished' } });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { 'server-1': [machine] },
            machineListStatusByServerId: { 'server-1': 'loading' } });
        const screen = await renderPage({ machineId: null, serverId: null });
        const selection = screen.findByProps({ testIDPrefix: 'plugin-page-execution' }).props.selection;
        expect(selection.state).toMatchObject({ kind: 'unavailable', reasons: expect.arrayContaining(['unknown']) });
        expect(readRenderContext().surface).toMatchObject({ machineConnectionPending: false, machineExecutionReady: false });
        const surface = reactNativeSurfaceProps.at(-1) as { surfaceId: string };
        expect(screen.findByTestId(`plugin-surface-machine-unavailable:${surface.surfaceId}`)).toBeTruthy();
        expect(screen.findByTestId('plugin-app-page-loading')).toBeNull();
        expect(screen.findByTestId('plugin-surface-execution-preparing')).toBeNull();
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.unknown');
        expect(screen.getTextContent()).toContain('common.retry');
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.chooseAnother');
        expect(screen.findByTestId('plugin-page-execution.chip')).toBeTruthy();
        await screen.pressByTestIdAsync(`plugin-surface-machine-unavailable:${surface.surfaceId}-secondary-action`);
        expect(screen.findByTestId('plugin-page-execution.picker-list')).toBeTruthy();
        await screen.unmount();
    }, pagePopoverWebGlobals()));

    it('offers choosing another Machine through the canonical picker when the selected Machine goes offline', () => withPopoverWebGlobals(async () => {
        const render = await createPageRenderer();
        const model = pageModel();
        const screen = await renderScreen(render(model));
        await vi.waitFor(() => expect(reactNativeSurfaceInstanceRefs).not.toHaveLength(0));
        const machine = storage.getState().machines['machine-1']!;
        const offline = { ...machine, active: false, activeAt: 0 };
        const offlineModel = unionPluginUiProjections([{
            machineId: 'machine-1', serverId: 'server-1', serverIdentityId: 'srv_account_one',
            projection: normalizePluginUiProjection(PluginProjectionV2Schema.parse(daemonProjection())),
            phase: 'retainedOffline', interactionEnabled: false,
        }]).pluginUiProjection!;
        const { act } = await import('react-test-renderer');
        await act(async () => { storage.setState({ machines: { 'machine-1': offline },
            machineListByServerId: { 'server-1': [offline] } }); });
        await screen.update(render(offlineModel));
        const surface = reactNativeSurfaceProps.at(-1) as { surfaceId: string };
        await vi.waitFor(() => expect(screen.findByTestId(`plugin-surface-machine-unavailable:${surface.surfaceId}`)).toBeTruthy());
        expect(screen.getTextContent()).toContain('settingsPlugins.targetSelection.chooseAnother');
        await screen.pressByTestIdAsync(`plugin-surface-machine-unavailable:${surface.surfaceId}-secondary-action`);
        expect(screen.findByTestId('plugin-page-execution.picker-list')).toBeTruthy();
        await screen.unmount();
    }, pagePopoverWebGlobals()));

    it('keeps the exact mounted page and context through a selected-origin presence drop', async () => {
        const render = await createPageRenderer();
        const model = pageModel();
        const screen = await renderScreen(render(model));
        await vi.waitFor(() => expect(reactNativeSurfaceInstanceRefs).not.toHaveLength(0));
        expect((reactNativeSurfaceProps.at(-1) as { interactionEnabled: boolean }).interactionEnabled).toBe(true);
        const instance = reactNativeSurfaceInstanceRefs.at(-1);
        const context = readRenderContext();
        const machine = storage.getState().machines['machine-1']!;
        const offline = { ...machine, active: false, activeAt: 0 };
        const offlineModel = unionPluginUiProjections([{
            machineId: 'machine-1', serverId: 'server-1', serverIdentityId: 'srv_account_one',
            projection: normalizePluginUiProjection(PluginProjectionV2Schema.parse(daemonProjection())),
            phase: 'retainedOffline', interactionEnabled: false,
        }]).pluginUiProjection!;
        const { act } = await import('react-test-renderer');
        await act(async () => { storage.setState({ machines: { 'machine-1': offline },
            machineListByServerId: { 'server-1': [offline] } }); });
        await screen.update(render(offlineModel));
        expect(screen.findByTestId('plugin-app-page-loading')).toBeNull();
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(instance);
        expect(context.signal.aborted).toBe(false);
        expect(readRenderContext().signal).toBe(context.signal);
        // The Account page remains interactive; only daemon-backed effects stop.
        expect((reactNativeSurfaceProps.at(-1) as { interactionEnabled: boolean }).interactionEnabled).toBe(true);
        await expect(readRenderContext().hostApi.executeAction('refresh', {})).rejects.toMatchObject({ code: 'unavailable' });
        await act(async () => { storage.setState({ endpointStatus: 'online', machines: { 'machine-1': machine },
            machineListByServerId: { 'server-1': [machine] } }); });
        await screen.update(render(model));
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(instance);
        expect(readRenderContext().signal).toBe(context.signal);
        expect((reactNativeSurfaceProps.at(-1) as { interactionEnabled: boolean }).interactionEnabled).toBe(true);
    });

    it('updates Run-on presentation without rendering the page identity again', async () => {
        const { act } = await import('react-test-renderer');
        const identity = await import('@/components/plugins/shared/PluginPageIdentityHeader');
        // Observe real render calls; keep all identity, selection and Machine logic intact.
        const renderIdentity = vi.spyOn(identity, 'PluginPageIdentityHeaderProvider');
        storage.setState({ settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: { [`plugin.runOn:${NOTES_PLUGIN_ID}`]: {
                serverIdentityId: 'srv_account_one', machineId: 'machine-1',
            } } } });
        await renderPage();
        const headerRight = stackOptions.at(-1)?.headerRight;
        const header = await renderScreen((headerRight as () => React.ReactElement)());
        await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(0));
        const before = renderIdentity.mock.calls.length;
        const machine = storage.getState().machines['machine-1']!;
        const renamed = { ...machine, updatedAt: machine.updatedAt + 1,
            metadata: { ...machine.metadata!, displayName: 'Renamed execution machine' } };
        await act(async () => { storage.setState({ machines: { 'machine-1': renamed },
            machineListByServerId: { 'server-1': [renamed] } }); });
        await vi.waitFor(() => expect(header.getTextContent()).toContain('Renamed execution machine'));
        expect(renderIdentity.mock.calls.length).toBe(before);
    });

    it('supplies the declaration description to the identity header while the surface is loading', async () => {
        // An unread Account mode blocks disclosure. Optional daemon target reads
        // do not block the Account page and cannot simulate renderer loading.
        const releaseRead = deferPageAccountEncryptionRead();
        try {
            const screen = await renderPage({ projection: daemonProjection({
                description: { key: 'notes.purpose', fallback: 'Review incoming work.' },
            }) });
            const { PageHeader } = await import('@/components/ui/layout/PageHeader');
            expect(screen.findByType(PageHeader).props.description).toBe('Review incoming work.');
            expect(reactNativeSurfaceProps).toHaveLength(0);
        } finally { releaseRead(); }
    });

    it('says a toolbar page\'s identity as its toolbar row, not a page header, while the surface is loading', async () => {
        const releaseRead = deferPageAccountEncryptionRead();
        try {
            const screen = await renderPage({ projection: daemonProjection({ headerStyle: 'toolbar' }) });
            const { PageHeader } = await import('@/components/ui/layout/PageHeader');
            expect(screen.findAllByType(PageHeader)).toHaveLength(0);
            expect(screen.findByTestId(`plugin-page-identity-toolbar:${NOTES_PLUGIN_ID}`)).toBeTruthy();
            expect(reactNativeSurfaceProps).toHaveLength(0);
        } finally { releaseRead(); }
    });

    it('leaves a phone toolbar page\'s name to its large title while the surface loads, with no title in the bar', async () => {
        const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
        const releaseRead = deferPageAccountEncryptionRead();
        try {
            const screen = await renderPage({ projection: daemonProjection({ headerStyle: 'toolbar' }),
                wrap: (children) => <NavigationTitleChromeProvider showsTitle>{children}</NavigationTitleChromeProvider> });
            const { PageHeader } = await import('@/components/ui/layout/PageHeader');
            // The large title the loaded Collection leads with (lab `merged-list` 390), in its place: no mark.
            const identity = screen.findByType(PageHeader);
            expect(identity.props).toMatchObject({ title: 'Notes', alwaysShowTitle: true });
            expect(identity.props.leading).toBeUndefined();
            expect(stackOptions.at(-1)?.headerTitle).toBe('');
            expect(reactNativeSurfaceProps).toHaveLength(0);
        } finally { releaseRead(); }
    });

    it('draws no Back on a rail page\'s own route and keeps it on a location under it', async () => {
        // A main screen (the rail destination's own route) is left through the tab bar, never Back (owner 11-10).
        routerLocation.pathname = NOTES_PAGE_PATH;
        await renderPage();
        await vi.waitFor(() => expect(stackOptions.at(-1)?.headerBackVisible).toBe(false));

        stackOptions.length = 0;
        routerLocation.pathname = `${NOTES_PAGE_PATH}/work`;
        await renderPage({ subPath: 'work' });
        await vi.waitFor(() => expect(stackOptions.length).toBeGreaterThan(0));
        expect(stackOptions.at(-1)?.headerBackVisible).not.toBe(false);
    });

    it('tells a mounted phone toolbar page that its navigation leaves the name to the page\'s large title', async () => {
        const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/navigationTitleChrome');
        const phone = (children: React.ReactNode) => <NavigationTitleChromeProvider showsTitle>{children}</NavigationTitleChromeProvider>;
        const readPageChrome = () => ((reactNativeSurfaceProps.at(-1) as {
            privateHostBindings?: { presentationHost?: { pageChrome?: { showsTitle: boolean; largeTitle?: boolean } } };
        }).privateHostBindings?.presentationHost?.pageChrome);
        await renderPage({ projection: daemonProjection({ headerStyle: 'toolbar' }), wrap: phone });
        await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(0));
        expect(readPageChrome()).toMatchObject({ showsTitle: true, largeTitle: true });
        expect(stackOptions.at(-1)?.headerTitle).toBe('');

        // A phone page with a page header keeps its title in the bar, as before.
        reactNativeSurfaceProps.length = 0;
        stackOptions.length = 0;
        await renderPage({ projection: daemonProjection(), wrap: phone });
        await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(0));
        expect(readPageChrome()?.largeTitle).toBeUndefined();
        expect(stackOptions.at(-1)?.headerTitle).toBe('Notes');

        // A wide layout's toolbar page keeps the name in its toolbar row.
        reactNativeSurfaceProps.length = 0;
        stackOptions.length = 0;
        await renderPage({ projection: daemonProjection({ headerStyle: 'toolbar' }) });
        await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(0));
        expect(readPageChrome()).toMatchObject({ showsTitle: false });
        expect(readPageChrome()?.largeTitle).toBeUndefined();
        expect(stackOptions.at(-1)?.headerTitle).toBe('Notes');
    });

    it('renders a described Account page without an available execution Machine', async () => {
        storage.setState({ machines: {}, machineListByServerId: { 'server-1': [] },
            machineListStatusByServerId: { 'server-1': 'idle' } });
        const screen = await renderPage({ machineId: null, serverId: null });
        expect(screen.findByTestId('plugin-app-page-loading')).toBeNull();
        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeNull();
        expect(readRenderContext().surface.target).toEqual({ kind: 'app' });
        await expect(readRenderContext().hostApi.executeAction('refresh', {})).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('delivers the original prepared composer once after the retained page is hidden for Review', async () => {
        const { act } = await import('react-test-renderer');
        const { createActionOperationStore } = await import('../../../../../cli/src/actions/operations/actionOperationStore');
        const { createActionOperationRunner } = await import('../../../../../cli/src/actions/operations/actionOperationRunner');
        const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
        const { DaemonPluginStructuredMessageActionExecuteRequestSchema } = await import('@happier-dev/protocol/plugins/actions/daemonInvocationV1');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        await prepareSessionDraftPersistenceStorage();
        const wire = PluginProjectionV2Schema.parse(daemonProjection());
        const actionId = `${NOTES_PLUGIN_ID}/refresh`;
        const action = wire.actionsById[actionId]!;
        action.operation = { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } };
        const family = wire.familiesById.pluginUi!;
        const bundle = family.entriesById[`reactNativeBundle:${NOTES_PLUGIN_ID}:notes-renderer`]!;
        // The external renderer requests the navigation capability it uses.
        Object.assign(bundle, { hostApi: { minVersion: '1.0.0', methods: ['context', 'executeAction', 'openNewSession'] } });
        contributionProjectionDescribeMock.mockResolvedValue({ protocolVersion: 1, projection: wire });
        const scope = { accountId: pluginSurfaceAccountLifetime.value!.scope.accountId, machineId: 'machine-1' };
        const store = createActionOperationStore();
        const runner = createActionOperationRunner({ store, resolveAction: () => ({ actionId, title: 'Prepare review', operation: action.operation }) });
        const approval = createDeferred<void>();
        let effects = 0;
        preparationRpc.answer = async (method, payload) => {
            if (method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: { type: 'object' } };
            if (method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(payload);
                return runner.observe({ actionId, requestId: request.requestId, input: request.input, scope, execute: async context => {
                    effects++;
                    const receipt = { kind: 'approval_request_created', artifactId: 'review-approval', actionId: 'workspace.materialize' } as const;
                    context.updateProgress({ phase: 'waiting_for_approval', label: 'Waiting for approval', approval: receipt });
                    context.operationAcceptance?.accept(receipt);
                    await approval.promise;
                    return { ok: true, result: { kind: 'prepared', repositoryPath: '/workspaces/review-final' } };
                } });
            }
            if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return store.list({ ...scope, ...(payload as { requestIdentity?: { actionId: string; requestId: string } }) });
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get) {
                const request = payload as { operationId: string; waitForTerminal?: boolean };
                const operation = request.waitForTerminal ? await runner.waitForTerminal(scope, request.operationId) : store.get(scope, request.operationId);
                return operation ? { kind: 'found', operation } : { kind: 'not_found' };
            }
            throw new Error(`Unexpected preparation RPC: ${method}`);
        };
        let visible = true;
        const render = await createPageRenderer({ projection: wire, wrap: children => <DestinationInstanceHost
            tabId="review-origin" ref={{ kind: `plugin:${NOTES_PLUGIN_ID}:notes`, params: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } }}
            pathname={NOTES_PAGE_PATH} focused={visible} visible={visible}
            navigation={{ push: value => { routerPushes.push(value); }, replace() {}, back() {} }}>{children}</DestinationInstanceHost> });
        const model = composeAppProjection(wire);
        const screen = await renderScreen(render(model));
        try {
            await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(0));
            const context = readRenderContext();
            // Use the mounted controller's canonical raw request boundary: the
            // fixture supplies the external renderer's already selected input.
            const mounted = screen.root.findAll(node => node.props.hostApi?.handleRequest && node.props.requestSurface)[0]!;
            const host = mounted.props.hostApi as import('@/components/plugins/surfaces/createPluginSurfaceHostApi').PluginSurfaceHostApiV1;
            const custody = wire.installedPackagesById[NOTES_PLUGIN_ID]!.sourceCustody!;
            const operation = { point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
                contributor: { pluginId: NOTES_PLUGIN_ID, contributionId: 'review-source', occurrenceId: action.occurrenceId!, sourceCustody: custody },
                role: 'prepareReviewWorkspace', action: { pluginId: NOTES_PLUGIN_ID, localId: 'refresh' } } as const;
            let result: unknown;
            const pending = Promise.resolve(host.handleRequest({ version: 1, requestId: 'original-review', method: 'openNewSession',
                surface: mounted.props.requestSurface, payload: { checkoutIntent: 'preparedReviewWorkspace', prompt: 'Review PR #42' } }, {
                targetedOperation: operation, selectedActionInput: { kind: 'submitted', action: operation.action, input: {},
                    selection: { target: { pluginId: NOTES_PLUGIN_ID, sourceCustody: custody }, point: operation.point,
                        contributor: { pluginId: NOTES_PLUGIN_ID, contributionId: 'review-source', sourceCustody: custody } },
                    connectedAccount: { kind: 'none' }, presentation: { connectedAccountLabel: null, machineDisplayName: 'Development' } },
            })).then(value => { result = value; });
            await vi.waitFor(() => expect(effects, JSON.stringify(result)).toBe(1));
            await vi.waitFor(() => expect(screen.findByTestId('plugin-surface-approval-pending')).not.toBeNull());
            await screen.pressByTestIdAsync('plugin-surface-approval-pending.open');
            visible = false;
            await screen.update(render(model));
            expect(context.signal.aborted).toBe(false);
            await act(async () => { approval.resolve(); await pending; });
            visible = true;
            await screen.update(render(model));
            const composers = routerPushes.filter((route): route is { pathname: '/new'; params: { draftId: string } } =>
                typeof route === 'object' && route !== null && 'pathname' in route && route.pathname === '/new');
            expect(composers).toHaveLength(1);
            expect(readNewSessionDraftFromRepository({ scope: pluginSurfaceAccountLifetime.value!.scope, draftId: composers[0]!.params.draftId }))
                .toMatchObject({ input: 'Review PR #42', selectedPath: '/workspaces/review-final' });
            expect(effects).toBe(1);
            await screen.unmount();
            expect(context.signal.aborted).toBe(true);
        } finally { approval.resolve(); preparationRpc.answer = null; }
    });

    it('keeps singleton page mount identity shared when hosted in distinct workspace tabs', async () => {
        for (const tabId of ['tab-notes-a', 'tab-notes-b']) {
            await renderPage({
                wrap: (children) => (
                    <DestinationInstanceHost
                        tabId={tabId}
                        ref={{ kind: `plugin:${NOTES_PLUGIN_ID}:notes`, params: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' } }}
                        pathname={NOTES_PAGE_PATH}
                        focused={tabId === 'tab-notes-a'}
                        visible
                        navigation={{ push: () => {}, replace: () => {}, back: () => {} }}
                    >
                        {children}
                    </DestinationInstanceHost>
                ),
            });
            expect(readRenderContext().surface.mount).toEqual({
                kind: 'destination',
                destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
                container: 'appPage',
            });
        }
        expect(normalizePluginUiDestinationBindingV1({
            pluginId: NOTES_PLUGIN_ID,
            destinationId: 'notes',
            rendererId: 'notes-renderer',
            container: 'appPage',
            target: { kind: 'app' },
            instancePolicy: 'multiple',
        })).toBeNull();
    });

    it('keeps a restored deep link pending until the app projection has described its exact page', async () => {
        const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
        const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');

        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    pluginBrowserProjection: null,
                    phase: 'current',
                    hasEstablishingMembers: true,
                    interactionEnabled: true,
                    machineId: null,
                    serverId: null,
                    platform: 'web',
                    accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'establishing' },
                    reloadClientExecutables: () => {},
                    reloadConnectedAccountProjection: () => {},
                }}
            >
                <PluginAppPageScreen
                    pluginId={NOTES_PLUGIN_ID}
                    localId="notes"
                    subPath="work/ideas.md"
                />
            </AppShellPluginUiProjectionValueProvider>,
        );

        // The route is already user intent. An unpopulated establishment
        // snapshot must not collapse it to the current-missing tombstone.
        expect(screen.findByTestId('plugin-app-page-establishing')).toBeTruthy();
        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeNull();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('keeps a cold restored page pending through a held Profile read, then settles on failure', async () => {
        const response = Response.json({ error: 'forbidden' }, { status: 403 });
        const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
        const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');
        const { disconnectActiveServerConnection, restoreConnectionToActiveServer,
            isColdActiveServerRestorePending } = await import(
            '@/sync/runtime/orchestration/connectionManager'
        );
        const renderer = await import('react-test-renderer');
        pageRequestPaths = [];
        await disconnectActiveServerConnection();
        const releaseEncryptionRead = deferPageAccountEncryptionRead();
        const profileAnswer = createDeferred<Response>();
        pageProfileRead = profileAnswer.promise;
        const restore = restoreConnectionToActiveServer(pageConnection!.credentials);
        let tree: import('react-test-renderer').ReactTestRenderer | null = null;
        const hasTestId = (testID: string) => tree?.root.findAll((node) => node.props.testID === testID).length !== 0;
        try {
            expect(isColdActiveServerRestorePending()).toBe(true);
            renderer.act(() => { tree = renderer.create(
                <AppShellPluginUiProjectionValueProvider value={{
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    pluginBrowserProjection: null,
                    phase: 'unavailable',
                    interactionEnabled: false,
                    machineId: null,
                    serverId: null,
                    platform: 'web',
                    accountLifetime: null,
                    clientExecutableActivation: { status: 'establishing' },
                    reloadClientExecutables: () => {},
                    reloadConnectedAccountProjection: () => {},
                }}>
                    <PluginAppPageScreen pluginId={NOTES_PLUGIN_ID} localId="notes" subPath="" />
                </AppShellPluginUiProjectionValueProvider>,
            ); });
            expect(isColdActiveServerRestorePending()).toBe(true);
            expect(hasTestId('plugin-app-page-establishing')).toBe(true);
            expect(hasTestId('plugin-app-page-unavailable')).toBe(false);

            releaseEncryptionRead();
            await renderer.act(async () => { await restore; });
            expect(isColdActiveServerRestorePending()).toBe(false);
            expect(storage.getState().isDataReady).toBe(false);
            expect(hasTestId('plugin-app-page-establishing')).toBe(true);
            expect(hasTestId('plugin-app-page-unavailable')).toBe(false);

            await vi.waitFor(() => expect(pageRequestPaths,
                `requests: ${pageRequestPaths.join(', ')}`).toContain('/v1/account/profile'), { timeout: 5000 });
            profileAnswer.resolve(response);
            await vi.waitFor(() => expect(storage.getState().isDataReady,
                `requests: ${pageRequestPaths.join(', ')}`).toBe(true), { timeout: 5000 });
            expect(hasTestId('plugin-app-page-establishing')).toBe(false);
            expect(hasTestId('plugin-app-page-unavailable')).toBe(true);
        } finally {
            releaseEncryptionRead();
            profileAnswer.resolve(response);
            await restore.catch(() => undefined);
            pageProfileRead = null;
            if (tree) renderer.act(() => { tree?.unmount(); });
        }
    });

    it('does not mark core ready when Settings fails before the held Profile first attempt', async () => {
        const { disconnectActiveServerConnection, restoreConnectionToActiveServer } = await import(
            '@/sync/runtime/orchestration/connectionManager'
        );
        await disconnectActiveServerConnection();
        const releaseEncryptionRead = deferPageAccountEncryptionRead();
        const profileAnswer = createDeferred<Response>();
        pageProfileRead = profileAnswer.promise;
        pageSettingsStatus = 403;
        pageRequestPaths = [];
        const restore = restoreConnectionToActiveServer(pageConnection!.credentials);
        try {
            releaseEncryptionRead();
            await restore;
            await vi.waitFor(() => expect(pageRequestPaths).toContain('/v2/account/settings'), { timeout: 5000 });
            await vi.waitFor(() => expect(storage.getState().syncError).not.toBeNull(), { timeout: 5000 });
            expect(pageRequestPaths).toContain('/v1/account/profile');
            expect(storage.getState().isDataReady).toBe(false);
        } finally {
            releaseEncryptionRead();
            profileAnswer.resolve(Response.json({ error: 'forbidden' }, { status: 403 }));
            await restore.catch(() => undefined);
            pageProfileRead = null;
        }
    });

    it('preserves the catalog refusal when a direct-linked page cannot be described', async () => {
        const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
        const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');
        const projection = unionPluginUiProjections([{
            machineId: 'machine-1',
            serverId: 'server-1',
            projection: null,
            phase: 'unavailable',
            unavailableReasonCode: 'plugin_daemon_unsupported',
            interactionEnabled: false,
        }]);
        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider value={{
                ...projection, pluginBrowserProjection: null, platform: 'web',
                accountLifetime: captureActiveServerAccountScopeLifetime(),
                clientExecutableActivation: { status: 'ready' },
                reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {},
            }}>
                <PluginAppPageScreen pluginId={NOTES_PLUGIN_ID} localId="notes" subPath="" />
            </AppShellPluginUiProjectionValueProvider>,
        );

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-app-page-unavailable-diagnostic-plugin_daemon_unsupported')).toBeTruthy();
        expect(screen.findByTestId('plugin-app-page-unavailable-action')).toBeNull();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('presents a page-bound openSurface header Action through the canonical page destination handler', async () => {
        await renderPage({
            projection: daemonProjection({
                headerActions: [{
                    id: 'open-notes',
                    title: 'Open notes',
                    icon: 'action',
                    command: {
                        kind: 'openSurface',
                        destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
                        input: { source: 'page-header' },
                    },
                }],
            }),
        });

        const headerRight = stackOptions.at(-1)?.headerRight;
        expect(typeof headerRight).toBe('function');
        expect(React.isValidElement((headerRight as () => React.ReactElement)())).toBe(true);
    });

    it('binds page-header Action dispatch to the mounted Account lifetime', async () => {
        await renderPage({
            projection: daemonProjection({
                headerActions: [{
                    id: 'refresh-notes',
                    title: 'Refresh notes',
                    icon: 'action',
                    command: {
                        kind: 'executeAction',
                        action: { pluginId: NOTES_PLUGIN_ID, localId: 'refresh' },
                    },
                }],
            }),
        });

        const headerRight = stackOptions.at(-1)?.headerRight;
        expect(typeof headerRight).toBe('function');
        const { PluginPageHeaderActions: PluginAppPageHeaderActions } = await import('@/components/plugins/pages/pluginPageHeaderActions');
        const headerScreen = await renderScreen((headerRight as () => React.ReactElement)());
        const header = headerScreen.root.findByType(PluginAppPageHeaderActions);
        expect(header.props.signal?.aborted).toBe(false);
        expect(header.props.isCurrent?.()).toBe(true);

        const { act } = await import('react-test-renderer');
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
        });

        expect(header.props.signal?.aborted).toBe(true);
        expect(header.props.isCurrent?.()).toBe(false);
    });

    it('keeps a page-bound Action enabled from its exact selected origin when the app union has no coarse machine', async () => {
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        observeMachinePresenceForTest(pluginSurfaceAccountLifetime.value!.scope, ['machine-1']);
        await renderPage({
            machineId: null,
            serverId: null,
            projection: daemonProjection({
                headerActions: [{
                    id: 'refresh-notes',
                    title: 'Refresh notes',
                    icon: 'action',
                    command: {
                        kind: 'executeAction',
                        action: { pluginId: NOTES_PLUGIN_ID, localId: 'refresh' },
                    },
                }],
            }),
        });

        const headerRight = stackOptions.at(-1)?.headerRight;
        expect(typeof headerRight).toBe('function');
        const header = (headerRight as () => React.ReactElement)();
        const headerScreen = await renderScreen(header);
        const action = headerScreen.findByTestId('plugin-app-page-header-action:refresh-notes');

        await vi.waitFor(() => expect(action?.props.disabled).toBe(false));
    });

    it('mounts a page of a plugin without contribution points without a second request', async () => {
        await renderPage({ projection: daemonProjection({ withoutContributionPoints: true }) });

        const context = readRenderContext();
        expect(context.plugin.id).toBe(NOTES_PLUGIN_ID);
        // The catalog row already says there is nothing to admit, so the
        // snapshot is empty by definition and no target read is issued.
        expect(context.surface.targetedContributions).toMatchObject({
            target: { pluginId: NOTES_PLUGIN_ID, occurrenceId: `${NOTES_PLUGIN_ID}-generation-9` },
            points: [],
        });
        expect(targetedContributionsReadMock).not.toHaveBeenCalled();
    });

    it('mounts the declared page at its root with one header execution chip and no duplicate body chip', () => withPopoverWebGlobals(async () => {
        const screen = await renderPage();
        expect(screen.findByTestId('plugin-surface-execution.chip')).toBeNull();
        const headerRight = stackOptions.at(-1)?.headerRight;
        const header = await renderScreen((headerRight as () => React.ReactElement)());
        expect(header.findByTestId('plugin-page-execution.chip')).not.toBeNull();

        await vi.waitFor(() => expect(readRenderContext().surface.targetedContributions).toBeDefined());

        const context = readRenderContext();
        const mountedSurface = reactNativeSurfaceInstanceRefs.at(-1);
        const selectedOrigins = storage.getState().settings.machineAdministrationTargetsLocalV1;
        await header.pressByTestIdAsync('plugin-page-execution.chip');
        expect(header.findHostByTestId('plugin-page-execution.picker-list')).not.toBeNull();
        expect(screen.findByTestId('plugin-app-page-loading')).toBeNull();
        expect(readRenderContext().hostApi).toBe(context.hostApi);
        expect(readRenderContext().signal.aborted).toBe(false);
        await header.pressByTestIdAsync('plugin-page-execution.chip');
        const chip = header.findHostByTestId('plugin-page-execution.chip');
        expect(chip?.props.accessibilityState?.expanded ?? chip?.props['aria-expanded']).toBe(false);
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(mountedSurface);
        expect(storage.getState().settings.machineAdministrationTargetsLocalV1).toBe(selectedOrigins);
        expect(context.plugin.id).toBe(NOTES_PLUGIN_ID);
        expect(context.surface.mount).toEqual({
            kind: 'destination',
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
            container: 'appPage',
        });
        expect(context).not.toHaveProperty('view');
        expect(context.surface.target).toEqual({ kind: 'app' });
        // The mount reads only its target slice, naming the plugin; the
        // daemon tags the answer with its current occurrence.
        expect(targetedContributionsReadMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-1',
            pluginId: NOTES_PLUGIN_ID,
        }));
        expect(contributionProjectionDescribeMock).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ mountedTarget: expect.anything() }),
        );
        expect(context.surface.targetedContributions).toEqual({
            target: {
                pluginId: NOTES_PLUGIN_ID,
                occurrenceId: `${NOTES_PLUGIN_ID}-generation-9`,
                sourceCustody: {
                    kind: 'bundled_first_party',
                    packagedRuntime: {
                        kind: 'cli_version_root',
                        versionRootId: 'plugin-app-page-fixture-root',
                    },
                },
            },
            points: [],
        });
        expect(context.subPath).toBe('');
    }, pagePopoverWebGlobals()));

    it('keeps a mounted plugin page through execution availability revalidation', async () => {
        const render = await createPageRenderer();
        const model = pageModel();
        const screen = await renderScreen(render(model));
        try {
            await vi.waitFor(() => expect(reactNativeSurfaceInstanceRefs).not.toHaveLength(0));
            const instance = reactNativeSurfaceInstanceRefs.at(-1);
            const context = readRenderContext();
            const resolving: PluginUiProjectionModel = { ...model, surfacePlacementsById: Object.fromEntries(
                Object.entries(model.surfacePlacementsById).map(([id, placement]) => [id, { ...placement,
                    availability: { state: 'resolving', reason: 'plugin_execution_origin_pending', diagnostics: [] },
                }]),
            ) };
            await screen.update(render(resolving));
            expect(screen.findByTestId('plugin-react-native-surface-proxy')).not.toBeNull();
            expect(context.signal.aborted).toBe(false);
            expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-plugin_execution_origin_pending')).not.toBeNull();
            // The incumbent page is the presentation: revalidating draws no second, page-shaped loading skeleton above it.
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
            await screen.update(render(model));
            expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(instance);
            expect(readRenderContext().hostApi).toBe(context.hostApi);
        } finally { await screen.unmount(); }
    });

    it('keeps naming the view its route carries while the page revalidates, before the page settles a location', async () => {
        // Cold load of `…?view=tasks`: the route names the view from the first frame. A page that is briefly not live
        // (its execution origin revalidating) changed no location, so the chrome must not fall back to the page's own
        // name until the plugin settles one (live: "Tasks" → "PRs & Issues" for ~17 s → "Tasks").
        const render = await createPageRenderer({ view: 'tasks' });
        const model = pageModel({ tasksView: true });
        const screen = await renderScreen(render(model));
        try {
            await vi.waitFor(() => expect(stackOptions.at(-1)?.headerTitle).toBe('Tasks'));
            const resolving: PluginUiProjectionModel = { ...model, surfacePlacementsById: Object.fromEntries(
                Object.entries(model.surfacePlacementsById).map(([id, placement]) => [id, { ...placement,
                    availability: { state: 'resolving', reason: 'plugin_execution_origin_pending', diagnostics: [] },
                } satisfies PluginUiProjectionModel['surfacePlacementsById'][string]]),
            ) };
            await screen.update(render(resolving));
            await screen.update(render(model));
            expect(stackOptions.at(-1)?.headerTitle).toBe('Tasks');
        } finally { await screen.unmount(); }
    });

    it('retains execution context in the header when the admitted page is unavailable', async () => {
        const screen = await renderPage({ projection: daemonProjection({ availability: {
            state: 'disabled', reason: 'plugin_disabled', diagnostics: [],
        } }) });
        expect(screen.findByTestId('plugin-app-page-unavailable')).not.toBeNull();
        expect(screen.getTextContent()).toContain(NOTES_PLUGIN_ID);
        expect(screen.findByTestId('plugin-surface-execution.chip')).toBeNull();
        const headerRight = stackOptions.at(-1)?.headerRight;
        const header = await renderScreen((headerRight as () => React.ReactElement)());
        expect(header.findByTestId('plugin-page-execution.chip')).not.toBeNull();
    });

    it('does not construct a route-local destination binding outside the app target scope', async () => {
        await renderPage({ withTargetNavigation: false });

        expect(readRenderContext().hostApi.version().methods).not.toContain('openSurface');
    });

    it('renders a deep link with the location under the page root', async () => {
        await renderPage({ subPath: 'work/ideas.md' });

        expect(readRenderContext().subPath).toBe('work/ideas.md');
    });

    it('renders localized tombstone copy instead of coercing an invalid deep link to the page root', async () => {
        const screen = await renderPage({ subPath: null });

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.unavailableGeneric');
        expect(screen.getTextContent()).not.toContain('plugin_surface_open_sub_path_invalid');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('offers a localized Manage plugin recovery action when the page is missing from the plugin', async () => {
        const screen = await renderPage({ projection: daemonProjection({ omitPage: true }) });

        const action = screen.findByTestId('plugin-app-page-unavailable-action');
        expect(action).toBeTruthy();
        expect(action?.props.accessibilityLabel).toBe('Manage plugin');
        expect(screen.getTextContent()).toContain(NOTES_PLUGIN_ID);
    });

    it('offers no Manage plugin detour for an invalid link, which plugin management cannot fix', async () => {
        const screen = await renderPage({ subPath: null });

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-app-page-unavailable-action')).toBeNull();
    });

    it('keeps page recovery local when one plugin client executable is unavailable', async () => {
        const reloadClientExecutables = vi.fn();
        const screen = await renderPage({
            projection: daemonProjection({ omitPage: true }),
            clientExecutableActivation: { status: 'unavailable', failures: [] },
            reloadClientExecutables,
        });

        const action = screen.findByTestId('plugin-app-page-unavailable-action');
        expect(action?.props.accessibilityLabel).toBe('Manage plugin');
        action?.props.onPress();
        expect(reloadClientExecutables).not.toHaveBeenCalled();
        expect(routerPushes).toEqual([{
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: NOTES_PLUGIN_ID },
        }]);
    });

    it('keeps plugin B interactive when plugin A executable activation failed', async () => {
        await renderPage({
            clientExecutableActivation: {
                status: 'unavailable',
                failures: [{
                    pluginId: 'acme.failed-plugin-a',
                    target: {
                        artifactId: 'failed-runtime',
                        exportName: 'activate',
                        platform: 'web',
                    },
                    executionOrigin: {
                        serverIdentityId: 'srv_failed_a',
                        materializationRef: {
                            pluginId: 'acme.failed-plugin-a',
                            machineId: 'machine-1',
                            materializationId: 'failed-a-install',
                        },
                    },
                    occurrenceId: 'acme-broken-plugin-occurrence-12',
                    code: 'activation_failed',
                }],
            },
        });

        expect(readRenderContext().plugin.id).toBe(NOTES_PLUGIN_ID);
        expect(readRenderContext().signal.aborted).toBe(false);
    });

    it('routes each plugin to its OWN page when both declare the same local id', async () => {
        const projection = daemonProjection({ secondPlugin: true });

        await renderPage({ projection });
        expect(readRenderContext().plugin.id).toBe(NOTES_PLUGIN_ID);

        await renderPage({ pluginId: JOURNAL_PLUGIN_ID, projection });
        expect(readRenderContext().plugin.id).toBe(JOURNAL_PLUGIN_ID);
    });

    it('delivers the launch input a prior openSurface staged, and nothing when there was none', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        const screen = await renderScreen(<PageHost model={model} />);
        // An open the user started from the catalog carries no argument, and the
        // host must not fabricate one.
        expect(readRenderContext().launchInput).toBeUndefined();
        expect(readRenderContext()).not.toHaveProperty('launch');

        // The real path: a mounted surface opens the page at another location
        // with an argument, and the destination that navigation reaches receives
        // it — the host is not a shared map anyone can write into.
        await openFromMountedPage({ noteId: 'a' }, { subPath: 'work' });
        expect(routerPushes).toEqual([`${NOTES_PAGE_PATH}/work`]);

        routerLocation.pathname = `${NOTES_PAGE_PATH}/work`;
        await screen.update(<PageHost model={model} location={{ subPath: 'work' }} />);

        const context = readRenderContext();
        expect(context.subPath).toBe('work');
        expect(context.launchInput).toEqual({ noteId: 'a' });
        expect(context).toHaveProperty('launch', { kind: 'explicit', input: { noteId: 'a' } });

        // No input still identifies an explicit open. Reload/restoration above
        // carries neither this staged fact nor a fabricated empty input.
        await openFromMountedPage(undefined, { subPath: 'identity-only' });
        routerLocation.pathname = `${NOTES_PAGE_PATH}/identity-only`;
        await screen.update(<PageHost model={model} location={{ subPath: 'identity-only' }} />);
        expect(readRenderContext().launchInput).toBeUndefined();
        expect(readRenderContext()).toHaveProperty('launch', { kind: 'explicit' });
    });

    it('installs openSurface so the page can navigate its own location through real history', async () => {
        await renderPage();

        const hostApi = readRenderContext().hostApi;
        expect(hostApi.version().methods).toContain('openSurface');

        await hostApi.openSurface('notes', undefined, { subPath: 'work/ideas.md' });
        expect(routerPushes).toEqual([`${NOTES_PAGE_PATH}/work/ideas.md`]);
    });

    it('installs replacePageLocation so an interactive page can change its own location without a history entry', async () => {
        const { act } = await import('react-test-renderer');
        await renderPage();

        const hostApi = readRenderContext().hostApi;
        expect(hostApi.version().methods).toContain('replacePageLocation');

        // The page's filter/selection state moved. That is a LOCATION change,
        // not a destination selection: a push here would bury whatever screen
        // the user came from under the page's own interaction trail.
        await act(async () => {
            await expect(hostApi.replacePageLocation('/view/inbox//newest/'))
                .resolves.toEqual({ subPath: 'view/inbox/newest' });
        });
        // The host owns the route: the page is told the canonical location it
        // settled on, which is not the string it asked with.
        expect(routerReplacements).toEqual([`${NOTES_PAGE_PATH}/view/inbox/newest`]);
        expect(routerPushes).toEqual([]);

        // A location outside the page's own namespace is refused before it can
        // become a route, exactly as an open is.
        await act(async () => {
            await expect(hostApi.replacePageLocation('../../settings')).rejects.toThrow();
        });
        expect(routerReplacements).toHaveLength(1);
        expect(routerPushes).toEqual([]);
    });

    it('lets a page consume the device Back once with its declared step and yield on the next press', async () => {
        const { act } = await import('react-test-renderer');
        await renderAndroidPage({ subPath: 'entries' });

        const hostApi = readRenderContext().hostApi;
        // The page opened a detail: its location now names the detail, and the
        // step Back should undo is the list it came from.
        await act(async () => {
            await hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });
        expect(routerReplacements).toEqual([`${NOTES_PAGE_PATH}/entries/7`]);

        // First press: the page's own step, not a page exit.
        expect(nativeBack.press()).toBe(true);
        expect(routerReplacements).toEqual([
            `${NOTES_PAGE_PATH}/entries/7`,
            `${NOTES_PAGE_PATH}/entries`,
        ]);

        // Second press: the page is out of steps and yields, so ordinary host
        // navigation leaves the page. A participant that stayed armed here
        // would trap the user on a page they cannot Back out of.
        expect(nativeBack.press()).toBe(false);
        expect(routerReplacements).toHaveLength(2);
    });

    it('spends the page step when the route is removed, then lets the removal through', async () => {
        // A browser Back button, an iOS header Back and an iOS edge-swipe are
        // not three mechanisms: each removes the route. Before this the page
        // participated in Android's hardware Back alone, so on every other
        // client the first Back left the page entirely while the detail the
        // user was looking at was still open behind it.
        const { act } = await import('react-test-renderer');
        const { NavigationContext, useNavigation } = await import('@react-navigation/native');
        const NavigationProvider = ({ children }: React.PropsWithChildren) => (
            <NavigationContext.Provider value={useNavigation()}>
                {children}
            </NavigationContext.Provider>
        );
        nativeBack.platformOS = 'web';
        await renderPage({
            subPath: 'entries',
            wrap: (children) => (
                <NavigationProvider>
                    {children}
                </NavigationProvider>
            ),
        });

        // With no step declared the page leaves on the first removal. The
        // participant is mounted, so it is the REDISPATCH that has to be
        // exercised here: a page that intercepted and then swallowed a removal
        // it had no step for would trap the user on a page they cannot leave.
        await act(async () => { routeRemoval.remove({ type: 'POP', id: 'no-step' }); });
        expect(routeRemoval.dispatched).toEqual([{ type: 'POP', id: 'no-step' }]);
        expect(routerReplacements).toEqual([]);
        routeRemoval.dispatched.length = 0;

        const hostApi = readRenderContext().hostApi;
        await act(async () => {
            await hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });
        expect(routerReplacements).toEqual([`${NOTES_PAGE_PATH}/entries/7`]);

        // First removal: the page's own step, and the user stays.
        await act(async () => { routeRemoval.remove({ type: 'POP' }); });
        expect(routerReplacements).toEqual([
            `${NOTES_PAGE_PATH}/entries/7`,
            `${NOTES_PAGE_PATH}/entries`,
        ]);
        expect(routeRemoval.dispatched).toEqual([]);

        // Second removal: out of steps. The exact action React Navigation was
        // going to perform is redispatched rather than swallowed.
        await act(async () => { routeRemoval.remove({ type: 'POP' }); });
        expect(routeRemoval.dispatched).toEqual([{ type: 'POP' }]);
        expect(routerReplacements).toHaveLength(2);
    });

    it('consumes Escape with the page step on desktop and yields when it has none', async () => {
        // Escape is the desktop keyboard's Back and it is deliberately NOT the
        // route participant above: it has to be ordered against overlays,
        // popovers and modals, which only the app's Escape layer stack can do.
        const { act } = await import('react-test-renderer');
        const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
        nativeBack.platformOS = 'web';
        await renderPage({ subPath: 'entries' });

        // Nothing declared: the page must not eat a press it cannot act on, or
        // every surface below it stops seeing Escape while a plugin page is up.
        expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(false);

        const hostApi = readRenderContext().hostApi;
        await act(async () => {
            await hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });

        await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
        expect(routerReplacements).toEqual([
            `${NOTES_PAGE_PATH}/entries/7`,
            `${NOTES_PAGE_PATH}/entries`,
        ]);

        // The step was single-shot, so the next press belongs to whatever is
        // under the page again.
        expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(false);
        expect(routerReplacements).toHaveLength(2);
    });

    it('gives an overlay first refusal and keeps one stable page registration', async () => {
        const { act } = await import('react-test-renderer');
        await renderAndroidPage({ subPath: 'entries' });
        const pageRegistrations = nativeBack.registeredCount();
        expect(pageRegistrations).toBe(1);

        const hostApi = readRenderContext().hostApi;
        await act(async () => {
            await hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });
        // Declaring a step must not re-register the page listener: React Native
        // dispatches in reverse registration order, so a listener that came and
        // went with plugin state would keep changing its position relative to
        // overlays opened before it.
        expect(nativeBack.registeredCount()).toBe(pageRegistrations);

        // An overlay opened after the page owns its own Back and closes first.
        const overlayCloses: number[] = [];
        const overlay = nativeBack.addEventListener('hardwareBackPress', () => {
            overlayCloses.push(1);
            return true;
        });
        expect(nativeBack.press()).toBe(true);
        expect(overlayCloses).toHaveLength(1);
        expect(routerReplacements).toHaveLength(1);

        // With the overlay closed, the same press reaches the page's step.
        overlay.remove();
        expect(nativeBack.press()).toBe(true);
        expect(routerReplacements).toEqual([
            `${NOTES_PAGE_PATH}/entries/7`,
            `${NOTES_PAGE_PATH}/entries`,
        ]);
    });

    it('participates through the one native Back layer owner when a pane encloses the page', async () => {
        const { act } = await import('react-test-renderer');
        const { NativeBackLayerBoundary } = await import('@/components/ui/overlays/NativeBackLayerBoundary');
        const paneCloses: number[] = [];
        await renderAndroidPage({
            subPath: 'entries',
            wrap: (children) => (
                <NativeBackLayerBoundary active onRequestClose={() => { paneCloses.push(1); }}>
                    {children}
                </NativeBackLayerBoundary>
            ),
        });

        // The pane boundary is the app's ONE native Back owner here. A page
        // that reached `BackHandler` itself would add a second device
        // registration and race the boundary by mount order instead of
        // participating in it.
        expect(nativeBack.registeredCount()).toBe(1);

        await act(async () => {
            await readRenderContext().hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });
        expect(nativeBack.registeredCount()).toBe(1);

        // The page's own step wins over closing the pane the page lives in.
        expect(nativeBack.press()).toBe(true);
        expect(routerReplacements).toEqual([
            `${NOTES_PAGE_PATH}/entries/7`,
            `${NOTES_PAGE_PATH}/entries`,
        ]);
        expect(paneCloses).toHaveLength(0);

        // Out of page steps, Back belongs to the enclosing pane again.
        expect(nativeBack.press()).toBe(true);
        expect(routerReplacements).toHaveLength(2);
        expect(paneCloses).toHaveLength(1);
    });

    it('does not answer Back from a suppressed retained underlay', async () => {
        const { act } = await import('react-test-renderer');
        const { NativeBackLayerBoundary } = await import('@/components/ui/overlays/NativeBackLayerBoundary');
        await renderAndroidPage({
            subPath: 'entries',
            wrap: (children) => (
                <NativeBackLayerBoundary active suppressDescendants onRequestClose={() => {}}>
                    {children}
                </NativeBackLayerBoundary>
            ),
        });

        await act(async () => {
            await readRenderContext().hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });

        // A retained underlay is not what the user is looking at. Nothing
        // inside it may consume the device Back aimed at the visible layer.
        expect(nativeBack.registeredCount()).toBe(0);
        expect(nativeBack.press()).toBe(false);
        expect(routerReplacements).toEqual([`${NOTES_PAGE_PATH}/entries/7`]);
    });

    it('retires the page Back participant when the page unmounts', async () => {
        const { act } = await import('react-test-renderer');
        const screen = await renderAndroidPage({ subPath: 'entries' });

        await act(async () => {
            await readRenderContext().hostApi.replacePageLocation('entries/7', { backLocation: 'entries' });
        });
        expect(nativeBack.registeredCount()).toBe(1);

        await act(async () => { screen.unmount(); });
        // Nothing of this page may answer for a Back it no longer owns.
        expect(nativeBack.registeredCount()).toBe(0);
        expect(nativeBack.press()).toBe(false);
        expect(routerReplacements).toHaveLength(1);
    });

    it('updates the mounted render context when the page is reopened with new input', async () => {
        const { act } = await import('react-test-renderer');
        // The user is already AT the page root, which is what makes the reopen a
        // same-location one.
        routerLocation.pathname = NOTES_PAGE_PATH;
        await renderPage();
        expect(readRenderContext().launchInput).toBeUndefined();

        const hostApi = readRenderContext().hostApi;
        await act(async () => {
            await hostApi.openSurface('notes', { noteId: 'z' });
        });

        // §3.7: reopening an ALREADY-SELECTED page with new input updates the
        // render context. A staging map the mounted screen never re-reads would
        // make this a silent no-op — the plugin would keep rendering the
        // argument of a previous open.
        expect(readRenderContext().launchInput).toEqual({ noteId: 'z' });
        // The router owns whether the location adds a history entry. Its Expo
        // mirror can still name this root after the workspace moved deeper.
        expect(routerPushes).toEqual([NOTES_PAGE_PATH]);
    });

    it.each([false, true])('delivers a replacement open when the Expo mirror still names the root (Composer: %s)', async (composer) => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} />);
        await openFromMountedPage({ entryId: 'a' });
        expect(readRenderContext().launchInput).toEqual({ entryId: 'a' });
        const host = reactNativeSurfaceInstanceRefs.at(-1);
        // The workspace publishes a detail in place while Expo retains its
        // page-root mirror, exactly as a Triage route replacement does.
        await screen.update(<PageHost model={model} location={{ subPath: 'entry/a' }} />);
        expect(readRenderContext().launchInput).toBeUndefined();
        routerPushes.length = 0;
        const replacement = { entryId: 'b', ...(composer ? { originComposer: {
            kind: 'newSession', instanceId: '44444444-4444-4444-8444-444444444444',
        } } : {}) };
        await openFromMountedPage(replacement);
        // An accepted open must reach the router even if its cached Expo path
        // equals the destination. Otherwise the handoff stays stranded.
        expect(routerPushes).toEqual([NOTES_PAGE_PATH]);
        await screen.update(<PageHost model={model} />);
        expect(readRenderContext().launchInput).toEqual(replacement);
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(host);
    });

    it('rejects a location that would address out of the page namespace', async () => {
        await renderPage();

        const hostApi = readRenderContext().hostApi;
        await expect(hostApi.openSurface('notes', undefined, { subPath: '../../settings' }))
            .rejects.toThrow();
        expect(routerPushes).toEqual([]);
    });

    it('navigates to an installed current page of another plugin through the same qualified resolver', async () => {
        // Cross-plugin navigation is intentionally no broader than a normal
        // catalog destination: the target must be installed and currently
        // admitted, and the mounted caller still crosses the same public host
        // request, resolver, launch authority, and host router.
        const projection = daemonProjection({ secondPlugin: true });
        await renderPage({ projection });
        expect(readRenderContext().plugin.id).toBe(NOTES_PLUGIN_ID);

        const hostApi = readRenderContext().hostApi;
        await hostApi.openSurface({ pluginId: JOURNAL_PLUGIN_ID, localId: 'notes' }, { repair: 'provider-setup' });

        expect(routerPushes).toEqual([`/plugins/${JOURNAL_PLUGIN_ID}/notes`]);
    });

    it('rejects an unavailable qualified foreign page instead of falling back to the caller local id', async () => {
        // `acme.notes:notes` is mounted, but the requested qualified identity is
        // absent. A successful local navigation here would prove the page router
        // reselected a destination after the common resolver rejected it.
        await renderPage();

        await expect(readRenderContext().hostApi.openSurface({
            pluginId: JOURNAL_PLUGIN_ID,
            localId: 'notes',
        })).rejects.toMatchObject({ code: 'unavailable' });
        expect(routerPushes).toEqual([]);
    });

    it('survives generation replacement while the page is selected', async () => {
        await renderPage();
        expect(readRenderContext().plugin.id).toBe(NOTES_PLUGIN_ID);

        // A new projection generation replaces the mount; the page must still be
        // reachable at the SAME route. Pinning the catalog to the generation it
        // first saw would silently strand the user on an unavailable page.
        await renderPage({ subPath: 'work', projection: daemonProjection({ generation: 10 }) });

        const context = readRenderContext();
        expect(context.plugin.id).toBe(NOTES_PLUGIN_ID);
        expect(context.subPath).toBe('work');
    });

    it('does not deliver the previous generation launch input after generation replacement', async () => {
        const PageHost = await loadPageHost();
        // The user is already AT the page, so the open updates the mounted
        // context instead of pushing a second entry.
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={pageModel()} />);
        await openFromMountedPage({ noteId: 'a' });
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        await screen.update(<PageHost model={pageModel({ generation: 10 })} />);

        // A replacement generation is a DIFFERENT producer of the same page. The
        // route stays reachable (EU-5b) but the argument the previous generation
        // was opened with is not readdressed to it.
        const context = readRenderContext();
        expect(context.plugin.id).toBe(NOTES_PLUGIN_ID);
        expect(context.launchInput).toBeUndefined();
    });

    it('does not revive a launch input when the plugin is uninstalled and reinstalled', async () => {
        const PageHost = await loadPageHost();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={pageModel()} />);
        await openFromMountedPage({ noteId: 'a' });
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        await screen.update(<PageHost model={pageModel({ generation: 10, omitPage: true })} />);
        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();

        // Reinstalled under the same plugin id: same qualified page, new install.
        await screen.update(<PageHost model={pageModel({ generation: 11 })} />);

        expect(readRenderContext().launchInput).toBeUndefined();
    });

    it('does not carry a launch input across a server switch', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} serverId="server-1" />);
        await openFromMountedPage({ noteId: 'a' });
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        // The active Account lifecycle retires before the successor server
        // renders. Changing only the page projection would leave the old
        // Account current and prove a fixture artifact rather than this
        // cross-server handoff contract.
        const { act } = await import('react-test-renderer');
        await act(async () => {
            retireActiveServerAccountScopeLifetime();
            await restorePageAccount('server-2');
            await screen.update(<PageHost model={pageModel({}, 'server-2')} serverId="server-2" />);
        });

        // Bounded plugin JSON belongs to the account/server it was produced for.
        expect(readRenderContext().launchInput).toBeUndefined();
    });

    it('does not reuse an earlier open input on a later direct navigation to the same location', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} />);

        await openFromMountedPage({ noteId: 'a' }, { subPath: 'work' });
        expect(routerPushes).toEqual([`${NOTES_PAGE_PATH}/work`]);

        routerLocation.pathname = `${NOTES_PAGE_PATH}/work`;
        await screen.update(<PageHost model={model} location={{ subPath: 'work' }} />);
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        // The user leaves the page…
        await screen.update(<PageHost model={model} location={null} />);
        routerLocation.pathname = '/';

        // …and later a deep link addresses the same location again. That
        // navigation carries no argument, so neither does the render context.
        routerLocation.pathname = `${NOTES_PAGE_PATH}/work`;
        await screen.update(<PageHost model={model} location={{ subPath: 'work' }} />);

        expect(readRenderContext().launchInput).toBeUndefined();
    });

    it('restores the location but not an earlier open input when history returns to the page', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} />);

        await openFromMountedPage({ noteId: 'a' }, { subPath: 'work/ideas.md' });
        routerLocation.pathname = `${NOTES_PAGE_PATH}/work/ideas.md`;
        await screen.update(<PageHost model={model} location={{ subPath: 'work/ideas.md' }} />);
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        // Back to the page root…
        routerLocation.pathname = NOTES_PAGE_PATH;
        await screen.update(<PageHost model={model} location={{ subPath: '' }} />);
        // …and forward again to the deep location.
        routerLocation.pathname = `${NOTES_PAGE_PATH}/work/ideas.md`;
        await screen.update(<PageHost model={model} location={{ subPath: 'work/ideas.md' }} />);

        // §EU-5b restoration is page identity and `subPath` — the retained
        // navigation state — and nothing the plugin did not navigate with.
        const context = readRenderContext();
        expect(context.subPath).toBe('work/ideas.md');
        expect(context.launchInput).toBeUndefined();
    });

    it('clears the mounted launch input when the page is reopened without one', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        await renderScreen(<PageHost model={model} />);

        await openFromMountedPage({ noteId: 'a' });
        expect(readRenderContext().launchInput).toEqual({ noteId: 'a' });

        // §3.7: an open WITHOUT input REPLACES the previous argument.
        await openFromMountedPage(undefined);
        expect(readRenderContext().launchInput).toBeUndefined();
    });

    it('clears an old mounted launch input when the launcher reopens the same page without remounting it', () => withPopoverWebGlobals(async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} showCompactSidebar />);

        await openFromMountedPage({ recordId: 'old' });
        expect(readRenderContext().launchInput).toEqual({ recordId: 'old' });
        expect(routerPushes).toEqual([NOTES_PAGE_PATH]);
        const mountedSurface = reactNativeSurfaceInstanceRefs.at(-1);
        // Plugin destinations live in the launcher's existing More disclosure.
        // A missing row must fail the test rather than silently skip reopening.
        await screen.pressByTestIdAsync('phone-launcher-button');
        // The real dropdown opens on the browser's next frame/task, not in the press callback.
        await vi.waitFor(() => expect(screen.findHostByTestId('compact-app-destination:plugin:acme.notes:notes')).not.toBeNull());
        await screen.pressByTestIdAsync('compact-app-destination:plugin:acme.notes:notes');

        await vi.waitFor(() => expect(readRenderContext().launchInput).toBeUndefined());
        // The outcome is the cleared input on the same mount; how the phone More reaches an open page is its own.
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(mountedSurface);
    }, pagePopoverWebGlobals()));

    it('clears an old mounted launch input when the compact command palette reopens the same page without remounting it', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} showCompactCommandPaletteActivation />);

        await openFromMountedPage({ recordId: 'old' });
        expect(readRenderContext().launchInput).toEqual({ recordId: 'old' });
        expect(routerPushes).toEqual([NOTES_PAGE_PATH]);
        const mountedSurface = reactNativeSurfaceInstanceRefs.at(-1);
        const command = screen.findByTestId('compact-command-palette-app-page-activation');

        const { act } = await import('react-test-renderer');
        await act(async () => {
            await command?.props.onPress();
        });

        expect(readRenderContext().launchInput).toBeUndefined();
        expect(routerPushes).toEqual([NOTES_PAGE_PATH, NOTES_PAGE_PATH]);
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(mountedSurface);
    });

    it('degrades visibly when the plugin is uninstalled while its page is selected', async () => {
        const screen = await renderPage({ projection: daemonProjection({ omitPage: true }) });

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('degrades visibly when the page is unknown', async () => {
        const screen = await renderPage({ localId: 'missing' });

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('degrades visibly with localized plugin-runtime copy when the plugin lost availability', async () => {
        const screen = await renderPage({
            projection: daemonProjection({
                availability: { state: 'disabled', reason: 'plugin_disabled', diagnostics: [] },
            }),
        });

        expect(screen.findByTestId('plugin-app-page-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginRuntime.disabledByPolicy');
        expect(screen.getTextContent()).not.toContain('plugin_disabled');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });
});
