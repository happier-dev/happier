import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    MarketplaceIndexQueryResultV1,
    MarketplaceSourceRegistryV1,
    PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
}>;

type InstalledPluginEntry = Readonly<{
    pluginId: string;
    title: string;
    description: string | null;
    version: string;
    enabled: boolean;
    rollbackAvailability?: 'available' | 'unavailable';
    source: Readonly<{
        kind: string;
        locator: string;
        devWatch?: boolean;
        trustPolicy?: string;
        installPolicy?: string;
        resolvedPath?: string;
        resolvedDigest?: string | null;
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
        manifestDigest?: string | null;
        installedPath?: string | null;
    }>;
    compatibility: Readonly<{
        status: string;
        diagnostics: readonly InstalledPluginDiagnostic[];
    }>;
    diagnostics: readonly InstalledPluginDiagnostic[];
}>;

type MachineCapabilitiesResponse = Readonly<{
    protocolVersion: 1;
    results: Readonly<Record<string, Readonly<{
        ok: true;
        checkedAt: number;
        data?: {
            installedPlugins?: readonly InstalledPluginEntry[];
            developmentActions?: Readonly<{ create: boolean }>;
            developmentSources?: readonly Readonly<{
                pluginId: string;
                sourceRootPath: string;
                watch: Readonly<{ state: 'configured' }>;
                reload: Readonly<{
                    state: 'clear' | 'attention';
                    diagnostics: readonly InstalledPluginDiagnostic[];
                }>;
                actions: Readonly<{ test: boolean; pack: boolean }>;
            }>[];
        } | null;
    }>>>;
}>;

type MachineCapabilitiesSnapshot = Readonly<{
    response: MachineCapabilitiesResponse;
}>;

type MachineCapabilitiesState =
    | Readonly<{
        status: 'idle';
    }>
    | Readonly<{
        status: 'not-supported';
    }>
    | Readonly<{
        status: 'loaded';
        snapshot: MachineCapabilitiesSnapshot;
    }>
    | Readonly<{
        status: 'loading';
        snapshot: MachineCapabilitiesSnapshot;
    }>
    | Readonly<{
        status: 'error';
        snapshot: MachineCapabilitiesSnapshot;
    }>;
type LoadedMachineCapabilitiesState = Extract<MachineCapabilitiesState, Readonly<{ status: 'loaded' }>>;

const usePrimaryMachineFromActiveSelectionMock = vi.hoisted(() => vi.fn());
const getActiveServerIdMock = vi.hoisted(() => vi.fn());
const useMachineCapabilitiesCacheMock = vi.hoisted(() => vi.fn());
const getMachineCapabilitiesCacheStateMock = vi.hoisted(() => vi.fn());
const useMachineCliDetectionTargetMock = vi.hoisted(() => vi.fn());
const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));
const invokeWithAlertsMock = vi.hoisted(() => vi.fn());
const refreshMachineCapabilitiesMock = vi.hoisted(() => vi.fn());
const machineMarketplaceSourceRegistryGetMock = vi.hoisted(() => vi.fn());
const machineMarketplaceIndexQueryMock = vi.hoisted(() => vi.fn());
const machineNpmRegistryProfilesGetMock = vi.hoisted(() => vi.fn());
const machineNpmRegistryProfilesMutateMock = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn());
const machinePluginStructuredMessageActionExecuteMock = vi.hoisted(() => vi.fn());
const publishMachineContributionRegistryProjectionInvalidationMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const navigationSetOptionsSpy = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const prefetchMachineCapabilitiesMock = vi.hoisted(() => vi.fn());

const MARKETPLACE_CAPABILITY_ID = 'tool.plugins';

function createInstalledPlugin(overrides: Partial<InstalledPluginEntry> & Pick<InstalledPluginEntry, 'pluginId' | 'title' | 'version'>): InstalledPluginEntry {
    return {
        description: 'Installed plugin',
        enabled: true,
        source: {
            kind: 'catalog',
            locator: 'https://marketplace.example.test/catalog.json',
            trustPolicy: 'trusted',
            installPolicy: 'allow',
            resolvedPath: '/plugins/sample',
            resolvedDigest: 'sha256:abc123',
        },
        install: {
            mode: 'catalog',
            manifestVersion: '1',
            manifestDigest: 'sha256:manifest',
            installedPath: '/plugins/sample',
        },
        compatibility: {
            status: 'compatible',
            diagnostics: [],
        },
        diagnostics: [],
        rollbackAvailability: 'unavailable',
        ...overrides,
    };
}

function createPluginDiagnosticRecord(params: Readonly<{
    id: string;
    pluginId: string;
    code: string;
    message: string;
    severity: PluginDiagnosticRecordV1['data']['severity'];
}>): PluginDiagnosticRecordV1 {
    return {
        version: 1,
        id: params.id,
        data: {
            code: params.code,
            message: params.message,
            severity: params.severity,
        },
        plugin: {
            id: params.pluginId,
            version: '1.0.0',
            source: 'localPath',
        },
        stage: 'normalization',
        generation: '12',
        host: 'daemon',
        platform: 'test',
        occurredAtMs: 1,
        resolution: { state: 'current' },
    };
}

function createMachineCapabilitiesState(
    installedPlugins: readonly InstalledPluginEntry[],
    developmentSources: NonNullable<NonNullable<MachineCapabilitiesResponse['results'][string]>['data']>['developmentSources'] = [],
): LoadedMachineCapabilitiesState {
    return {
        status: 'loaded',
        snapshot: {
            response: {
                protocolVersion: 1,
                results: {
                    [MARKETPLACE_CAPABILITY_ID]: {
                        ok: true,
                        checkedAt: Date.now(),
                        data: {
                            installedPlugins,
                            developmentActions: { create: true },
                            developmentSources,
                        },
                    },
                },
            },
        },
    };
}

function createMachineCapabilitiesErrorState(installedPlugins: readonly InstalledPluginEntry[]): MachineCapabilitiesState {
    return {
        ...createMachineCapabilitiesState(installedPlugins),
        status: 'error',
    };
}

function createMachineCapabilitiesLoadingState(installedPlugins: readonly InstalledPluginEntry[]): MachineCapabilitiesState {
    return {
        ...createMachineCapabilitiesState(installedPlugins),
        status: 'loading',
    };
}

function createMarketplaceCatalogEntry(params: Readonly<{
    pluginId: string;
    title?: string;
    description?: string;
    version?: string;
    entryId?: string;
    sourceUrl?: string;
    packageUrl?: string;
    categories?: readonly string[];
}>): Readonly<{
    id: string;
    manifestId: string;
    title: string;
    description: string;
    version: string;
    sourceUrl: string;
    packageUrl: string;
    categories: readonly string[];
}> {
    return {
        id: params.entryId ?? `marketplace.${params.pluginId}`,
        manifestId: params.pluginId,
        title: params.title ?? params.pluginId,
        description: params.description ?? 'Catalog descriptor',
        version: params.version ?? '1.0.0',
        sourceUrl: params.sourceUrl ?? `https://marketplace.example.test/entries/${params.pluginId}.json`,
        packageUrl: params.packageUrl ?? `https://marketplace.example.test/plugins/${params.pluginId}.tgz`,
        categories: params.categories ?? [],
    };
}

function createDaemonMarketplaceIndexResult(
    entries: readonly ReturnType<typeof createMarketplaceCatalogEntry>[],
    options: Readonly<{
        sourceId?: string;
        sourceTitle?: string;
        sourceUrl?: string;
        sourceKind?: 'curated' | 'user' | 'community-npm';
        freshnessState?: 'fresh' | 'stale' | 'stale-offline';
        reviewStatus?: 'approved' | 'withdrawn' | 'blocked' | 'unreviewed';
        curatedInstall?: 'allowed' | 'refused' | 'full-review';
        curatedUpdate?: 'allowed' | 'refused' | 'not-applicable';
        warning?: boolean;
        artifactAccessState?: 'public' | 'unverified-profile';
    }> = {},
): MarketplaceIndexQueryResultV1 {
    const sourceId = options.sourceId ?? 'marketplace:curated';
    const sourceTitle = options.sourceTitle ?? 'Curated Marketplace';
    const sourceUrl = options.sourceUrl ?? 'https://marketplace.example.test/catalog.json';
    return {
        revision: 1,
        items: entries.map((entry) => ({
            pluginId: entry.manifestId,
            publisher: { id: 'acme', displayName: 'Acme' },
            display: { title: entry.title, description: entry.description },
            distribution: {
                kind: 'npm',
                registryOrigin: 'https://registry.npmjs.org',
                packageName: `@acme/${entry.manifestId}`,
                version: entry.version,
                integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==',
            },
            manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            compatibility: { happier: '>=1', platforms: ['web'] },
            summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
            review: {
                status: options.reviewStatus ?? 'approved',
                reviewedAt: (options.reviewStatus ?? 'approved') === 'approved' ? '2026-07-22T00:00:00.000Z' : null,
            },
            categories: ['agents'],
            media: [],
            updatePolicy: 'curated-auto',
            links: {},
            source: {
                id: sourceId,
                title: sourceTitle,
                kind: options.sourceKind ?? 'curated',
                sourceUrl,
            },
            freshness: { state: options.freshnessState ?? 'fresh', fetchedAtMs: 1 },
            admission: {
                curatedInstall: options.curatedInstall ?? 'allowed',
                curatedUpdate: options.curatedUpdate ?? 'allowed',
                warning: options.warning ?? false,
                mutatesInstalledTrust: false,
                disablesInstalledCode: false,
                directNpmRequiresFullReview: true,
            },
            artifactAccess: {
                state: options.artifactAccessState ?? 'public',
                registryProfileId: null,
            },
        })),
        nextCursor: null,
        sources: [{
            source: { id: sourceId, title: sourceTitle, kind: options.sourceKind ?? 'curated', sourceUrl },
            freshness: { state: options.freshnessState ?? 'fresh', fetchedAtMs: 1 },
            diagnostics: [],
        }],
        diagnostics: [],
    };
}

function createCommunityInstallReviewResult(pendingChangeId: string, action: 'install' | 'update' = 'install') {
    return {
        action,
        pluginId: 'community-plugin',
        change: {
            kind: 'reviewRequired',
            pendingChangeId,
            review: {
                pluginId: 'community-plugin',
                displayName: 'Community Plugin',
                version: '2.0.0',
                packageIdentity: { name: '@acme/community-plugin', version: '2.0.0' },
                publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
                source: {
                    kind: 'npm',
                    locator: '@acme/community-plugin@2.0.0',
                    integrity: 'sha512-exact',
                },
                updateChannel: {
                    kind: 'npm',
                    packageName: '@acme/community-plugin',
                    registryOrigin: 'https://registry.npmjs.org',
                    marketplaceSource: {
                        id: 'marketplace:community-npm',
                        kind: 'community-npm',
                        sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100',
                    },
                },
                integrity: {
                    packageDigest: `sha256:${'a'.repeat(64)}`,
                    manifestDigest: `sha256:${'b'.repeat(64)}`,
                    uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
                },
                signature: { status: 'notProvided' },
                provenance: { status: 'notProvided' },
                curation: { status: 'unreviewed', sourceId: 'marketplace:community-npm' },
                executableRealms: ['daemon'],
                contributions: [{ family: 'actions', count: 1 }],
                uiArtifacts: { status: 'none', contributionIds: [] },
                requiredHostAccess: [{
                    id: 'network',
                    capability: 'network',
                    reason: 'Connect to the review service',
                    authorizationClass: 'cooperativeDisclosure',
                    normalizedScope: { targets: [{ kind: 'fixedOrigin', origin: 'https://review.example.test' }] },
                }],
                optionalHostAccess: [{
                    id: 'sessions',
                    capability: 'sessions',
                    reason: 'Read selected sessions',
                    authorizationClass: 'hostResourceSelection',
                    normalizedScope: { access: ['read'] },
                }],
                compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
                updatePolicy: 'manual',
            },
        },
    };
}

function flushAsync(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function selectPluginManagementView(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    view: 'installed' | 'discover' | 'development' | 'diagnostics',
): Promise<void> {
    await act(async () => {
        screen.pressByTestId(`settings.plugins.management.view:${view}`);
    });
}

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            Text: 'Text',
            TextInput: 'TextInput',
            Platform: {
                OS: 'web',
                select: (options: any) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: (value) => routerPushSpy(value),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
            navigation: {
                setOptions: (options: Readonly<Record<string, unknown>>) => navigationSetOptionsSpy(options),
            },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args) => modalAlertMock(...args),
                show: (...args) => modalShowMock(...args),
                confirm: (...args) => modalConfirmMock(...args),
                prompt: (...args) => modalPromptMock(...args),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => key === 'settingsPlugins.marketplaceInstallReviewBody'
                ? `${key}:${JSON.stringify(params)}`
                : key,
        });
    },
});

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => usePrimaryMachineFromActiveSelectionMock(),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => getActiveServerIdMock(),
    getActiveServerSnapshot: () => ({
        serverId: getActiveServerIdMock(),
        serverUrl: 'https://server.example.test',
        generation: 1,
    }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (...args: unknown[]) => useMachineCapabilitiesCacheMock(...args),
    getMachineCapabilitiesCacheState: (...args: unknown[]) => getMachineCapabilitiesCacheStateMock(...args),
    prefetchMachineCapabilities: (...args: unknown[]) => prefetchMachineCapabilitiesMock(...args),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/store/hooks')>()),
    useEndpointStatus: () => endpointConnectivityState.status,
    useMachineCliDetectionTarget: (...args: unknown[]) => useMachineCliDetectionTargetMock(...args),
}));

vi.mock('@/hooks/machine/useMachineCapabilityInvokeWithAlerts', () => ({
    useMachineCapabilityInvokeWithAlerts: () => ({
        isInvoking: false,
        invokeWithAlerts: invokeWithAlertsMock,
    }),
}));

vi.mock('@/sync/ops/machineMarketplaceSources', () => ({
    machineMarketplaceSourceRegistryGet: (...args: unknown[]) => machineMarketplaceSourceRegistryGetMock(...args),
    machineMarketplaceIndexQuery: (...args: unknown[]) => machineMarketplaceIndexQueryMock(...args),
    resolvePreferredMachineMarketplaceSource: (registry: MarketplaceSourceRegistryV1) =>
        registry.sources.find((entry) => entry.enabled && entry.origin === 'curated') ?? registry.sources.find((entry) => entry.enabled) ?? null,
}));

vi.mock('@/sync/ops/machineNpmRegistryProfiles', () => ({
    machineNpmRegistryProfilesGet: (...args: unknown[]) => machineNpmRegistryProfilesGetMock(...args),
    machineNpmRegistryProfilesMutate: (...args: unknown[]) => machineNpmRegistryProfilesMutateMock(...args),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => machineContributionRegistryProjectionDescribeMock(...args),
    publishMachineContributionRegistryProjectionInvalidation: (...args: unknown[]) =>
        publishMachineContributionRegistryProjectionInvalidationMock(...args),
    machinePluginStructuredMessageActionExecute: (...args: unknown[]) =>
        machinePluginStructuredMessageActionExecuteMock(...args),
    machinePluginSettingsGet: async (
        machineId: string,
        opts: { serverId?: string | null; pluginId: string },
    ) => ({
        supported: true,
        snapshot: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.settings.get',
            payload: {
                machineId,
                pluginId: opts.pluginId,
            },
        }),
    }),
    machinePluginSettingsSet: async (
        machineId: string,
        opts: { serverId?: string | null; pluginId: string; fieldId: string; value: unknown },
    ) => ({
        supported: true,
        snapshot: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.settings.set',
            payload: {
                machineId,
                pluginId: opts.pluginId,
                fieldId: opts.fieldId,
                value: opts.value,
            },
        }),
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: (agentId: string) => ({
        displayNameKey: `agents.${agentId}.name`,
        uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.claude', connectRoute: null },
        ui: { agentPickerIconName: 'terminal-outline' },
    }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    isAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => createPassThroughModule(['ItemRowActions']));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    const base = {
        AGENT_IDS: ['claude', 'codex'],
        CANONICAL_AGENT_IDS: ['claude', 'codex'],
        DEFAULT_AGENT_ID: 'claude',
        getAgentCore: (agentId: string) => ({
            connectedServices: null,
            ui: { agentPickerIconName: 'terminal-outline' },
            displayNameKey: `agents.${agentId}.name`,
        }),
        getAgentLocalCliConfig: () => ({
            detectKey: 'codex',
            machineLoginKey: 'codex',
        }),
        getAllAgentCatalogDefinitions: () => [],
        getAgentCliRuntimeSpec: () => ({ binaryName: null }),
        getProviderCliInstallGuideUrl: () => null,
        isAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
        legacyCustomAcpCompat: {
            LEGACY_COMPAT_AGENT_IDS: ['customAcp'],
            getLegacyCustomAcpAgentLocalCliConfig: () => ({
                detectKey: 'customAcp',
                machineLoginKey: 'customAcp',
            }),
        },
    };

    return {
        ...actual,
        ...base,
    };
});

afterEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    usePrimaryMachineFromActiveSelectionMock.mockReset();
    getActiveServerIdMock.mockReset();
    useMachineCapabilitiesCacheMock.mockReset();
    getMachineCapabilitiesCacheStateMock.mockReset();
    useMachineCliDetectionTargetMock.mockReset();
    endpointConnectivityState.status = 'online';
    invokeWithAlertsMock.mockReset();
    refreshMachineCapabilitiesMock.mockReset();
    machineMarketplaceSourceRegistryGetMock.mockReset();
    machineMarketplaceIndexQueryMock.mockReset();
    machineNpmRegistryProfilesGetMock.mockReset();
    machineNpmRegistryProfilesMutateMock.mockReset();
    machineContributionRegistryProjectionDescribeMock.mockReset();
    machinePluginStructuredMessageActionExecuteMock.mockReset();
    publishMachineContributionRegistryProjectionInvalidationMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    routerPushSpy.mockReset();
    navigationSetOptionsSpy.mockReset();
    modalAlertMock.mockReset();
    modalShowMock.mockReset();
    modalPromptMock.mockReset();
    modalConfirmMock.mockReset();
    prefetchMachineCapabilitiesMock.mockReset();
    vi.unstubAllGlobals();
});

beforeEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-1');
    useMachineCliDetectionTargetMock.mockReturnValue({ daemonStateVersion: 1, isOnline: true });
    getMachineCapabilitiesCacheStateMock.mockImplementation(() => {
        const latestResult = useMachineCapabilitiesCacheMock.mock.results.at(-1)?.value as
            | Readonly<{ state?: MachineCapabilitiesState }>
            | undefined;
        return latestResult?.state ?? null;
    });
    getActiveServerIdMock.mockReturnValue('server-a');
    machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
        supported: true,
        projection: { v: 1, providersById: {}, backendsById: {} },
    });
    machineMarketplaceIndexQueryMock.mockResolvedValue({ revision: 1, items: [], nextCursor: null, sources: [], diagnostics: [] });
    machineNpmRegistryProfilesGetMock.mockResolvedValue({
        status: 'success',
        snapshot: {
            protocolVersion: 1,
            revision: 1,
            profiles: [],
            pausedSources: [],
        },
    });
    machineNpmRegistryProfilesMutateMock.mockResolvedValue({
        status: 'success',
        snapshot: {
            protocolVersion: 1,
            revision: 1,
            profiles: [],
            pausedSources: [],
        },
    });
    machinePluginStructuredMessageActionExecuteMock.mockResolvedValue({
        supported: true,
        result: { ok: true, result: null },
    });
    modalPromptMock.mockResolvedValue(null);
    modalConfirmMock.mockResolvedValue(true);
    modalShowMock.mockImplementation((config: Readonly<{
        chrome?: Readonly<{ testID?: string }>;
        props?: Readonly<{
            optionalHostAccess?: readonly Readonly<{ id: string }>[];
            onResolve?: (result: Readonly<{
                approved: boolean;
                optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
            }>) => void;
        }>;
    }>) => {
        if (config.chrome?.testID === 'settings.plugins.installReview') {
            config.props?.onResolve?.({
                approved: true,
                optionalSelections: (config.props.optionalHostAccess ?? []).map((entry) => ({
                    accessId: entry.id,
                    selected: false,
                })),
            });
        }
        return 'plugin-install-review-modal';
    });
    prefetchMachineCapabilitiesMock.mockResolvedValue(undefined);
});

describe('PluginSettingsHomeScreen', () => {
    it('defaults to Installed and keeps every plugin-management view reachable through accessible selectors', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [createPluginDiagnosticRecord({
                    id: 'installed-plugin:normalization:capability-missing:0',
                    pluginId: 'installed-plugin',
                    severity: 'warning',
                    code: 'plugin_runtime_capability_missing',
                    message: 'Missing actions capability',
                })],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const installedSelector = screen.findByTestId('settings.plugins.management.view:installed');
        const discoverSelector = screen.findByTestId('settings.plugins.management.view:discover');
        const developmentSelector = screen.findByTestId('settings.plugins.management.view:development');
        const diagnosticsSelector = screen.findByTestId('settings.plugins.management.view:diagnostics');

        expect(installedSelector?.props.accessibilityRole).toBe('tab');
        expect(installedSelector?.props.accessibilityState).toEqual({ selected: true });
        expect(discoverSelector?.props.accessibilityState).toEqual({ selected: false });
        expect(developmentSelector?.props.accessibilityState).toEqual({ selected: false });
        expect(diagnosticsSelector).toBeTruthy();
        expect(diagnosticsSelector?.props.accessibilityState).toEqual({ selected: false });
        expect(screen.findByTestId('settings.plugins.management.viewScroller')?.props.horizontal).toBe(true);
        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeFalsy();
        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeFalsy();

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.accessibilityLabel).toBe('settingsPlugins.catalogUrlLabel');
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ minHeight: 44 }),
            ]),
        );
        expect(screen.findRow('settings.plugins.registries.add')).toBeTruthy();
        await act(async () => {
            screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:development');
        });
        expect(screen.findByTestId('settings.plugins.management.view:development')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.value).toBe('https://marketplace.example.test/catalog.json');

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:diagnostics');
        });
        expect(screen.findByTestId('settings.plugins.management.view:diagnostics')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeFalsy();
        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0.code')?.props.selectable).toBe(true);
        expect(screen.findByTestId('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0.message')?.props.selectable).toBe(true);
        expect(screen.findByTestId('settings.plugins.management.diagnostics.live')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findByTestId('settings.plugins.management.view:activity')).toBeFalsy();
    }, 120_000);

    it('announces marketplace loading and query failures to assistive technology', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:curated',
                title: 'Curated Marketplace',
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                enabled: true,
                origin: 'curated',
                addedAtMs: 1,
                updatedAtMs: 1,
            }],
        });
        let rejectCatalogQuery!: (error: Error) => void;
        machineMarketplaceIndexQueryMock.mockImplementation(() => new Promise((_, reject) => {
            rejectCatalogQuery = reject;
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');

        act(() => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
        });
        await act(async () => {
            await flushAsync();
        });

        const loadingStatus = screen.findByTestId('settings.plugins.marketplace.catalog.loading.status');
        expect(loadingStatus).toBeTruthy();
        expect(loadingStatus?.props.accessibilityLiveRegion).toBe('polite');
        expect(loadingStatus?.props.accessibilityLabel).toBe('common.loading');

        rejectCatalogQuery(new Error('Marketplace query failed'));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        const errorAlert = screen.findByTestId('settings.plugins.marketplace.catalog.error');
        expect(errorAlert).toBeTruthy();
        expect(errorAlert?.props.accessibilityRole).toBe('alert');
        expect(errorAlert?.props.accessibilityLiveRegion).toBe('assertive');
        expect(errorAlert?.props.accessibilityLabel).toBe('common.error: Marketplace query failed');
    });

    it('uses daemon-projected development diagnostics and exposes only source-scoped safe author actions', async () => {
        const ordinaryPathPlugin = createInstalledPlugin({
            pluginId: 'ordinary-path-plugin',
            title: 'Ordinary Path Plugin',
            version: '1.0.0',
            source: {
                kind: 'path',
                locator: '/plugins/ordinary-path-plugin',
            },
        });
        const archivePlugin = createInstalledPlugin({
            pluginId: 'archive-plugin',
            title: 'Archive Plugin',
            version: '2.0.0',
            source: {
                kind: 'archive',
                locator: '/plugins/archive-plugin.tgz',
                devWatch: true,
            },
        });
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '3.0.0-dev',
            source: {
                kind: 'path',
                locator: '/plugins/development-plugin',
                devWatch: true,
            },
            compatibility: {
                status: 'incompatible',
                diagnostics: [],
            },
            diagnostics: [],
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([
                ordinaryPathPlugin,
                archivePlugin,
                developmentPlugin,
            ], [{
                pluginId: 'development-plugin',
                sourceRootPath: '/plugins/development-plugin',
                watch: { state: 'configured' },
                reload: {
                    state: 'attention',
                    diagnostics: [{
                        code: 'plugin_development_watch_warning',
                        message: 'Development watch diagnostic',
                    }],
                },
                actions: { test: true, pack: true },
            }]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { action: 'test', pluginId: 'development-plugin' } },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'development');

        const developmentRow = screen.findRow('settings.plugins.management.development.development-plugin');
        expect(developmentRow).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.management.development.development-plugin.details')?.props.selectable).toBe(true);
        expect(screen.getTextContent()).toContain('Development Plugin');
        expect(screen.getTextContent()).toContain('3.0.0-dev');
        expect(screen.getTextContent()).toContain('development-plugin');
        expect(screen.getTextContent()).toContain('/plugins/development-plugin');
        expect(screen.getTextContent()).toContain('incompatible');
        expect(screen.getTextContent()).toContain('Development watch diagnostic');
        expect(developmentRow?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('settingsPlugins.developmentWatchConfigured');
        expect(screen.getTextContent()).toContain('settingsPlugins.developmentReloadAttention');

        expect(screen.findRow('settings.plugins.management.development.ordinary-path-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.archive-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.reload')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.test')?.props.disabled).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.pack')?.props.disabled).toBeFalsy();

        modalPromptMock
            .mockResolvedValueOnce('/workspace/plugins/new-plugin')
            .mockResolvedValueOnce('New Plugin')
            .mockResolvedValueOnce('acme.new-plugin');
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        expect(modalConfirmMock).toHaveBeenCalled();
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'create',
                params: {
                    targetDir: '/workspace/plugins/new-plugin',
                    displayName: 'New Plugin',
                    pluginId: 'acme.new-plugin',
                },
            },
        }));

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.development-plugin.action.test');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'test',
                params: { pluginId: 'development-plugin' },
            },
        }));
    });

    it('keeps cached development actions visible but disabled and non-mutating while daemon truth is stale', async () => {
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '1.0.0-dev',
            source: { kind: 'path', locator: '/plugins/development-plugin', devWatch: true },
        });
        const errorState = createMachineCapabilitiesState([developmentPlugin], [{
            pluginId: 'development-plugin',
            sourceRootPath: '/plugins/development-plugin',
            watch: { state: 'configured' },
            reload: { state: 'clear', diagnostics: [] },
            actions: { test: true, pack: true },
        }]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { ...errorState, status: 'error' },
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'development');

        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.test')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.pack')?.props.disabled).toBe(true);

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.development-plugin.action.pack');
            await flushAsync();
        });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('keeps the last approved development-source snapshot visible when disconnect removes the active capability snapshot', async () => {
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '1.0.0-dev',
            source: { kind: 'path', locator: '/plugins/development-plugin', devWatch: true },
        });
        let machineTarget = { daemonStateVersion: 7, isOnline: true };
        let capabilityState: MachineCapabilitiesState = createMachineCapabilitiesState([developmentPlugin], [{
            pluginId: 'development-plugin',
            sourceRootPath: '/plugins/development-plugin',
            watch: { state: 'configured' },
            reload: { state: 'clear', diagnostics: [] },
            actions: { test: true, pack: true },
        }]);
        useMachineCliDetectionTargetMock.mockImplementation(() => machineTarget);
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({
            state: capabilityState,
            refresh: vi.fn(),
        }));
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            capabilityRevision: number;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            capabilityRevision: 1,
        }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'development');

        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();

        endpointConnectivityState.status = 'offline';
        capabilityState = { status: 'idle' };
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 2,
            }));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.test')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.pack')?.props.disabled).toBe(true);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('keeps a loaded cached plugin snapshot read-only until same-version reconnect refreshes capabilities and projection', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
        });
        const curatedMarketplaceRegistry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:curated',
                title: 'Curated Marketplace',
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                enabled: true,
                origin: 'curated',
                addedAtMs: 1,
                updatedAtMs: 1,
            }],
        };
        const loadedCapabilitiesState = createMachineCapabilitiesState([installedPlugin]);
        const loadingCapabilitiesState = createMachineCapabilitiesLoadingState([installedPlugin]);
        let machineTarget = { daemonStateVersion: 7, isOnline: true };
        useMachineCliDetectionTargetMock.mockImplementation(() => machineTarget);
        const refresh = vi.fn();
        let initialCapabilityCacheKeySalt: unknown;
        let hasInitialCapabilityCacheKeySalt = false;
        let freshCapabilitiesReady = false;
        useMachineCapabilitiesCacheMock.mockImplementation((params: Readonly<{ cacheKeySalt?: unknown }>) => {
            if (!hasInitialCapabilityCacheKeySalt) {
                initialCapabilityCacheKeySalt = params.cacheKeySalt;
                hasInitialCapabilityCacheKeySalt = true;
            }
            const usesInitialCache = Object.is(params.cacheKeySalt, initialCapabilityCacheKeySalt);
            return {
                state: usesInitialCache || freshCapabilitiesReady
                    ? loadedCapabilitiesState
                    : loadingCapabilitiesState,
                refresh,
            };
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(curatedMarketplaceRegistry);
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({
                pluginId: installedPlugin.pluginId,
                title: installedPlugin.title,
                version: '2.0.0',
            }),
        ]));
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });
        let projectionRequestCount = 0;
        let resolveReconnectProjection: (() => void) | null = null;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async () => {
            projectionRequestCount += 1;
            if (projectionRequestCount === 2) {
                await new Promise<void>((resolve) => {
                    resolveReconnectProjection = resolve;
                });
            }
            return {
                supported: true,
                projection: { v: 1, providersById: {}, backendsById: {} },
            };
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            capabilityRevision: number;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            capabilityRevision: 1,
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
        const staleOnlineDisable = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions
            ?.find((action: Readonly<{ id: string }>) => action.id === 'disable')
            ?.onPress as (() => void);

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.action.update.installed-plugin')?.props.disabled).not.toBe(true);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:installed');
        });

        machineMarketplaceSourceRegistryGetMock.mockClear();
        machineMarketplaceIndexQueryMock.mockClear();
        endpointConnectivityState.status = 'offline';
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 2,
            }));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        const readOnlySnapshot = screen.findRow('settings.plugins.marketplace.readOnlySnapshot');
        expect(readOnlySnapshot?.props.accessibilityLiveRegion).toBe('polite');
        expect(readOnlySnapshot?.props.accessibilityLabel).toBe('settingsPlugins.readOnlySnapshot');
        expect(screen.findByTestId('settings.plugins.management.view:installed')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')).toBeFalsy();

        const disconnectedActions = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions as readonly Readonly<{ id: string; disabled: boolean; onPress: () => void }>[] | undefined;
        expect(disconnectedActions?.find((action) => action.id === 'reload')).toBeUndefined();
        expect(disconnectedActions?.find((action) => action.id === 'disable')?.disabled).toBe(true);

        await act(async () => {
            disconnectedActions?.find((action) => action.id === 'disable')?.onPress();
            staleOnlineDisable();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(machineMarketplaceIndexQueryMock).not.toHaveBeenCalled();
        expect(machineMarketplaceSourceRegistryGetMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const detailScreen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        const detailReadOnlySnapshot = detailScreen.findRow('settings.plugins.detail.readOnlySnapshot');
        expect(detailReadOnlySnapshot?.props.accessibilityLiveRegion).toBe('polite');
        expect(detailReadOnlySnapshot?.props.accessibilityLabel).toBe('settingsPlugins.readOnlySnapshot');
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.reload')).toBeFalsy();
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.disable')?.props.disabled).toBe(true);
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.rollback')?.props.disabled).toBe(true);
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.uninstall')?.props.disabled).toBe(true);
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.forgetTrust')?.props.disabled).toBe(true);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.editable).toBe(false);
        expect(screen.findRow('settings.plugins.marketplace.action.update.installed-plugin')?.props.disabled).toBe(true);
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.onChangeText).toBeUndefined();
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.onSubmitEditing).toBeUndefined();

        endpointConnectivityState.status = 'online';
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 3,
            }));
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')?.props.disabled).toBe(true);
        const reconnectCapabilityCacheKeySalt = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0]?.cacheKeySalt;
        expect(reconnectCapabilityCacheKeySalt).not.toBe(initialCapabilityCacheKeySalt);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);

        freshCapabilitiesReady = true;
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 4,
            }));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')?.props.disabled).toBe(true);

        await act(async () => {
            resolveReconnectProjection?.();
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')?.props.disabled).toBe(false);
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.editable).toBe(true);
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.onChangeText).toBeTypeOf('function');
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.onSubmitEditing).toBeTypeOf('function');
        expect(screen.findRow('settings.plugins.marketplace.action.update.installed-plugin')?.props.disabled).toBe(true);
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });
        expect(screen.findRow('settings.plugins.marketplace.action.update.installed-plugin')?.props.disabled).not.toBe(true);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:installed');
        });
        const reconnectedActions = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions as readonly Readonly<{ id: string; disabled: boolean }>[] | undefined;
        expect(reconnectedActions?.find((action) => action.id === 'reload')).toBeUndefined();
        expect(reconnectedActions?.find((action) => action.id === 'disable')?.disabled).toBe(false);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            timeoutMs: 10_000,
        });
    });

    it('navigates installed plugin rows to a detail route instead of inlining plugin details on the home screen', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.status')).toBeFalsy();

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.installed.installed-plugin');
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]',
            params: { pluginId: 'installed-plugin' },
        });
    });

    it('renders host-projected plugin details, diagnostics, and only supported mutation actions', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
            diagnostics: [{ code: 'install.note', message: 'Installed via host-owned flow' }],
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {
                    'installed-plugin.refresh': {
                        id: 'installed-plugin.refresh',
                        pluginId: 'installed-plugin',
                        title: 'Refresh installed plugin',
                        description: 'Refresh plugin-owned resources',
                        scopes: ['settings'],
                        surfaces: ['settings'],
                        placement: 'detailsPanel',
                        dangerLevel: 'safe',
                        available: true,
                    },
                    'installed-plugin.runSetup': {
                        id: 'installed-plugin.runSetup',
                        pluginId: 'installed-plugin',
                        title: 'Run setup',
                        description: 'Run plugin setup',
                        scopes: ['settings'],
                        surfaces: ['settings'],
                        placement: 'detailsPanel',
                        dangerLevel: 'safe',
                        available: true,
                    },
                },
                toolsById: {},
                commandsById: {},
                resourcesById: {
                    'installed-plugin.prompt': {
                        id: 'installed-plugin.prompt',
                        pluginId: 'installed-plugin',
                        resourceKind: 'prompt',
                        path: 'resources/review.md',
                        digest: 'sha256:prompt',
                        contentType: 'text/markdown',
                    },
                },
                diagnostics: [
                    createPluginDiagnosticRecord({
                        id: 'installed-plugin:normalization:warning:0',
                        pluginId: 'installed-plugin',
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    }),
                    createPluginDiagnosticRecord({
                        id: 'installed-plugin:activation:info:0',
                        pluginId: 'installed-plugin',
                        severity: 'info',
                        code: 'plugin.activated',
                        message: 'Plugin activated',
                    }),
                ],
            },
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(navigationSetOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({
            headerTitle: 'Installed Plugin',
        }));
        expect(screen.findRow('settings.plugins.detail.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('trusted');
        expect(screen.findRow('settings.plugins.detail.installed-plugin.contribution.action.installed-plugin.refresh')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.contribution.resource.installed-plugin.prompt')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.reload')).toBeFalsy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.disable')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.rollback')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.uninstall')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.forgetTrust')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Plugin activated');
        expect(screen.getTextContent()).toContain('Registry rebuilt with warnings');
        await act(async () => {
            screen.pressRow('settings.plugins.detail.installed-plugin.action.disable');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'disable',
                params: expect.objectContaining({ pluginId: 'installed-plugin' }),
            }),
        }));
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
        expect(publishMachineContributionRegistryProjectionInvalidationMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['missing', undefined],
        ['unavailable', 'unavailable' as const],
    ])('does not advertise rollback when host-private byte verification is %s', async (_label, rollbackAvailability) => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            rollbackAvailability,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.rollback`)).toBeFalsy();
        expect(screen.findRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`)).toBeTruthy();
        expect(screen.findRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.forgetTrust`)).toBeTruthy();
    });

    it('rejects a stale rollback control after the daemon withdraws byte-verified availability', async () => {
        let rollbackAvailability: InstalledPluginEntry['rollbackAvailability'] = 'available';
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({
            state: createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'installed-plugin',
                    title: 'Installed Plugin',
                    version: '1.0.0',
                    rollbackAvailability,
                }),
            ]),
            refresh: vi.fn(),
        }));

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            capabilityRevision: number;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: 'installed-plugin',
            capabilityRevision: 1,
        }));
        await act(async () => {
            await flushAsync();
        });
        const staleRollbackPress = screen.findRow(
            'settings.plugins.detail.installed-plugin.action.rollback',
        )?.props.onPress as (() => void) | undefined;
        expect(staleRollbackPress).toBeTypeOf('function');

        rollbackAvailability = 'unavailable';
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: 'installed-plugin',
                capabilityRevision: 2,
            }));
            await flushAsync();
        });
        expect(screen.findRow('settings.plugins.detail.installed-plugin.action.rollback')).toBeFalsy();

        await act(async () => {
            staleRollbackPress?.();
            await flushAsync();
        });
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it.each([
        ['rollback', 'settingsPlugins.rollback'],
        ['uninstall', 'settingsPlugins.uninstall'],
        ['forgetTrust', 'settingsPlugins.forgetTrust'],
    ] as const)('confirms the destructive %s action and invokes only the private plugin capability', async (method, confirmationTitle) => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            rollbackAvailability: method === 'rollback' ? 'available' : 'unavailable',
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: method,
                    pluginId: installedPlugin.pluginId,
                    change: { kind: 'committed' },
                },
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        modalConfirmMock.mockResolvedValueOnce(false);
        await act(async () => {
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.${method}`);
            await flushAsync();
        });
        expect(modalConfirmMock).toHaveBeenCalledWith(
            confirmationTitle,
            'settingsPlugins.pluginChangeConfirmBody',
            expect.objectContaining({
                confirmText: confirmationTitle,
                cancelText: 'common.cancel',
            }),
        );
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();

        modalConfirmMock.mockResolvedValueOnce(true);
        await act(async () => {
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.${method}`);
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method,
                params: { pluginId: installedPlugin.pluginId },
            },
        }));
    });

    it('does not refresh plugin truth after a destructive lifecycle capability failure', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: false,
                error: {
                    code: 'plugin-not-found',
                    message: 'Installed plugin was not found',
                },
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'uninstall',
                params: { pluginId: installedPlugin.pluginId },
            },
        }));
        expect(refresh).not.toHaveBeenCalled();
        expect(publishMachineContributionRegistryProjectionInvalidationMock).not.toHaveBeenCalled();
    });

    it.each([
        ['rollback', (entry: InstalledPluginEntry) => [{ ...entry, version: '0.9.0' }]],
        ['uninstall', () => []],
        ['forgetTrust', (entry: InstalledPluginEntry) => [{
            ...entry,
            enabled: false,
            source: { ...entry.source, trustPolicy: 'untrusted' },
        }]],
    ] as const)(
        'reconciles an outcome-unknown %s from authoritative installed truth without replaying the mutation',
        async (method, createInstalledAfter) => {
            const installedPlugin = createInstalledPlugin({
                pluginId: 'installed-plugin',
                title: 'Installed Plugin',
                version: '1.0.0',
                rollbackAvailability: method === 'rollback' ? 'available' : 'unavailable',
            });
            const initialState = createMachineCapabilitiesState([installedPlugin]);
            let authoritativeState: MachineCapabilitiesState = initialState;
            useMachineCapabilitiesCacheMock.mockReturnValue({
                state: initialState,
                refresh: vi.fn(),
            });
            getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
            prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
                authoritativeState = createMachineCapabilitiesState(createInstalledAfter(installedPlugin));
            });
            invokeWithAlertsMock.mockResolvedValueOnce({
                supported: true,
                response: {
                    ok: false,
                    error: {
                        code: 'outcomeUnknown',
                        message: 'The daemon may have committed the requested mutation',
                    },
                },
            });

            const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
            const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
            }));
            await act(async () => {
                await flushAsync();
                screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.${method}`);
                await flushAsync();
                await flushAsync();
            });

            expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
            expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
                machineId: 'machine-1',
                serverId: 'server-a',
                request: expect.objectContaining({
                    bypassCache: true,
                    requests: [{ id: MARKETPLACE_CAPABILITY_ID }],
                }),
            }));
            expect(publishMachineContributionRegistryProjectionInvalidationMock).toHaveBeenCalledWith({
                machineId: 'machine-1',
                serverId: 'server-a',
            });
            expect(modalAlertMock).toHaveBeenCalledWith('common.success', 'common.done');
        },
    );

    it('reconciles commit-intended transport loss from authoritative truth without retrying uninstall', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
        });
        const initialState = createMachineCapabilitiesState([installedPlugin]);
        let authoritativeState: MachineCapabilitiesState = initialState;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: initialState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = createMachineCapabilitiesState([]);
        });
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: false, reason: 'error' });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).toHaveBeenCalledWith('common.success', 'common.done');
    });

    it('does not interpret a missing authoritative snapshot as a committed uninstall', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
        });
        const initialState = createMachineCapabilitiesState([installedPlugin]);
        let authoritativeState: MachineCapabilitiesState = initialState;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: initialState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = { status: 'not-supported' };
        });
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: false,
                error: {
                    code: 'outcomeUnknown',
                    message: 'The daemon may have committed the requested mutation',
                },
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
            await flushAsync();
        });

        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', 'common.done');
        expect(modalAlertMock).toHaveBeenCalledWith(
            'common.error',
            'settingsPlugins.marketplaceChangeDecisionFailed',
        );
        expect(publishMachineContributionRegistryProjectionInvalidationMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
        });
    });

    it('does not apply an ambiguous mutation reconciliation after the machine authority changes', async () => {
        const refreshStarted = createDeferred();
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
        });
        let machineOneState: MachineCapabilitiesState = createMachineCapabilitiesState([installedPlugin]);
        const machineTwoState = createMachineCapabilitiesState([installedPlugin]);
        useMachineCapabilitiesCacheMock.mockImplementation(({ machineId }: Readonly<{ machineId: string | null }>) => ({
            state: machineId === 'machine-1' ? machineOneState : machineTwoState,
            refresh: vi.fn(),
        }));
        getMachineCapabilitiesCacheStateMock.mockImplementation((machineId: string) => (
            machineId === 'machine-1' ? machineOneState : machineTwoState
        ));
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            await refreshStarted.promise;
            machineOneState = createMachineCapabilitiesState([]);
        });
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: false,
                error: {
                    code: 'outcomeUnknown',
                    message: 'The daemon may have committed the requested mutation',
                },
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
            scopeToken: 'machine-1',
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
        });
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledTimes(1);

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-2');
        getActiveServerIdMock.mockReturnValue('server-b');
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
                scopeToken: 'machine-2',
            }));
            await flushAsync();
        });

        refreshStarted.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', 'common.done');
        expect(publishMachineContributionRegistryProjectionInvalidationMock).not.toHaveBeenCalled();
    });

    it('renders and edits hooks-only generic plugin settings from settingsById without leaking redacted values', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'acme.hooks',
            title: 'Acme hooks',
            version: '1.0.0',
            enabled: true,
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 21,
                installedPackagesById: {
                    'acme.hooks': {
                        id: 'acme.hooks',
                        displayName: 'Acme hooks',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/acme.hooks',
                        },
                        digest: 'sha256:hooks',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {
                    'acme.hooks.settings': {
                        id: 'acme.hooks.settings',
                        pluginId: 'acme.hooks',
                        storageScope: 'local',
                        target: { kind: 'plugin' },
                        presentation: { sections: [], subagentSections: [] },
                        fields: [
                            {
                                id: 'endpoint',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'string' },
                                control: 'text',
                                displayKey: 'Endpoint URL',
                                descriptionKey: 'Used when hook handlers call the remote API.',
                                capabilityGates: [],
                                permissionGates: [],
                                redaction: 'none',
                                clearWhenEmpty: 'persist',
                                order: 1,
                            },
                            {
                                id: 'apiToken',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'string' },
                                control: 'password',
                                displayKey: 'API token',
                                descriptionKey: 'Stored locally for this plugin.',
                                capabilityGates: [],
                                permissionGates: [],
                                redaction: 'secret',
                                clearWhenEmpty: 'omit',
                                order: 2,
                            },
                            {
                                id: 'enabled',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'boolean' },
                                control: 'switch',
                                displayKey: 'Enable hooks',
                                capabilityGates: [],
                                permissionGates: [],
                                redaction: 'none',
                                clearWhenEmpty: 'persist',
                                defaultBooleanValue: true,
                                order: 3,
                            },
                            {
                                id: 'notes',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'string' },
                                control: 'textarea',
                                displayKey: 'Notes',
                                capabilityGates: [],
                                permissionGates: [],
                                redaction: 'none',
                                clearWhenEmpty: 'persist',
                                order: 4,
                            },
                        ],
                    },
                },
                diagnostics: [
                    createPluginDiagnosticRecord({
                        id: 'acme.hooks:normalization:settings-field-duplicate:0',
                        pluginId: 'acme.hooks',
                        severity: 'error',
                        code: 'settings_field_duplicate',
                        message: 'Duplicate settings field rejected for acme.hooks.',
                    }),
                ],
            },
        });

        let currentValues: Record<string, unknown> = {
            endpoint: 'https://api.example.test',
            apiToken: 'raw-secret-token',
            enabled: true,
            notes: 'Persisted note',
        };
        machineRpcWithServerScopeMock.mockImplementation(async (input: { method?: string; payload?: Record<string, unknown> }) => {
            if (input.method === 'daemon.plugins.settings.get') {
                return {
                    protocolVersion: 1,
                    pluginId: 'acme.hooks',
                    storageScope: 'local',
                    revision: '0',
                    values: currentValues,
                    redactedKeys: ['apiToken'],
                };
            }
            if (input.method === 'daemon.plugins.settings.set') {
                currentValues = {
                    ...currentValues,
                    [String(input.payload?.fieldId)]: input.payload?.value,
                };
                return {
                    protocolVersion: 1,
                    pluginId: 'acme.hooks',
                    storageScope: 'local',
                    revision: '1',
                    values: currentValues,
                    redactedKeys: ['apiToken'],
                };
            }
            throw new Error(`Unexpected RPC method: ${input.method ?? '<missing>'}`);
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'acme.hooks' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.endpoint.input')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.apiToken.input')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.enabled')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.notes.input')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Duplicate settings field rejected for acme.hooks.');
        expect(screen.getTextContent()).not.toContain('raw-secret-token');

        const endpointInput = screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.endpoint.input');
        const tokenInput = screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.apiToken.input');
        const notesInput = screen.findRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.notes.input');
        expect(endpointInput?.props.value).toBe('https://api.example.test');
        expect(tokenInput?.props.value).toBe('');
        expect(tokenInput?.props.secureTextEntry).toBe(true);
        expect(notesInput?.props.multiline).toBe(true);
        expect(notesInput?.props.value).toBe('Persisted note');

        await act(async () => {
            endpointInput?.props.onChangeText('https://api.changed.test');
            await flushAsync();
        });
        expect(machineRpcWithServerScopeMock.mock.calls
            .map(([input]) => input as { method?: string })
            .filter((input) => input.method === 'daemon.plugins.settings.set')).toHaveLength(0);
        await act(async () => {
            screen.pressRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.endpoint.save');
            await flushAsync();
        });
        await act(async () => {
            screen.pressRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.enabled');
            await flushAsync();
        });
        await act(async () => {
            tokenInput?.props.onChangeText('new-secret-token');
            await flushAsync();
        });
        expect(machineRpcWithServerScopeMock.mock.calls
            .map(([input]) => input as { method?: string })
            .filter((input) => input.method === 'daemon.plugins.settings.set')).toHaveLength(2);
        await act(async () => {
            screen.pressRow('settings.plugins.detail.acme.hooks.settings.acme.hooks.settings.apiToken.save');
            await flushAsync();
        });

        const setCalls = machineRpcWithServerScopeMock.mock.calls
            .map(([input]) => input as { method?: string; payload?: Record<string, unknown> })
            .filter((input) => input.method === 'daemon.plugins.settings.set');
        expect(setCalls.map((call) => call.payload)).toEqual([
            {
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'endpoint',
                value: 'https://api.changed.test',
            },
            {
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'enabled',
                value: false,
            },
            {
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                fieldId: 'apiToken',
                value: 'new-secret-token',
            },
        ]);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('raw-secret-token');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('new-secret-token');
    });

    it('keeps projected plugin details visible on the detail screen while installed inventory refreshes', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: {
                status: 'loading',
                snapshot: createMachineCapabilitiesState([installedPlugin]).snapshot,
            },
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
    });

    it('reuses the shared daemon projection cache on the detail screen when the scoped projection is already warm', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'installed-plugin',
                    title: 'Installed Plugin',
                    version: '1.0.0',
                }),
            ]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 7,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-a',
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.summary')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
    });

    it('clears machine-scoped projection and preferred catalog state when the selected machine changes', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        const curatedMarketplaceRegistry = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'marketplace:curated-default',
                    title: 'Happier curated marketplace',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    enabled: true,
                    origin: 'curated' as const,
                    description: 'Official curated source',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
            ],
        };

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-1');
        getActiveServerIdMock.mockReturnValue('server-a');
        useMachineCapabilitiesCacheMock.mockImplementation(({ machineId }: { machineId: string | null }) => ({
            state: createMachineCapabilitiesState(machineId === 'machine-1' ? [installedPlugin] : [installedPlugin]),
            refresh: vi.fn(),
        }));
        machineMarketplaceSourceRegistryGetMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1' ? curatedMarketplaceRegistry : null
        ));
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1'
                ? {
                    supported: true,
                    projection: {
                        v: 2,
                        generation: 12,
                        installedPackagesById: {
                            'installed-plugin': {
                                id: 'installed-plugin',
                                displayName: 'Installed Plugin',
                                version: '1.0.0',
                                enabled: true,
                                source: {
                                    kind: 'path',
                                    locator: '/plugins/installed-plugin',
                                },
                                digest: 'sha256:manifest',
                            },
                        },
                        providersById: {},
                        backendsById: {},
                        actionsById: {},
                        toolsById: {},
                        commandsById: {},
                        resourcesById: {},
                        diagnostics: [
                            createPluginDiagnosticRecord({
                                id: 'installed-plugin:normalization:capability-missing:0',
                                pluginId: 'installed-plugin',
                                severity: 'warning',
                                code: 'plugin_runtime_capability_missing',
                                message: 'Missing actions capability',
                            }),
                        ],
                    },
                }
                : {
                    supported: false,
                }
        ));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        await selectPluginManagementView(screen, 'discover');

        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        expect(input?.props.value).toBe('https://marketplace.example.test/catalog.json');
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            timeoutMs: 10_000,
        });

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-2');
        getActiveServerIdMock.mockReturnValue('server-b');

        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-2',
            }));
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', {
            serverId: 'server-b',
            timeoutMs: 10_000,
        });
        expect(screen.findRow('settings.plugins.marketplace.catalogUrl')?.props.value).toBe('');
    });

    it('fences a late destructive lifecycle response from the previously selected machine authority', async () => {
        const machineOneAction = createDeferred();
        const machineTwoAction = createDeferred();
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockImplementation(async ({ machineId }: Readonly<{ machineId: string }>) => {
            await (machineId === 'machine-1' ? machineOneAction.promise : machineTwoAction.promise);
            return {
                supported: true,
                response: {
                    ok: true,
                    result: {
                        action: 'rollback',
                        pluginId: installedPlugin.pluginId,
                        change: { kind: 'committed' },
                    },
                },
            };
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const RerenderablePluginDetailScreen = PluginDetailScreen as unknown as React.ComponentType<{
            pluginId: string;
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
            scopeToken: 'machine-1',
        }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const findRollbackAction = () => screen.findRow(
            `settings.plugins.detail.${installedPlugin.pluginId}.action.rollback`,
        );

        await act(async () => {
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.rollback`);
            await flushAsync();
        });
        expect(findRollbackAction()?.props.disabled).toBe(true);

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue('machine-2');
        getActiveServerIdMock.mockReturnValue('server-b');
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
                scopeToken: 'machine-2',
            }));
            await flushAsync();
            await flushAsync();
        });

        expect(findRollbackAction()?.props.disabled).not.toBe(true);
        await act(async () => {
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.rollback`);
            await flushAsync();
        });
        expect(findRollbackAction()?.props.disabled).toBe(true);

        machineOneAction.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(findRollbackAction()?.props.disabled).toBe(true);

        machineTwoAction.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(findRollbackAction()?.props.disabled).not.toBe(true);
    });

    it('deduplicates repeated same-plugin mutations before the busy state rerenders', async () => {
        const action = createDeferred();
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockImplementation(async () => {
            await action.promise;
            return {
                supported: true,
                response: { ok: true, result: { ok: true } },
            };
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const findDisableAction = () => screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions
            ?.find((action: Readonly<{ id: string }>) => action.id === 'disable') as
            | Readonly<{ disabled: boolean; onPress: () => void }>
            | undefined;
        const actionBeforeBusyRender = findDisableAction();

        act(() => {
            actionBeforeBusyRender?.onPress();
            actionBeforeBusyRender?.onPress();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
        expect(findDisableAction()?.disabled).toBe(true);

        action.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(findDisableAction()?.disabled).toBe(false);
    });

    it('drops an in-flight projection response when the selected machine becomes unavailable', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        let resolveProjection!: (value: Readonly<{
            supported: true;
            projection: Readonly<{
                v: 2;
                generation: number;
                installedPackagesById: Readonly<Record<string, Readonly<{
                    id: string;
                    displayName: string;
                    version: string | null;
                    enabled: boolean | null;
                    source: Readonly<{
                        kind: string;
                        locator: string;
                    }>;
                    digest: string | null;
                }>>>;
                providersById: Record<string, never>;
                backendsById: Record<string, never>;
                actionsById: Record<string, never>;
                toolsById: Record<string, never>;
                commandsById: Record<string, never>;
                resourcesById: Record<string, never>;
                diagnostics: readonly [];
            }>;
        }>) => void;
        const projectionPromise = new Promise<Parameters<typeof resolveProjection>[0]>((resolve) => {
            resolveProjection = resolve;
        });
        machineContributionRegistryProjectionDescribeMock.mockImplementation(async (machineId: string) => {
            if (machineId === 'machine-1') {
                return await projectionPromise;
            }
            return { supported: false };
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            scopeToken: string;
        }>;
        const screen = await renderSettingsView(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.generation')).toBeFalsy();

        usePrimaryMachineFromActiveSelectionMock.mockReturnValue(null);
        await act(async () => {
            screen.tree.update(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-none',
            }));
            await flushAsync();
        });

        resolveProjection({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.generation')).toBeFalsy();
    });

    it('renders duplicate plugin diagnostic codes with stable unique rows', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [
                    createPluginDiagnosticRecord({
                        id: 'installed-plugin:normalization:capability-missing:0',
                        pluginId: 'installed-plugin',
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing actions capability',
                    }),
                    createPluginDiagnosticRecord({
                        id: 'installed-plugin:normalization:capability-missing:1',
                        pluginId: 'installed-plugin',
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing resources capability',
                    }),
                ],
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderSettingsView(React.createElement(PluginDetailScreen, {
            pluginId: 'installed-plugin',
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.diagnostic.plugin_runtime_capability_missing.0')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.diagnostic.plugin_runtime_capability_missing.1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Missing actions capability');
        expect(screen.getTextContent()).toContain('Missing resources capability');
    });

    it('loads curated descriptors from a catalog URL and preserves the machine-installed inventory', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: false,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/installed-plugin',
                resolvedDigest: 'sha256:installed',
            },
            compatibility: {
                status: 'incompatible',
                diagnostics: [{ code: 'compatibility', message: 'Requires a newer runtime' }],
            },
            diagnostics: [{ code: 'provenance', message: 'Installed via host-owned flow' }],
        });
        const curatedMarketplaceRegistry = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'marketplace:curated-default',
                    title: 'Happier curated marketplace',
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    enabled: true,
                    origin: 'curated' as const,
                    description: 'Official curated source',
                    addedAtMs: 1,
                    updatedAtMs: 1,
                },
            ],
        };

        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(curatedMarketplaceRegistry);
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'installed-plugin', title: 'Installed Plugin', description: 'Descriptor for the installed plugin', version: '1.1.0' }),
            createMarketplaceCatalogEntry({ pluginId: 'new-plugin', title: 'New Plugin', description: 'Descriptor for an uninstalled plugin', version: '0.1.0' }),
        ]));

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            expect(String(input)).toBe('https://marketplace.example.test/catalog.json');
            return {
                ok: true,
                json: async () => ({
                    t: 'happier_plugin_marketplace_catalog_v1',
                    schemaVersion: 1,
                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                    title: 'Curated Marketplace',
                    description: 'Curated plugin descriptors',
                    entries: [
                        createMarketplaceCatalogEntry({
                            pluginId: 'installed-plugin',
                            title: 'Installed Plugin',
                            description: 'Descriptor for the installed plugin',
                            version: '1.1.0',
                        }),
                        createMarketplaceCatalogEntry({
                            pluginId: 'new-plugin',
                            title: 'New Plugin',
                            description: 'Descriptor for an uninstalled plugin',
                            version: '0.1.0',
                        }),
                    ],
                }),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(useMachineCapabilitiesCacheMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            enabled: true,
            request: expect.objectContaining({
                requests: [{ id: MARKETPLACE_CAPABILITY_ID }],
            }),
        }));
        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));

        const installedRow = screen.findRow('settings.plugins.marketplace.installed.installed-plugin');
        expect(installedRow).toBeTruthy();
        expect(screen.getTextContent()).toContain('common.disabled');
        expect(screen.getTextContent()).toContain('Installed via host-owned flow');
        expect(screen.getTextContent()).toContain('catalog: https://marketplace.example.test/catalog.json');
        expect(screen.getTextContent()).toContain('incompatible');

        await selectPluginManagementView(screen, 'discover');
        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        expect(input?.props.value).toBe('https://marketplace.example.test/catalog.json');

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(screen.findGroup('Curated Marketplace')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.entry.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.entry.new-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.install.installed-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.action.enable.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.install.new-plugin')).toBeTruthy();
    });

    it('keeps daemon catalog truth visible when an unconfigured URL is entered', async () => {
        const firstCatalogUrl = 'https://marketplace.example.test/catalog-a.json';
        const secondCatalogUrl = 'https://marketplace.example.test/catalog-b.json';
        const secondCatalogGate = createDeferred();

        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:first', title: 'Curated Marketplace', sourceUrl: firstCatalogUrl, enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'sample-plugin', title: 'Sample Plugin', description: 'Descriptor for the first catalog', version: '1.0.0' }),
        ]));

        const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === firstCatalogUrl) {
                return {
                    ok: true,
                    json: async () => ({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: firstCatalogUrl,
                        title: 'Curated Marketplace',
                        description: 'First catalog',
                        entries: [
                            createMarketplaceCatalogEntry({
                                pluginId: 'sample-plugin',
                                title: 'Sample Plugin',
                                description: 'Descriptor for the first catalog',
                                version: '1.0.0',
                                sourceUrl: `${firstCatalogUrl}#sample-plugin`,
                                packageUrl: 'https://marketplace.example.test/plugins/sample-plugin.tgz',
                            }),
                        ],
                    }),
                } as Response;
            }

            if (url === secondCatalogUrl) {
                await secondCatalogGate.promise;
                return {
                    ok: true,
                    json: async () => ({
                        t: 'happier_plugin_marketplace_catalog_v1',
                        schemaVersion: 1,
                        sourceUrl: secondCatalogUrl,
                        title: 'Curated Marketplace Refreshed',
                        description: 'Second catalog',
                        entries: [
                            createMarketplaceCatalogEntry({
                                pluginId: 'replacement-plugin',
                                title: 'Replacement Plugin',
                                description: 'Descriptor for the refreshed catalog',
                                version: '2.0.0',
                                sourceUrl: `${secondCatalogUrl}#replacement-plugin`,
                                packageUrl: 'https://marketplace.example.test/plugins/replacement-plugin.tgz',
                            }),
                        ],
                    }),
                } as Response;
            }

            throw new Error(`Unexpected marketplace catalog URL: ${url}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await selectPluginManagementView(screen, 'discover');
        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText(firstCatalogUrl);
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        const sampleEntry = screen.findRow('settings.plugins.marketplace.entry.sample-plugin');
        expect(sampleEntry).toBeTruthy();

        await act(async () => {
            input?.props.onChangeText(secondCatalogUrl);
        });

        expect(screen.findRow('settings.plugins.marketplace.loadCatalog')?.props.disabled).toBe(true);

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.sample-plugin')).toBeTruthy();
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(screen.findRow('settings.plugins.marketplace.entry.replacement-plugin')).toBeFalsy();
    });

    it('reconciles exact curated install truth after the private decision response is lost', async () => {
        const initialState = createMachineCapabilitiesState([]);
        let authoritativeState: MachineCapabilitiesState = initialState;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: initialState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'new-plugin',
                    title: 'New Plugin',
                    version: '0.1.0',
                }),
            ]);
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'install',
                    pluginId: 'new-plugin',
                    change: {
                        kind: 'reviewRequired',
                        pendingChangeId: 'pending-curated-1',
                        review: {
                            pluginId: 'new-plugin',
                            displayName: 'New Plugin',
                            version: '0.1.0',
                            packageIdentity: { name: '@acme/new-plugin', version: '0.1.0' },
                            publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
                            source: {
                                kind: 'npm',
                                locator: '@acme/new-plugin@0.1.0',
                                integrity: 'sha512-exact',
                            },
                            updateChannel: {
                                kind: 'npm',
                                packageName: '@acme/new-plugin',
                                registryOrigin: 'https://registry.npmjs.org',
                                marketplaceSource: {
                                    id: 'marketplace:curated',
                                    kind: 'curated',
                                    sourceUrl: 'https://marketplace.example.test/catalog.json',
                                },
                            },
                            integrity: {
                                packageDigest: `sha256:${'a'.repeat(64)}`,
                                manifestDigest: `sha256:${'b'.repeat(64)}`,
                                uiArtifactDigest: `sha256:${'c'.repeat(64)}`,
                            },
                            signature: { status: 'verified', keyId: 'registry-key-1' },
                            provenance: { status: 'notProvided' },
                            curation: {
                                status: 'approved',
                                sourceId: 'marketplace:curated',
                                reviewedAt: '2026-07-24T00:00:00.000Z',
                            },
                            executableRealms: ['daemon'],
                            contributions: [],
                            uiArtifacts: { status: 'none', contributionIds: [] },
                            requiredHostAccess: [],
                            optionalHostAccess: [],
                            compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
                            updatePolicy: 'automatic',
                        },
                    },
                },
            },
        });
        machineRpcWithServerScopeMock.mockRejectedValueOnce(new Error('Connection closed after commit'));
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'new-plugin', title: 'New Plugin', description: 'Descriptor for an uninstalled plugin', version: '0.1.0' }),
        ]));

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'new-plugin',
                        title: 'New Plugin',
                        description: 'Descriptor for an uninstalled plugin',
                        version: '0.1.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await selectPluginManagementView(screen, 'discover');
        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.new-plugin')).toBeTruthy();
        const installRow = screen.findRow('settings.plugins.marketplace.action.install.new-plugin');
        expect(installRow).toBeTruthy();

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.install.new-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: {
                    sourceId: 'marketplace:curated',
                    pluginId: 'new-plugin',
                },
            },
        }));
        expect(modalShowMock).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({
                title: 'settingsPlugins.marketplaceInstallReviewTitle',
            }),
            props: expect.objectContaining({
                body: expect.stringContaining('"identity":"Plugin: new-plugin\\nPackage: @acme/new-plugin 0.1.0'),
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-curated-1',
                decision: 'installAndTrust',
                actorEvidence: {
                    kind: 'authenticatedLocalUser',
                    interactionId: expect.any(String),
                    occurredAtMs: expect.any(Number),
                },
                optionalSelections: [],
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({ bypassCache: true }),
        }));
        expect(modalAlertMock).toHaveBeenCalledWith('common.success', 'common.done');
    });

    it('shows unreviewed community npm code and routes Install & Trust through the exact daemon action', async () => {
        const communitySourceUrl = 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin';
        const refresh = vi.fn();
        const communityReview = createCommunityInstallReviewResult('pending-community-1');
        communityReview.change.review.optionalHostAccess.push({
            id: 'workspace',
            capability: 'workspace',
            reason: 'Read the selected workspace',
            authorizationClass: 'hostResourceSelection',
            normalizedScope: { access: ['read'] },
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: true,
                result: communityReview,
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            kind: 'committed',
            pluginId: 'community-plugin',
            desiredGeneration: 'generation-2',
            appliedGeneration: 'generation-2',
            pendingSurfaces: [],
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:community-npm',
                title: 'Community npm',
                sourceUrl: communitySourceUrl,
                enabled: true,
                origin: 'community-npm',
                addedAtMs: 1,
                updatedAtMs: 1,
            }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({
                pluginId: 'community-plugin',
                title: 'Community Plugin',
                description: 'Third-party plugin from npm',
                version: '2.0.0',
            }),
        ], {
            sourceId: 'marketplace:community-npm',
            sourceTitle: 'Community npm',
            sourceUrl: communitySourceUrl,
            sourceKind: 'community-npm',
            reviewStatus: 'unreviewed',
            curatedInstall: 'full-review',
            curatedUpdate: 'not-applicable',
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.community-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.unreviewed.community-plugin')).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.marketplaceCommunityUnreviewedTitle');
        expect(screen.getTextContent()).toContain('settingsPlugins.marketplaceCommunityUnreviewedBody');
        expect(screen.findRow('settings.plugins.marketplace.action.install.community-plugin')).toBeTruthy();

        modalShowMock.mockImplementationOnce(() => 'plugin-install-review-modal');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.install.community-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: {
                    sourceId: 'marketplace:community-npm',
                    pluginId: 'community-plugin',
                },
            },
            alerts: expect.objectContaining({ successMessage: null }),
        }));
        expect(modalShowMock).toHaveBeenCalledOnce();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        const reviewModalConfig = modalShowMock.mock.calls[0]?.[0] as Readonly<{
            component: React.ComponentType<Readonly<{
                onClose: () => void;
                setChrome?: (chrome: unknown) => void;
                body: string;
                optionalHostAccess: readonly Readonly<{
                    id: string;
                    capability: string;
                    reason: string;
                }>[];
                onResolve: (result: Readonly<{
                    approved: boolean;
                    optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
                }>) => void;
            }>>;
            props: Readonly<{
                body: string;
                optionalHostAccess: readonly Readonly<{
                    id: string;
                    capability: string;
                    reason: string;
                }>[];
                onResolve: (result: Readonly<{
                    approved: boolean;
                    optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
                }>) => void;
            }>;
        }>;
        expect(reviewModalConfig.props.body).toContain(
            '"identity":"Plugin: community-plugin\\nPackage: @acme/community-plugin 2.0.0',
        );
        expect(reviewModalConfig.props.body).toContain(
            '"requiredAccess":"network [cooperativeDisclosure]: Connect to the review service',
        );
        const reviewModal = await renderSettingsView(React.createElement(reviewModalConfig.component, {
            ...reviewModalConfig.props,
            onClose: vi.fn(),
            setChrome: vi.fn(),
        }));
        const sessionsToggle = reviewModal.findByTestId('settings.plugins.installReview.optional.sessions');
        expect(sessionsToggle?.props.value).toBe(false);
        expect(sessionsToggle?.props.accessibilityLabel).toContain('sessions');
        expect(sessionsToggle?.props.accessibilityState).toEqual({ checked: false });
        const workspaceToggle = reviewModal.findByTestId('settings.plugins.installReview.optional.workspace');
        expect(workspaceToggle?.props.value).toBe(false);
        expect(workspaceToggle?.props.accessibilityState).toEqual({ checked: false });
        await act(async () => {
            sessionsToggle?.props.onValueChange(true);
        });
        expect(reviewModal.findByTestId('settings.plugins.installReview.optional.sessions')?.props.value).toBe(true);
        expect(reviewModal.findByTestId('settings.plugins.installReview.optional.sessions')?.props.accessibilityState)
            .toEqual({ checked: true });
        await act(async () => {
            reviewModal.pressByTestId('settings.plugins.installReview.confirm');
            await flushAsync();
            await flushAsync();
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-community-1',
                decision: 'installAndTrust',
                actorEvidence: {
                    kind: 'authenticatedLocalUser',
                    interactionId: expect.any(String),
                    occurredAtMs: expect.any(Number),
                },
                optionalSelections: [
                    { accessId: 'sessions', selected: true },
                    { accessId: 'workspace', selected: false },
                ],
            },
        }));
        expect(refresh).toHaveBeenCalledTimes(1);

        modalShowMock.mockImplementationOnce((config: Readonly<{
            props?: Readonly<{
                onResolve?: (result: Readonly<{
                    approved: boolean;
                    optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
                }>) => void;
            }>;
        }>) => {
            config.props?.onResolve?.({ approved: false, optionalSelections: [] });
            return 'plugin-install-review-modal';
        });
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: true,
                result: createCommunityInstallReviewResult('pending-community-2'),
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'cancelled' });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.install.community-plugin');
            await flushAsync();
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-community-2',
                decision: 'cancel',
            },
        }));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('reconciles an outcome-unknown exact marketplace update after the private review decision', async () => {
        const communitySourceUrl = 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin';
        const installedPlugin = createInstalledPlugin({
            pluginId: 'community-plugin',
            title: 'Community Plugin',
            version: '1.0.0',
        });
        const initialState = createMachineCapabilitiesState([installedPlugin]);
        let authoritativeState: MachineCapabilitiesState = initialState;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: initialState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = createMachineCapabilitiesState([{
                ...installedPlugin,
                version: '2.0.0',
            }]);
        });
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: true,
                result: createCommunityInstallReviewResult('pending-update-1', 'update'),
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            kind: 'outcomeUnknown',
            pluginId: 'community-plugin',
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:community-npm',
                title: 'Community npm',
                sourceUrl: communitySourceUrl,
                enabled: true,
                origin: 'community-npm',
                addedAtMs: 1,
                updatedAtMs: 1,
            }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({
                pluginId: 'community-plugin',
                title: 'Community Plugin',
                version: '2.0.0',
            }),
        ], {
            sourceId: 'marketplace:community-npm',
            sourceTitle: 'Community npm',
            sourceUrl: communitySourceUrl,
            sourceKind: 'community-npm',
            reviewStatus: 'unreviewed',
            curatedInstall: 'full-review',
            curatedUpdate: 'not-applicable',
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.action.update.community-plugin')).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.marketplaceUpdateVersion');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.update.community-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'update',
                params: {
                    pluginId: 'community-plugin',
                    sourceId: 'marketplace:community-npm',
                },
            },
            alerts: expect.objectContaining({ successMessage: null }),
        }));
        expect(modalShowMock).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({
                title: 'settingsPlugins.marketplaceInstallReviewTitle',
            }),
            props: expect.objectContaining({
                body: expect.stringContaining('"identity":"Plugin: community-plugin\\nPackage: @acme/community-plugin 2.0.0'),
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: expect.objectContaining({
                v: 1,
                pendingChangeId: 'pending-update-1',
                decision: 'installAndTrust',
            }),
        }));
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({ bypassCache: true }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).toHaveBeenCalledWith('common.success', 'common.done');
    });

    it.each([
        ['stale', { freshnessState: 'stale' as const }],
        ['unapproved', { reviewStatus: 'blocked' as const }],
        ['non-curated', { sourceKind: 'user' as const }],
    ])('does not surface a non-warning %s marketplace listing', async (_label, options) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'new-plugin' }),
        ], options));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.new-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.action.install.new-plugin')).toBeFalsy();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('shows an urgent warning for a withdrawn curated listing without disabling installed code', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'withdrawn-plugin',
            title: 'Withdrawn Plugin',
            version: '1.0.0',
            enabled: true,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'withdrawn-plugin', title: 'Withdrawn Plugin' }),
        ], {
            reviewStatus: 'withdrawn',
            curatedInstall: 'refused',
            curatedUpdate: 'refused',
            warning: true,
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            filters: {
                sourceIds: ['marketplace:curated'],
                includeUnavailable: true,
            },
        }), expect.any(Object));
        expect(screen.findRow('settings.plugins.marketplace.entry.withdrawn-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.warning.withdrawn-plugin')).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.marketplaceWithdrawnTitle');
        expect(screen.getTextContent()).toContain('settingsPlugins.marketplaceWithdrawnInstalledBody');
        expect(screen.findRow('settings.plugins.marketplace.action.install.withdrawn-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.action.disable.withdrawn-plugin')).toBeTruthy();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('routes enable and disable through the host capability without advertising another mutation', async () => {
        const enabledPlugin = createInstalledPlugin({
            pluginId: 'existing-plugin',
            title: 'Existing Plugin',
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/existing-plugin',
                resolvedDigest: 'sha256:existing',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        const disabledPlugin = createInstalledPlugin({
            pluginId: 'disabled-plugin',
            title: 'Disabled Plugin',
            version: '2.0.0',
            enabled: false,
            source: {
                kind: 'catalog',
                locator: 'https://marketplace.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/disabled-plugin',
                resolvedDigest: 'sha256:disabled',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([enabledPlugin, disabledPlugin]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'existing-plugin', title: 'Existing Plugin', description: 'Descriptor for an installed plugin', version: '1.1.0' }),
            createMarketplaceCatalogEntry({ pluginId: 'disabled-plugin', title: 'Disabled Plugin', description: 'Descriptor for a disabled plugin', version: '2.0.0' }),
        ]));

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'existing-plugin',
                        title: 'Existing Plugin',
                        description: 'Descriptor for an installed plugin',
                        version: '1.1.0',
                    }),
                    createMarketplaceCatalogEntry({
                        pluginId: 'disabled-plugin',
                        title: 'Disabled Plugin',
                        description: 'Descriptor for an installed plugin that is disabled',
                        version: '2.0.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await selectPluginManagementView(screen, 'discover');
        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://marketplace.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.disable.existing-plugin');
            await flushAsync();
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.action.enable.disabled-plugin');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            request: expect.objectContaining({
                method: 'disable',
                params: expect.objectContaining({
                    pluginId: 'existing-plugin',
                }),
            }),
        }));
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            request: expect.objectContaining({
                method: 'enable',
                params: expect.objectContaining({
                    pluginId: 'disabled-plugin',
                }),
            }),
        }));
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenNthCalledWith(1, { bypassCache: true });
        expect(refresh).toHaveBeenNthCalledWith(2, { bypassCache: true });
    });

    it('does not offer Install & Trust for an already installed plugin from another marketplace source', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'existing-plugin',
            title: 'Existing Plugin',
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'catalog',
                locator: 'https://catalog-a.example.test/catalog.json',
                trustPolicy: 'trusted',
                installPolicy: 'allow',
                resolvedPath: '/plugins/existing-plugin',
                resolvedDigest: 'sha256:existing',
            },
            compatibility: {
                status: 'compatible',
                diagnostics: [],
            },
            diagnostics: [],
        });

        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]),
            refresh: vi.fn(),
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { ok: true } },
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:other',
                title: 'Other Marketplace',
                sourceUrl: 'https://catalog-b.example.test/catalog.json',
                enabled: true,
                origin: 'curated',
                addedAtMs: 1,
                updatedAtMs: 1,
            }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({
                pluginId: 'existing-plugin',
                title: 'Existing Plugin',
                description: 'Descriptor from a different catalog source',
                version: '9.9.9',
                sourceUrl: 'https://catalog-b.example.test/entries/existing-plugin.json',
                packageUrl: 'https://catalog-b.example.test/plugins/existing-plugin.tgz',
            }),
        ]));

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://catalog-b.example.test/catalog.json',
                title: 'Other Marketplace',
                description: 'Another catalog source',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'existing-plugin',
                        title: 'Existing Plugin',
                        description: 'Descriptor from a different catalog source',
                        version: '9.9.9',
                        sourceUrl: 'https://catalog-b.example.test/entries/existing-plugin.json',
                        packageUrl: 'https://catalog-b.example.test/plugins/existing-plugin.tgz',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        await selectPluginManagementView(screen, 'discover');
        const input = screen.findRow('settings.plugins.marketplace.catalogUrl');
        expect(input).toBeTruthy();
        await act(async () => {
            input?.props.onChangeText('https://catalog-b.example.test/catalog.json');
        });

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.loadCatalog');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.entry.existing-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.action.install.existing-plugin')).toBeFalsy();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('keeps unrelated plugin rows interactive while a plugin action is in flight', async () => {
        const deferred = createDeferred();
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'installed-plugin',
                    title: 'Installed Plugin',
                    version: '1.0.0',
                    enabled: true,
                }),
                createInstalledPlugin({
                    pluginId: 'other-plugin',
                    title: 'Other Plugin',
                    version: '1.0.0',
                    enabled: true,
                }),
            ]),
            refresh,
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'installed-plugin': {
                        id: 'installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                        digest: 'sha256:manifest',
                    },
                },
                providersById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });
        invokeWithAlertsMock.mockImplementation(async () => {
            await deferred.promise;
            return {
                supported: true,
                response: { ok: true, result: { ok: true } },
            };
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                t: 'happier_plugin_marketplace_catalog_v1',
                schemaVersion: 1,
                sourceUrl: 'https://marketplace.example.test/catalog.json',
                title: 'Curated Marketplace',
                description: 'Curated plugin descriptors',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: 'new-plugin',
                        title: 'New Plugin',
                        description: 'Descriptor for an uninstalled plugin',
                        version: '0.1.0',
                    }),
                ],
            }),
        }) as Response));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderSettingsView(React.createElement(PluginSettingsHomeScreen));

        const rowActions = screen.findAllByType('ItemRowActions' as any);
        const installedAction = rowActions
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'disable');
        const otherAction = rowActions
            .find((node) => node.props.title === 'Other Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'disable');
        expect(rowActions.flatMap((node) => node.props.actions).some((action: { id: string }) => action.id === 'reload')).toBe(false);
        expect(installedAction).toBeTruthy();
        expect(otherAction?.disabled).toBe(false);

        await act(async () => {
            installedAction?.onPress();
            await flushAsync();
        });

        const inFlightInstalledAction = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Installed Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'disable');
        const inFlightOtherAction = screen.findAllByType('ItemRowActions' as any)
            .find((node) => node.props.title === 'Other Plugin')
            ?.props.actions.find((action: { id: string }) => action.id === 'disable');
        expect(inFlightInstalledAction?.disabled).toBe(true);
        expect(inFlightOtherAction?.disabled).toBe(false);

        deferred.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });
});
