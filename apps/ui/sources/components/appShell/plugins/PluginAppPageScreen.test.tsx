import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
    normalizePluginUiDestinationBindingV1,
    type PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
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
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
} from './pluginAppPages';
import { usePluginAppPageDestinationHandler } from './pluginAppPageNavigation';

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

const contributionProjectionDescribeMock = vi.hoisted(() => vi.fn());
const accountEncryptionModeCredentials = vi.hoisted(() => ({
    value: { token: 'plugin-app-page-account-mode-test-token' } as Readonly<{ token: string }> | null,
}));
const accountEncryptionModeFetch = vi.hoisted(() => vi.fn<
    typeof import('@/sync/api/account/apiAccountEncryptionMode').fetchAccountEncryptionMode
>());

const compactDestinationState = vi.hoisted(() => ({
    destinations: [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Notes',
        icon: 'note',
        group: 'plugins',
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

const pluginSurfaceConnectivity = vi.hoisted(() => ({
    endpointStatus: 'online' as 'online' | 'offline',
    machineOnline: true,
    daemonStateVersion: 1,
}));

// The production host deliberately refuses to expose an interactive surface
// without the Account lifetime that owns its currentness. This page-route
// fixture is an active Account mount, so provide that real boundary fact rather
// than weakening the host just to make a renderer mock appear.
const pluginSurfaceAccountLifetime = vi.hoisted(() => {
    const create = (serverId: string) => {
        let current = true;
        const retireListeners = new Set<() => void>();
        return Object.freeze({
            scope: Object.freeze({ serverId, accountId: 'account-1' }),
            isCurrent: () => current,
            onRetire: (listener: () => void) => {
                if (!current) {
                    listener();
                    return Object.freeze({ dispose: () => {} });
                }
                retireListeners.add(listener);
                return Object.freeze({ dispose: () => { retireListeners.delete(listener); } });
            },
            retire: () => {
                if (!current) return;
                current = false;
                for (const listener of [...retireListeners]) listener();
                retireListeners.clear();
            },
        });
    };
    const initialLifetime = create('server-1');
    return {
        create,
        value: initialLifetime as typeof initialLifetime | null,
    };
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useEndpointStatus: () => pluginSurfaceConnectivity.endpointStatus,
    useMachineCliDetectionTarget: () => ({
        isOnline: pluginSurfaceConnectivity.machineOnline,
        daemonStateVersion: pluginSurfaceConnectivity.daemonStateVersion,
    }),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => pluginSurfaceAccountLifetime.value,
}));

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

// A generated React Native mount must consume the exact target-scoped daemon
// snapshot, rather than the app-page fixture reconstructing target facts at the
// host. Keep that RPC boundary real beneath this response mock.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => contributionProjectionDescribeMock(...args),
}));

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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { en } = await import('@/text/translations/en');
    const translate = (key: string) => {
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

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async () => {
    const ReactModule = await import('react');
    return {
        PluginReactNativeSurface: (props: any) => {
            const instance = ReactModule.useRef({});
            reactNativeSurfaceProps.push(props);
            reactNativeSurfaceInstanceRefs.push(instance.current);
            return ReactModule.createElement('PluginReactNativeSurfaceMock', {
                testID: 'plugin-react-native-surface-proxy',
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

const PAGE_ARTIFACT_ENTRY = 'react-native/notes/index.js';
const PAGE_ARTIFACT_BYTES = new TextEncoder().encode('export function renderSurface() { return null; }');
const PAGE_FILE_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAGE_ARTIFACT_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOTES_PLUGIN_ID = 'acme.notes';
const JOURNAL_PLUGIN_ID = 'acme.journal';
const NOTES_PAGE_PATH = `/plugins/${NOTES_PLUGIN_ID}/notes`;

const pageCacheIdentity = {
    pluginId: NOTES_PLUGIN_ID,
    contributionId: 'notes-renderer',
    artifactDigest: PAGE_ARTIFACT_DIGEST,
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    platform: 'web',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 9,
} as const;

function daemonProjection(input: Readonly<{
    availability?: Readonly<{ state: string; reason: string; diagnostics: readonly string[] }>;
    headerActions?: readonly unknown[];
    secondPlugin?: boolean;
    generation?: number;
    /** Simulates the plugin being uninstalled while its page is selected. */
    omitPage?: boolean;
}> = {}) {
    const generation = input.generation ?? 9;
    const packageEntry = (pluginId: string) => ({
        id: pluginId,
        displayName: pluginId === NOTES_PLUGIN_ID ? 'Notes' : 'Journal',
        version: '1.0.0',
        enabled: true,
        source: { kind: 'bundled', locator: pluginId },
        // The package owner is the sole source of this target identity. It is
        // deliberately distinct from the aggregate projection generation.
        immutableGenerationId: `${pluginId}-generation-${generation}`,
        brand: { state: 'missing' },
    });
    const placementEntry = (pluginId: string) => {
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId,
            destinationId: 'notes',
            rendererId: 'notes-renderer',
            container: 'appPage',
            target: { kind: 'app' },
        });
        if (!binding) throw new Error('test fixture must use an admitted V2 page binding');
        return {
            id: `surfacePlacement:${pluginId}:notes`,
            pluginId,
            pluginVersion: '1.0.0',
            contributionKind: 'surfacePlacement',
            descriptorId: 'notes',
            generatedV2: true,
            binding,
            target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'notes-renderer' },
            display: { titleKey: 'notes', developerFallback: pluginId === NOTES_PLUGIN_ID ? 'Notes' : 'Journal' },
            actions: [],
            ...(input.headerActions === undefined ? {} : { headerActions: input.headerActions }),
            // Host-private F7 provenance from the selected union contribution.
            // The page launch owner refuses to infer this from the ValueProvider's
            // coarse machine/generation when it is absent.
            hostOrigin: {
                machineId: 'machine-1',
                serverId: 'server-1',
                generation,
                phase: 'current',
                interactionEnabled: true,
                executionOrigin: {
                    serverIdentityId: 'srv_account_one',
                    materializationRef: {
                        pluginId,
                        machineId: 'machine-1',
                        materializationId: `${pluginId}-install-${generation}`,
                    },
                },
            },
            // Generated RN crash custody is projected on the destination
            // descriptor, not on the shared renderer bundle.
            runtime: {
                reactNativeCrashState: {
                    token: {
                        mount: {
                            kind: 'destination',
                            destination: { pluginId, localId: 'notes' },
                        },
                        renderer: { pluginId, localId: 'notes-renderer' },
                        artifactDigest: PAGE_ARTIFACT_DIGEST,
                        crashStateEpoch: 0,
                    },
                    disabled: false,
                },
            },
            availability: input.availability
                ?? { state: 'available', reason: 'available', diagnostics: [] },
        };
    };
    const bundleEntry = (pluginId: string) => ({
        id: `reactNativeBundle:${pluginId}:notes-renderer`,
        pluginId,
        pluginVersion: '1.0.0',
        contributionKind: 'reactNativeBundle',
        contributionId: 'notes-renderer',
        generatedV2: true,
        hostApi: { minVersion: '1.0.0', methods: ['context'] },
        artifactGraph: {
            contributionId: 'notes-renderer',
            tier: 'reactNative',
            platform: 'web',
            entry: PAGE_ARTIFACT_ENTRY,
            files: [{
                relativePath: PAGE_ARTIFACT_ENTRY,
                digest: PAGE_FILE_DIGEST,
                byteSize: PAGE_ARTIFACT_BYTES.byteLength,
            }],
            digest: PAGE_ARTIFACT_DIGEST,
            builtWith: { bundler: 'vite', version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        },
        runtime: {
            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
            loadPolicy: { source: 'installedArtifact' },
            cacheKey: `${pluginId}-page-cache-key`,
            cacheIdentity: { ...pageCacheIdentity, pluginId, projectionGeneration: generation },
        },
    });
    const entries: Record<string, unknown> = {
        ...(input.omitPage ? {} : { [`surfacePlacement:${NOTES_PLUGIN_ID}:notes`]: placementEntry(NOTES_PLUGIN_ID) }),
        [`reactNativeBundle:${NOTES_PLUGIN_ID}:notes-renderer`]: bundleEntry(NOTES_PLUGIN_ID),
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
        familiesById: { pluginUi: { entriesById: entries } },
    } as never;
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

async function renderPage(input: Readonly<{
    pluginId?: string;
    localId?: string;
    subPath?: string | null;
    projection?: unknown;
    /** `null` models a multi-member app projection with no coarse execution origin. */
    machineId?: string | null;
    serverId?: string | null;
    withTargetNavigation?: boolean;
}> = {}) {
    const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
    const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');
    const { act } = await import('react-test-renderer');
    const model = normalizePluginUiProjection((input.projection ?? daemonProjection()) as never);
    const screen = await renderScreen(
        <AppShellPluginUiProjectionValueProvider
            value={{
                pluginUiProjection: model,
                pluginBrowserProjection: null,
                phase: 'current',
                interactionEnabled: true,
                machineId: input.machineId === undefined ? 'machine-1' : input.machineId,
                serverId: input.serverId === undefined ? 'server-1' : input.serverId,
                platform: 'web',
            }}
        >
            <AppTargetNavigationScope model={model} enabled={input.withTargetNavigation !== false}>
                <PluginAppPageScreen
                pluginId={input.pluginId ?? NOTES_PLUGIN_ID}
                localId={input.localId ?? 'notes'}
                subPath={input.subPath === undefined ? '' : input.subPath}
                />
            </AppTargetNavigationScope>
        </AppShellPluginUiProjectionValueProvider>,
        // The exact target snapshot and Account-mode disclosure are both required
        // mount facts. Use the canonical drain so this route test observes the
        // admitted renderer rather than its transient fail-closed placeholder.
    );
    return screen;
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

function pageModel(input: Parameters<typeof daemonProjection>[0] = {}): PluginUiProjectionModel {
    return normalizePluginUiProjection(daemonProjection(input) as never);
}

function AppTargetNavigationScope(props: React.PropsWithChildren<Readonly<{
    model: PluginUiProjectionModel;
    enabled?: boolean;
}>>): React.ReactElement {
    const pages = React.useMemo(() => resolvePluginAppPages({
        placements: selectPluginAppPagePlacements(props.model),
    }), [props.model]);
    const binding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: Object.values(props.model.surfacePlacementsById),
        settingsPages: Object.values(props.model.settingsPagesById),
        targetKind: 'app',
        accountLifetime: pluginSurfaceAccountLifetime.value,
    });
    const openPage = usePluginAppPageDestinationHandler({ pages });
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
    const { SessionsListActionRows } = await import('@/components/sessions/shell/SessionsListActionRows');
    const { buildCommandPaletteCommands } = await import('@/components/appShell/commandPalette/buildCommandPaletteCommands');
    const { usePluginAppPageLaunchInputStaging } = await import('./pluginAppPageNavigation');

    function CompactCommandPaletteActivation(): React.ReactElement {
        const stageLaunchInput = usePluginAppPageLaunchInputStaging();
        const command = React.useMemo(() => {
            // The command builder owns command creation; this is the same host
            // activation boundary the web provider supplies to it.
            const input = {
                sessionsById: {},
                isDev: false,
                activeSessionId: null,
                features: { executionRunsEnabled: false, voiceEnabled: false, memorySearchEnabled: false },
                compactAppDestinations: compactDestinationState.destinations,
                onActivateCompactAppDestination: (destination: CompactAppDestination) => {
                    if (destination.kind !== 'plugin' || destination.container !== 'appPage') {
                        throw new Error('compact activation fixture must address an app page');
                    }
                    stageLaunchInput({ pageId: destination.id, subPath: '', input: undefined });
                },
                nav: {
                    push: (routePath: string) => { routerPushes.push(routePath); },
                    navigateToSession: () => {},
                },
                auth: { logout: async () => {} },
                actions: { execute: async () => ({ ok: true, result: {} }) },
                alert: async () => {},
            };
            return buildCommandPaletteCommands(input).find((entry) => (
                entry.id === 'app-destination:plugin:acme.notes:notes'
            ));
        }, [stageLaunchInput]);
        if (!command) throw new Error('compact app-page command must be available');
        return React.createElement('CompactCommandPaletteActivation', {
            testID: 'compact-command-palette-app-page-activation',
            onPress: command.action,
        });
    }

    return function PageHost(props: PageHostProps): React.ReactElement {
        return (
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: props.model,
                    pluginBrowserProjection: null,
                    phase: 'current',
                    interactionEnabled: true,
                    machineId: props.machineId ?? 'machine-1',
                    serverId: props.serverId ?? 'server-1',
                    platform: 'web',
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
                    {props.showCompactSidebar ? <SessionsListActionRows externalSessionsEnabled={false} /> : null}
                    {props.showCompactCommandPaletteActivation ? <CompactCommandPaletteActivation /> : null}
                </AppTargetNavigationScope>
            </AppShellPluginUiProjectionValueProvider>
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
    reactNativeSurfaceProps.length = 0;
    reactNativeSurfaceInstanceRefs.length = 0;
    routerPushes.length = 0;
    routerReplacements.length = 0;
    nativeBack.reset();
    stackOptions.length = 0;
    routerLocation.pathname = '/';
    pluginSurfaceAccountLifetime.value = pluginSurfaceAccountLifetime.create('server-1');
    accountEncryptionModeCredentials.value = { token: 'plugin-app-page-account-mode-test-token' };
    accountEncryptionModeFetch.mockReset();
    accountEncryptionModeFetch.mockResolvedValue({ mode: 'plain', updatedAt: 1 });
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
    contributionProjectionDescribeMock.mockImplementation(async (_machineId: unknown, options: unknown) => {
        const target = options !== null && typeof options === 'object'
            ? (options as { mountedTarget?: unknown }).mountedTarget
            : undefined;
        if (!target) return { supported: false, reason: 'not-supported' };
        return {
            supported: true,
            projection: {
                v: 2,
                generation: 9,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
            targetedContributions: { target, points: [] },
        };
    });
    await primePageArtifact(NOTES_PLUGIN_ID);
    await primePageArtifact(JOURNAL_PLUGIN_ID);
});

afterEach(() => {
    pluginSurfaceConnectivity.endpointStatus = 'online';
    pluginSurfaceConnectivity.machineOnline = true;
});

describe('plugin app page host route (EU-5b)', () => {
    it('keeps a restored deep link pending until the app projection has described its exact page', async () => {
        const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
        const { AppShellPluginUiProjectionValueProvider } = await import('./AppShellPluginUiProjection');

        const screen = await renderScreen(
            <AppShellPluginUiProjectionValueProvider
                value={{
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    pluginBrowserProjection: null,
                    phase: 'establishing',
                    interactionEnabled: false,
                    machineId: null,
                    serverId: null,
                    platform: 'web',
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
        const header = (headerRight as () => React.ReactElement<{
            signal?: AbortSignal;
            isCurrent?: () => boolean;
        }>)();
        expect(header.props.signal?.aborted).toBe(false);
        expect(header.props.isCurrent?.()).toBe(true);

        const { act } = await import('react-test-renderer');
        await act(async () => {
            pluginSurfaceAccountLifetime.value?.retire();
        });

        expect(header.props.signal?.aborted).toBe(true);
        expect(header.props.isCurrent?.()).toBe(false);
    });

    it('keeps a page-bound Action enabled from its exact selected origin when the app union has no coarse machine', async () => {
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

        expect(action?.props.disabled).toBe(false);
    });

    it('mounts the declared page at its root with an empty plugin-local location', async () => {
        await renderPage();

        const context = readRenderContext();
        expect(context.plugin.id).toBe(NOTES_PLUGIN_ID);
        expect(context.surface.mount).toEqual({
            kind: 'destination',
            destination: { pluginId: NOTES_PLUGIN_ID, localId: 'notes' },
            container: 'appPage',
        });
        expect(context).not.toHaveProperty('view');
        expect(context.surface.target).toEqual({ kind: 'app' });
        expect(contributionProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-1',
            mountedTarget: {
                pluginId: NOTES_PLUGIN_ID,
                immutableGenerationId: `${NOTES_PLUGIN_ID}-generation-9`,
            },
        }));
        expect(context.surface.targetedContributions).toEqual({
            target: {
                pluginId: NOTES_PLUGIN_ID,
                immutableGenerationId: `${NOTES_PLUGIN_ID}-generation-9`,
            },
            points: [],
        });
        expect(context.subPath).toBe('');
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

    it('offers a localized Manage plugin recovery action when the page is unavailable', async () => {
        const screen = await renderPage({ subPath: null });

        const action = screen.findByTestId('plugin-app-page-unavailable-action');
        expect(action).toBeTruthy();
        expect(action?.props.accessibilityLabel).toBe('Manage plugin');
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
        nativeBack.platformOS = 'android';
        await renderPage({ subPath: 'entries' });

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

    it('gives an overlay first refusal and keeps one stable page registration', async () => {
        const { act } = await import('react-test-renderer');
        nativeBack.platformOS = 'android';
        await renderPage({ subPath: 'entries' });
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

    it('retires the page Back participant when the page unmounts', async () => {
        const { act } = await import('react-test-renderer');
        nativeBack.platformOS = 'android';
        const screen = await renderPage({ subPath: 'entries' });

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
        // …and it does NOT stack a second history entry for the same location.
        expect(routerPushes).toEqual([]);
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
            pluginSurfaceAccountLifetime.value?.retire();
            pluginSurfaceAccountLifetime.value = pluginSurfaceAccountLifetime.create('server-2');
            await screen.update(<PageHost model={model} serverId="server-2" />);
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

    it('clears an old mounted launch input when the compact sidebar reopens the same page without remounting it', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} showCompactSidebar />);

        await openFromMountedPage({ recordId: 'old' });
        expect(readRenderContext().launchInput).toEqual({ recordId: 'old' });
        expect(routerPushes).toEqual([]);
        const mountedSurface = reactNativeSurfaceInstanceRefs.at(-1);
        const sidebar = screen.findByTestId('compact-app-destination:plugin:acme.notes:notes');

        const { act } = await import('react-test-renderer');
        await act(async () => {
            sidebar?.props.onPress();
        });

        expect(readRenderContext().launchInput).toBeUndefined();
        expect(routerPushes).toEqual([]);
        expect(reactNativeSurfaceInstanceRefs.at(-1)).toBe(mountedSurface);
    });

    it('clears an old mounted launch input when the compact command palette reopens the same page without remounting it', async () => {
        const PageHost = await loadPageHost();
        const model = pageModel();
        routerLocation.pathname = NOTES_PAGE_PATH;
        const screen = await renderScreen(<PageHost model={model} showCompactCommandPaletteActivation />);

        await openFromMountedPage({ recordId: 'old' });
        expect(readRenderContext().launchInput).toEqual({ recordId: 'old' });
        expect(routerPushes).toEqual([]);
        const mountedSurface = reactNativeSurfaceInstanceRefs.at(-1);
        const command = screen.findByTestId('compact-command-palette-app-page-activation');

        const { act } = await import('react-test-renderer');
        await act(async () => {
            await command?.props.onPress();
        });

        expect(readRenderContext().launchInput).toBeUndefined();
        expect(routerPushes).toEqual([]);
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
        expect(screen.getTextContent()).toContain('pluginRuntime.unavailableGeneric');
        expect(screen.getTextContent()).not.toContain('plugin_disabled');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });
});
