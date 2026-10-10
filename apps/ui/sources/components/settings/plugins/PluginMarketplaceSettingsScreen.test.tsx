import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationContext } from '@react-navigation/native';

import type {
    MarketplaceIndexQueryResultV1,
    MarketplaceSourceRegistryV1,
    PluginDiagnosticRecordV1,
} from '@happier-dev/protocol';
import type { PluginInstallationReview } from '@happier-dev/protocol/marketplace/internal';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { flattenTestStyle } from '@/dev/testkit';
import {
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

/**
 * The page renders under the app root's pane state: its details pane stands in the app's pane host
 * (`AppScopePaneHost`), exactly as in the app. Re-renders of the tree go through the same wrapper.
 */
function inAppPanes(element: React.ReactElement): React.ReactElement {
    // The native navigation SDK is a presentation boundary. Its context must be present for the
    // real optional-focus owner to read useIsFocused instead of its outside-a-screen default.
    const navigation = {
        isFocused: () => screenFocusState.value,
        setOptions: (options: Readonly<Record<string, unknown>>) => navigationSetOptionsSpy(options),
    } as unknown as NonNullable<React.ContextType<typeof NavigationContext>>;
    return React.createElement(NavigationContext.Provider, { value: navigation },
        React.createElement(AppPaneProvider, null, element));
}

async function renderInAppPanes(
    element: React.ReactElement,
    options: Parameters<typeof renderSettingsView>[1] = {},
): ReturnType<typeof renderSettingsView> {
    return renderSettingsView(inAppPanes(element), options);
}


type InstalledPluginDiagnostic = Readonly<{
    code: string;
    message: string;
}>;

type InstalledPluginEntry = Readonly<{
    pluginId: string;
    desiredGeneration?: string | null;
    appliedGeneration?: string | null;
    admittedIntegrity?: string | null;
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
    }>;
    install: Readonly<{
        mode: string;
        manifestVersion: string;
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
            developmentActions?: Readonly<{ create: boolean; develop?: boolean; unregister?: boolean }>;
            developmentStatus?: Readonly<{
              roots: readonly Readonly<{ kind: 'home' | 'workspace' | 'explicit'; rootPath: string; trusted: boolean; persisted: boolean }>[];
              plugins: readonly Readonly<{
                pluginId?: string;
                sourceRootPath: string;
                phase: 'observing' | 'preparing_dependencies' | 'compiling' | 'validating' | 'active' | 'retained_incumbent' | 'unavailable';
                occurrenceId?: string;
                uiArtifactDigest?: string;
                diagnostic?: InstalledPluginDiagnostic;
              }>[];
            }>;
            pendingChanges?: readonly unknown[];
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
        snapshot?: MachineCapabilitiesSnapshot;
    }>
    | Readonly<{
        status: 'error';
        snapshot?: MachineCapabilitiesSnapshot;
    }>;
type LoadedMachineCapabilitiesState = Extract<MachineCapabilitiesState, Readonly<{ status: 'loaded' }>>;

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
const machineMarketplaceSourceRegistryMutateMock = vi.hoisted(() => vi.fn());
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

// This suite statically loads New Session draft plumbing before the shared
// Settings harness is configured. Register the genuine modal host boundary at
// module setup time so those early imports cannot retain the real singleton.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: (...args) => modalAlertMock(...args),
            alertAsync: (...args) => modalAlertAsyncMock(...args),
            show: (...args) => modalShowMock(...args),
            confirm: (...args) => modalConfirmMock(...args),
            prompt: (...args) => modalPromptMock(...args),
        },
    }).module;
});
const activeAccountLifetime = vi.hoisted(() => Object.freeze({
    scope: Object.freeze({ serverId: 'server-a', accountId: 'account-a' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose(): void {} }),
}) satisfies ActiveServerAccountScopeLifetime);
const activeAccountScopeState = vi.hoisted(() => ({
    current: null as Readonly<{ serverId: string; accountId: string }> | null,
}));
const machineAdministrationFixture = vi.hoisted(() => ({
    activeMachines: [] as Array<Record<string, unknown>>,
    activeServerId: 'server-a',
    machineListByServerId: {} as Record<string, Array<Record<string, unknown>>>,
    machineListStatusByServerId: {} as Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>,
    profiles: [] as Array<Record<string, unknown>>,
    selections: {
        version: 1,
        targetsByKey: {},
        pluginExecutionOriginsByPluginId: {},
    } as Record<string, unknown>,
    /** Hydrated Account settings version, as the real store reports once loaded. */
    settingsVersion: 1 as number | null,
    setSelections: vi.fn(),
    storageState: {} as Record<string, unknown>,
}));
// A choice alert resolves after the pressed button's handler runs. The default
// picks the first button so the create flow exercises its real UI-mode branch.
const modalAlertAsyncMock = vi.hoisted(() => vi.fn(async (
    _title: string,
    _message?: string,
    buttons?: readonly { text: string; onPress?: () => void }[],
) => {
    buttons?.[0]?.onPress?.();
}));
const prefetchMachineCapabilitiesMock = vi.hoisted(() => vi.fn());
const screenFocusState = vi.hoisted(() => ({ value: true }));
const administrationTargetBoundary = createMachineAdministrationTargetSelectionMock({
    serverId: 'server-a',
    serverIdentityId: 'srv_identity-a',
    machines: [{ machineId: 'machine-1', displayName: 'Active machine' }],
    selectedMachineId: 'machine-1',
});

installMachineAdministrationTargetSelectionBoundary(administrationTargetBoundary);

const MARKETPLACE_CAPABILITY_ID = 'tool.plugins';

vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useIsFocused: () => screenFocusState.value,
}));

function setMachineAdministrationTargetFixture(params: Readonly<{
    serverIdentityId?: string;
    serverId?: string;
    machineId?: string;
    daemonStateVersion?: number;
}> = {}): void {
    const activeAt = Date.now();
    const target = {
        serverIdentityId: params.serverIdentityId ?? 'srv_identity-a',
        machineId: params.machineId ?? 'machine-1',
    };
    const serverId = params.serverId ?? 'server-a';
    const daemonStateVersion = params.daemonStateVersion ?? 1;
    const activeMachine = {
        id: 'machine-1',
        active: true,
        activeAt,
        updatedAt: 1,
        daemonStateVersion: 1,
        metadata: { displayName: 'Active machine', host: 'active-host' },
    };
    const selectedMachine = {
        id: target.machineId,
        active: true,
        activeAt,
        updatedAt: 1,
        daemonStateVersion,
        metadata: { displayName: target.machineId, host: `${target.machineId}-host` },
    };
    machineAdministrationFixture.activeServerId = 'server-a';
    const activeProfile = {
        id: 'server-a',
        name: 'Server A',
        serverUrl: 'https://server-a.example.test',
        serverIdentityId: 'srv_identity-a',
        legacyServerIds: [],
    };
    machineAdministrationFixture.profiles = serverId === activeProfile.id
        && target.serverIdentityId === activeProfile.serverIdentityId
        ? [activeProfile]
        : [
            activeProfile,
            {
                id: serverId,
                name: 'Server B',
                serverUrl: 'https://server-b.example.test',
                serverIdentityId: target.serverIdentityId,
                legacyServerIds: [],
            },
        ];
    machineAdministrationFixture.activeMachines = [
        serverId === 'server-a' ? selectedMachine : activeMachine,
    ];
    machineAdministrationFixture.machineListByServerId = {
        'server-a': [activeMachine],
        [serverId]: [selectedMachine],
    };
    machineAdministrationFixture.machineListStatusByServerId = {
        'server-a': 'idle',
        [serverId]: 'idle',
    };
    machineAdministrationFixture.selections = {
        version: 1,
        targetsByKey: { 'plugins.home': target },
        pluginExecutionOriginsByPluginId: {},
    };
    machineAdministrationFixture.storageState = {
        isDataReady: true,
        machines: Object.fromEntries(machineAdministrationFixture.activeMachines.map((machine) => [machine.id, machine])),
        machineListByServerId: machineAdministrationFixture.machineListByServerId,
        machineListStatusByServerId: machineAdministrationFixture.machineListStatusByServerId,
        settings: {
            machineAdministrationSelectionsV1: machineAdministrationFixture.selections,
        },
    };
    machineAdministrationFixture.setSelections.mockReset();
    machineAdministrationFixture.setSelections.mockImplementation((next: Record<string, unknown>) => {
        machineAdministrationFixture.selections = next;
        machineAdministrationFixture.storageState = {
            ...machineAdministrationFixture.storageState,
            settings: { machineAdministrationSelectionsV1: next },
        };
    });
    syncAdministrationTargetBoundary();
}

function syncAdministrationTargetBoundary(): void {
    const target = (machineAdministrationFixture.selections as {
        targetsByKey?: Record<string, { serverIdentityId: string; machineId: string }>;
    }).targetsByKey?.['plugins.home'] ?? null;
    const seen = new Set<string>();
    const machines = Object.entries(machineAdministrationFixture.machineListByServerId)
        .flatMap(([serverId, entries]) => entries.map((machine) => {
            const profile = machineAdministrationFixture.profiles.find((entry) => entry.id === serverId);
            const serverIdentityId = String(profile?.serverIdentityId ?? serverId);
            const machineId = String(machine.id);
            const metadata = machine.metadata as Record<string, unknown> | undefined;
            const identity = `${serverIdentityId}:${machineId}`;
            if (seen.has(identity)) return null;
            seen.add(identity);
            return {
                machineId,
                displayName: String(metadata?.displayName ?? machineId),
                daemonStateVersion: typeof machine.daemonStateVersion === 'number'
                    ? machine.daemonStateVersion
                    : 1,
                serverId,
                serverIdentityId,
                serverLabel: String(profile?.name ?? serverId),
                availability: machine.active === false ? 'offline' as const : 'online' as const,
                observation: 'live' as const,
            };
        }))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    administrationTargetBoundary.controller.setMachines(machines);
    administrationTargetBoundary.controller.select(
        target?.machineId ?? null,
        target?.serverIdentityId,
    );
}

function clearMachineAdministrationTargetFixture(): void {
    machineAdministrationFixture.selections = {
        version: 1,
        targetsByKey: {},
        pluginExecutionOriginsByPluginId: {},
    };
    machineAdministrationFixture.storageState = {
        ...machineAdministrationFixture.storageState,
        settings: {
            machineAdministrationSelectionsV1: machineAdministrationFixture.selections,
        },
    };
    syncAdministrationTargetBoundary();
}

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
        },
        install: {
            mode: 'catalog',
            manifestVersion: '1',
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
        occurrenceId: '12',
        host: 'daemon',
        platform: 'test',
        occurredAtMs: 1,
        resolution: { state: 'current' },
    };
}

function createMachineCapabilitiesState(
    installedPlugins: readonly InstalledPluginEntry[],
    developmentPlugins: NonNullable<NonNullable<NonNullable<MachineCapabilitiesResponse['results'][string]>['data']>['developmentStatus']>['plugins'] = [],
    pendingChanges: readonly unknown[] = [],
    developmentRoots: NonNullable<NonNullable<NonNullable<MachineCapabilitiesResponse['results'][string]>['data']>['developmentStatus']>['roots'] = [],
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
                            developmentActions: { create: true, develop: true, unregister: true },
                            developmentStatus: { roots: developmentRoots, plugins: developmentPlugins },
                            pendingChanges,
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
        artifactAccessState?: 'public' | 'unverified-profile';
        registryOrigin?: string;
        sourceDiagnostics?: readonly Readonly<{ code: string; message: string }>[];
        indexDiagnostics?: readonly Readonly<{ code: string; message: string }>[];
        revision?: number;
        nextCursor?: string | null;
    }> = {},
): MarketplaceIndexQueryResultV1 {
    const sourceId = options.sourceId ?? 'marketplace:curated';
    const sourceTitle = options.sourceTitle ?? 'Curated Marketplace';
    const sourceUrl = options.sourceUrl ?? 'https://marketplace.example.test/catalog.json';
    return {
        revision: options.revision ?? 1,
        items: entries.map((entry) => ({
            pluginId: entry.manifestId,
            publisher: { id: 'acme', displayName: 'Acme' },
            display: { title: entry.title, description: entry.description },
            distribution: {
                kind: 'npm',
                registryOrigin: options.registryOrigin ?? 'https://registry.npmjs.org',
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
            updatePolicy: 'allowed',
            links: {},
            source: {
                id: sourceId,
                title: sourceTitle,
                kind: options.sourceKind ?? 'curated',
                sourceUrl,
            },
            freshness: { state: options.freshnessState ?? 'fresh', fetchedAtMs: 1 },
            // The one canonical admission shape (MarketplaceIndexAdmissionV1Schema):
            // every install is full-review — curation is discovery only — and a
            // withdrawal warns without disabling installed code.
            admission: {
                install: 'full-review',
                mutatesInstalledTrust: false,
                disablesInstalledCode: false,
                directNpmRequiresFullReview: true,
            },
            artifactAccess: {
                state: options.artifactAccessState ?? 'public',
                registryProfileId: null,
            },
        })),
        nextCursor: options.nextCursor ?? null,
        sources: [{
            source: { id: sourceId, title: sourceTitle, kind: options.sourceKind ?? 'curated', sourceUrl },
            freshness: { state: options.freshnessState ?? 'fresh', fetchedAtMs: 1 },
            diagnostics: [...(options.sourceDiagnostics ?? [])],
        }],
        diagnostics: [...(options.indexDiagnostics ?? [])],
    };
}

function createCommunityInstallReviewResult(pendingChangeId: string, action: 'install' | 'update' = 'install') {
    return {
        action,
        pluginId: 'community-plugin',
        change: {
            kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
                    integrityBasis: 'expected',
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
                rawCredentialAccess: [],
                requestInterceptors: [],
                compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
                updatePolicy: 'allowed',
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

/**
 * Walks up from a rendered node to the nearest accessible/live-region
 * announcement parent. Detail rows that assistive technology can traverse
 * individually have no such ancestor; rows swallowed by an aggregate
 * accessible parent do.
 */
function closestAccessibleAnnouncementAncestor(node: ReactTestInstance | null): ReactTestInstance | null {
    let current = node?.parent ?? null;
    while (current !== null) {
        if (current.props?.accessible === true || typeof current.props?.accessibilityLiveRegion === 'string') {
            return current;
        }
        current = current.parent;
    }
    return null;
}

function findPendingChangeAction(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pendingChangeId: string,
    actionId: 'review' | 'reject',
): Readonly<{ id: string; title: string; subtitle?: string; disabled: boolean; onPress: () => void }> | undefined {
    return screen.findAllByType('ItemRowActions' as never)
        .flatMap((node: Readonly<{ props: Readonly<{ overflowTriggerTestID?: string; actions?: readonly Readonly<{ id: string; title: string; subtitle?: string; disabled: boolean; onPress: () => void }>[] }> }>) => (
            node.props.overflowTriggerTestID === `settings.plugins.management.pendingChanges.${pendingChangeId}.actions.overflow`
                ? node.props.actions ?? []
                : []
        ))
        .find((action: Readonly<{ id: string }>) => action.id === actionId) as
        | Readonly<{ id: string; title: string; subtitle?: string; disabled: boolean; onPress: () => void }>
        | undefined;
}

type DiscoverListingAction = Readonly<{
    id: string;
    title: string;
    accessibilityLabel?: string;
    subtitle?: string;
    disabled: boolean;
    onPress: () => void;
}>;

function discoverListingTestID(pluginId: string, sourceId = 'marketplace:curated'): string {
    return `settings.plugins.marketplace.entry.${sourceId}.${pluginId}`;
}

/**
 * The actions a Discover listing carries on its own row.
 *
 * One listing is one row, so a listing's actions are looked up through that
 * row's action cluster rather than through a row of their own.
 */
function findDiscoverListingActions(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
    sourceId = 'marketplace:curated',
): readonly DiscoverListingAction[] {
    return ['install', 'manage'].flatMap((id) => {
        const button = screen.findAllByTestId(`settings.plugins.marketplace.action.${id}.${sourceId}.${pluginId}`)
            .find((node) => typeof node.props.title === 'string');
        return button ? [{ id, title: button.props.title, accessibilityLabel: button.props.accessibilityLabel,
            subtitle: button.props.accessibilityHint, disabled: Boolean(button.props.disabled), onPress: button.props.onPress }] : [];
    });
}

function findDiscoverInstallAction(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
    sourceId = 'marketplace:curated',
): DiscoverListingAction | undefined {
    return findDiscoverListingActions(screen, pluginId, sourceId).find((action) => action.id === 'install');
}

function findDevelopmentPluginAction(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
    actionId: 'editWithAgent' | 'test' | 'pack' | 'unregister',
): DiscoverListingAction | undefined {
    return screen.findAllByType('ItemRowActions' as never)
        .flatMap((node: Readonly<{ props: Readonly<{ overflowTriggerTestID?: string; actions?: readonly DiscoverListingAction[] }> }>) => (
            node.props.overflowTriggerTestID === `settings.plugins.management.development.${pluginId}.actions.overflow`
                ? node.props.actions ?? []
                : []
        ))
        .find((action) => action.id === actionId);
}

/** The Browse search field: the input itself, not its field wrapper. */
function findDiscoverSearchInput(screen: Awaited<ReturnType<typeof renderSettingsView>>): ReactTestInstance | null {
    return screen.findAll((node) => node.props?.testID === 'settings.plugins.marketplace.search'
        && typeof node.props.accessibilityLabel === 'string')[0] ?? null;
}

/** Browse searches on submit; while the daemon cannot answer, the field offers no submit at all. */
function canSubmitDiscoverSearch(screen: Awaited<ReturnType<typeof renderSettingsView>>): boolean {
    return typeof findDiscoverSearchInput(screen)?.props.onSubmitEditing === 'function';
}

function submitDiscoverSearch(screen: Awaited<ReturnType<typeof renderSettingsView>>): void {
    const submit = findDiscoverSearchInput(screen)?.props.onSubmitEditing as (() => void) | undefined;
    if (!submit) throw new Error('Expected the Browse search to accept a submit');
    submit();
}

function findDiscoverSourceFilter(screen: Awaited<ReturnType<typeof renderSettingsView>>): ReactTestInstance | null {
    return screen.findAll((node) => node.props?.testID === 'settings.plugins.marketplace.sourceFilter'
        && Array.isArray(node.props.items))[0] ?? null;
}

/** The source choices the Browse filter offers, "all" first. */
function findDiscoverSourceFilterIds(screen: Awaited<ReturnType<typeof renderSettingsView>>): readonly string[] {
    return (findDiscoverSourceFilter(screen)?.props.items ?? []).map((item: { id: string }) => item.id);
}

function selectDiscoverSource(screen: Awaited<ReturnType<typeof renderSettingsView>>, sourceId: string): void {
    const onSelect = findDiscoverSourceFilter(screen)?.props.onSelect as ((id: string) => void) | undefined;
    if (!onSelect) throw new Error('Expected the Browse source filter');
    onSelect(sourceId);
}

/** A rare operation in a plugin page's header `⋯` menu (update, roll back). */
function findDetailMenuAction(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
    actionId: 'update' | 'rollback',
): Readonly<{ id: string; disabled?: boolean; onSelect: () => void }> | null {
    const menu = screen.findAll((node) => node.props?.testID === `settings.plugins.detail.${pluginId}.menu`
        && Array.isArray(node.props.actions))[0];
    return menu?.props.actions.find((action: { id: string }) => action.id === actionId) ?? null;
}

/**
 * An installed row's one inline control: its Enabled switch. Everything rarer
 * (update, roll back, uninstall) lives on the plugin's own page.
 */
function findInstalledRowToggle(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
): Readonly<{ action: 'enable' | 'disable'; disabled: boolean; toggle: () => void }> | null {
    const prefix = `settings.plugins.marketplace.installed.${pluginId}.action.`;
    const toggle = screen.findAll((node) => typeof node.props?.testID === 'string'
        && node.props.testID.startsWith(prefix)
        && typeof node.props.onValueChange === 'function')[0];
    if (!toggle) return null;
    // Capture the handler of this render, as a pressed control would hold it.
    const onValueChange = toggle.props.onValueChange as (value: boolean) => void;
    const value = Boolean(toggle.props.value);
    return {
        action: toggle.props.testID.slice(prefix.length) as 'enable' | 'disable',
        disabled: Boolean(toggle.props.disabled),
        toggle: () => onValueChange(!value),
    };
}

/**
 * Starts one lifecycle operation from a plugin page: roll back lives in the
 * header `⋯` menu, uninstall and forget trust in the leave row.
 */
function pressDetailLifecycleAction(
    screen: Awaited<ReturnType<typeof renderSettingsView>>,
    pluginId: string,
    method: 'rollback' | 'uninstall' | 'forgetTrust',
): void {
    if (method === 'rollback') {
        const action = findDetailMenuAction(screen, pluginId, 'rollback');
        if (!action) throw new Error(`Expected the ${pluginId} page menu to offer rollback`);
        action.onSelect();
        return;
    }
    screen.pressRow(`settings.plugins.detail.${pluginId}.action.${method}`);
}

/** Flips a plugin page's header "Enabled" switch. */
function toggleDetailEnabled(screen: Awaited<ReturnType<typeof renderSettingsView>>, testID: string): void {
    const toggle = screen.findAll((node) => node.props?.testID === testID
        && typeof node.props.onValueChange === 'function')[0];
    if (!toggle) throw new Error(`Expected the enabled switch ${testID}`);
    toggle.props.onValueChange(!toggle.props.value);
}

/** Whether `node` renders inside `ancestor`, used to prove a fact belongs to one row. */
function isRenderedWithin(node: ReactTestInstance | null, ancestor: ReactTestInstance | null): boolean {
    if (!node || !ancestor) return false;
    let current: ReactTestInstance | null = node.parent ?? null;
    while (current !== null) {
        if (current === ancestor) return true;
        current = current.parent;
    }
    return false;
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
            // These screens are rendered in their Settings host; the Plugins
            // routes they build follow the host the pathname names.
            pathname: '/settings/plugins',
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
                alertAsync: (...args) => modalAlertAsyncMock(...args),
                show: (...args) => modalShowMock(...args),
                confirm: (...args) => modalConfirmMock(...args),
                prompt: (...args) => modalPromptMock(...args),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            // The Plugins page remembers Grid | List per view on this device. This suite reads the list: its rows
            // mount before the page is measured, where the grid (as in the app) waits for its measured width.
            useLocalSettingMutable: ((key: string) => (key === 'pluginsCollectionViewV1'
                ? [{ installed: 'list', discover: 'list' }, () => {}]
                : [undefined, () => {}])) as never,
            useAllMachines: () => [],
            useMachineListByServerId: () => ({}),
            useMachineListStatusByServerId: () => ({}),
            useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
        });
    },
    // The shared runtime's own mock convention (`key` or `key(param=value,...)`)
    // is used verbatim — no suite-local translation override, so every
    // parameterized-string assertion below describes the one shape the testkit
    // produces for any suite.
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

// This suite's harness does not stand up the server-selection store the real
// feature hook subscribes to, and the plugins settings tree asks for exactly one
// feature, so the decision is supplied directly and every other id stays off.
const webhookFeature = vi.hoisted(() => ({ enabled: true }));
const observedFeatureIds = vi.hoisted(() => [] as string[]);

// Whether a side pane exists is the platform's answer; a test that follows a plugin to its own page
// says it runs where there is none (a phone).
const deviceTypeOverride = vi.hoisted(() => ({ value: null as 'phone' | null }));
afterEach(() => {
    deviceTypeOverride.value = null;
});
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return { ...actual, useDeviceType: () => deviceTypeOverride.value ?? actual.useDeviceType() };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        observedFeatureIds.push(featureId);
        return featureId === 'plugins.webhooks' ? webhookFeature.enabled : false;
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    const base = createServerProfilesModuleMock({
        listServerProfiles: () => machineAdministrationFixture.profiles,
    });
    return {
        // The app's pane state loads the real store, which watches the active server and the Home view.
        ...(await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>()),
        ...base,
        getActiveServerId: () => getActiveServerIdMock(),
        getActiveServerSnapshot: () => ({
            serverId: getActiveServerIdMock(),
            serverUrl: 'https://server.example.test',
            generation: 1,
        }),
        resolveServerProfileForPortableIdentity: (serverIdentityId: string) => {
            const profiles = machineAdministrationFixture.profiles.filter((profile) => (
                profile.serverIdentityId === serverIdentityId
                || (Array.isArray(profile.legacyServerIds) && profile.legacyServerIds.includes(serverIdentityId))
            ));
            if (profiles.length === 1) {
                return { kind: 'resolved', serverIdentityId, profile: profiles[0] };
            }
            return profiles.length > 1
                ? { kind: 'ambiguous', serverIdentityId, profiles }
                : { kind: 'missing', serverIdentityId };
        },
    };
});

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    // The app's pane state loads the real store, which subscribes to the active server.
    ...(await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>()),
    getActiveServerSnapshot: () => ({
        serverId: machineAdministrationFixture.activeServerId,
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: machineAdministrationFixture.activeServerId,
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: (serverIds: readonly string[]) => {
        const serverId = serverIds[0];
        return React.useMemo(() => serverId
            // The binding IS a `ServerAccountScopeLifetime`: its `scope` is what
            // routed readers (the daemon projection loader) key the Account on.
            ? new Map([[serverId, {
                serverId,
                accountId: activeAccountLifetime.scope.accountId,
                scope: { serverId, accountId: activeAccountLifetime.scope.accountId },
                revision: 1,
                isCurrent: activeAccountLifetime.isCurrent,
                onRetire: activeAccountLifetime.onRetire,
            }]])
            : new Map(), [serverId]);
    },
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 1,
}));

vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadMachineDisplayWarmCacheEntries: () => ({}),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: {
        getState: () => machineAdministrationFixture.storageState,
    },
    // The Account-scope reader was added to the canonical Settings writer;
    // expose that same safe state through this existing store boundary fixture.
    getStorage: () => (selector: (state: Readonly<{ settingsScope: Readonly<{ serverId: string; accountId: string }> | null }>) => unknown) => selector({ settingsScope: activeAccountScopeState.current }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (...args: unknown[]) => useMachineCapabilitiesCacheMock(...args),
    getMachineCapabilitiesCacheState: (...args: unknown[]) => getMachineCapabilitiesCacheStateMock(...args),
    prefetchMachineCapabilities: (...args: unknown[]) => prefetchMachineCapabilitiesMock(...args),
}));

vi.mock('@/sync/store/hooks', () => ({
    useEndpointStatus: () => endpointConnectivityState.status,
    // The app's pane state starts empty; every other local setting this page reads is the list density.
    useLocalSetting: (key: string) => (key === 'appPaneScopesV1' ? null : 'comfortable'),
    // The Plugins page remembers Grid | List per view on this device; the default (grid) is read.
    useLocalSettingMutable: () => [{}, () => {}],
    useMachineCliDetectionTarget: (...args: unknown[]) => useMachineCliDetectionTargetMock(...args),
    useMachineRecordValues: () => machineAdministrationFixture.activeMachines,
    useMachineRecordListsByServerId: () => machineAdministrationFixture.machineListByServerId,
    useMachineListStatusByServerId: () => machineAdministrationFixture.machineListStatusByServerId,
    useIsDataReady: () => true,
    useActiveServerAccountScope: () => activeAccountScopeState.current,
    useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
    useSetting: () => machineAdministrationFixture.selections,
    // The administration-target owner persists a sole-candidate initialization
    // through the versioned Account settings mutation, so a hydrated settings
    // version is part of this boundary's real contract rather than an optional
    // extra. Omitting it made every render of this screen throw.
    useSettingsVersion: () => machineAdministrationFixture.settingsVersion,
    useSettingMutable: () => [
        machineAdministrationFixture.selections,
        machineAdministrationFixture.setSelections,
    ],
}));

vi.mock('@/hooks/machine/useMachineCapabilityInvokeWithAlerts', () => ({
    useMachineCapabilityInvokeWithAlerts: () => ({
        isInvoking: false,
        invokeWithAlerts: invokeWithAlertsMock,
    }),
}));

vi.mock('@/sync/ops/machineMarketplaceSources', () => ({
    machineMarketplaceSourceRegistryGet: (...args: unknown[]) => machineMarketplaceSourceRegistryGetMock(...args),
    machineMarketplaceSourceRegistryMutate: (...args: unknown[]) => machineMarketplaceSourceRegistryMutateMock(...args),
    machineMarketplaceIndexQuery: (...args: unknown[]) => machineMarketplaceIndexQueryMock(...args),
    resolvePreferredMachineMarketplaceSource: (registry: MarketplaceSourceRegistryV1) =>
        registry.sources.find((entry) => entry.enabled && entry.origin === 'curated') ?? registry.sources.find((entry) => entry.enabled) ?? null,
}));

vi.mock('@/sync/ops/machineNpmRegistryProfiles', () => ({
    machineNpmRegistryProfilesGet: (...args: unknown[]) => machineNpmRegistryProfilesGetMock(...args),
    machineNpmRegistryProfilesMutate: (...args: unknown[]) => machineNpmRegistryProfilesMutateMock(...args),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', async () => {
    // The real op only ever hands callers a projection the canonical projection
    // owner has already parsed, so every defaulted map — families, settings —
    // is present by the time a reader sees it. Fixtures are normalized through
    // that same owner here, so a test can never assert against a projection
    // shape the daemon boundary could not have produced.
    const { PluginProjectionV2Schema } = await import('@happier-dev/protocol');
    const normalizeDescribeResult = (result: unknown): unknown => {
        if (
            result === null
            || typeof result !== 'object'
            || (result as { supported?: unknown }).supported !== true
        ) return result;
        const projection = (result as { projection?: unknown }).projection;
        if (
            projection === null
            || typeof projection !== 'object'
            || (projection as { v?: unknown }).v !== 2
        ) return result;
        return {
            ...result,
            projection: PluginProjectionV2Schema.parse({
                // The wire schema defaults the finite family map during daemon
                // projection construction. These focused fixtures specify only
                // the families their assertion consumes, so model that parsed
                // boundary instead of making every fixture repeat an empty map.
                familiesById: {},
                ...projection,
            }),
        };
    };
    return ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: async (...args: unknown[]) =>
        normalizeDescribeResult(await machineContributionRegistryProjectionDescribeMock(...args)),
    publishMachineContributionRegistryProjectionInvalidation: (...args: unknown[]) =>
        publishMachineContributionRegistryProjectionInvalidationMock(...args),
    machinePluginStructuredMessageActionExecute: (...args: unknown[]) =>
        machinePluginStructuredMessageActionExecuteMock(...args),
    machinePluginSettingsGet: async (
        machineId: string,
        opts: { serverId?: string | null; serverIdentityId: string; pluginId: string },
    ) => ({
        supported: true,
        snapshot: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.settings.get',
            payload: {
                serverIdentityId: opts.serverIdentityId,
                machineId,
                pluginId: opts.pluginId,
                scope: { kind: 'daemon' },
            },
        }),
    }),
    machinePluginSettingsSet: async (
        machineId: string,
        opts: Readonly<{
            serverId?: string | null;
            serverIdentityId: string;
            pluginId: string;
            fieldId: string;
            mutation: Readonly<{ kind: 'set'; value: unknown }> | Readonly<{ kind: 'delete' }>;
            expectedRevision?: string;
        }>,
    ) => ({
        supported: true,
        snapshot: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.settings.set',
            payload: {
                serverIdentityId: opts.serverIdentityId,
                machineId,
                pluginId: opts.pluginId,
                scope: { kind: 'daemon' },
                fieldId: opts.fieldId,
                mutation: opts.mutation,
                ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
            },
        }),
    }),
    machinePluginSecretStatus: async (
        machineId: string,
        opts: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
        }>,
    ) => ({
        supported: true,
        result: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.secrets.status',
            payload: {
                serverIdentityId: opts.serverIdentityId,
                machineId,
                pluginId: opts.pluginId,
                secretId: opts.secretId,
                ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
            },
        }),
    }),
    machinePluginSecretSet: async (
        machineId: string,
        opts: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
            value: string;
            expectedRevision?: string;
        }>,
    ) => ({
        supported: true,
        result: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.secrets.set',
            payload: {
                serverIdentityId: opts.serverIdentityId,
                machineId,
                pluginId: opts.pluginId,
                secretId: opts.secretId,
                ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
                value: opts.value,
                ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
            },
        }),
    }),
    machinePluginSecretDelete: async (
        machineId: string,
        opts: Readonly<{
            serverId: string;
            serverIdentityId: string;
            pluginId: string;
            secretId: string;
            canonicalOrigin?: string;
            expectedRevision?: string;
        }>,
    ) => ({
        supported: true,
        result: await machineRpcWithServerScopeMock({
            machineId,
            serverId: opts.serverId,
            method: 'daemon.plugins.secrets.delete',
            payload: {
                serverIdentityId: opts.serverIdentityId,
                machineId,
                pluginId: opts.pluginId,
                secretId: opts.secretId,
                ...(opts.canonicalOrigin === undefined ? {} : { canonicalOrigin: opts.canonicalOrigin }),
                ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
            },
        }),
    }),
    });
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: readonly unknown[]) =>
        machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>();
    return {
        ...actual,
        captureActiveServerAccountScopeLifetime: () => activeAccountLifetime,
    };
});

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
    ...actual,
    AGENT_IDS: ['claude', 'codex'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: (agentId: string) => ({
        ...actual.getAgentCore(agentId as never),
        displayNameKey: `agents.${agentId}.name`,
        uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.claude', connectRoute: null },
        ui: { agentPickerIconName: 'terminal-outline' },
    }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    isBundledAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
    resolveBundledAgentIdFromContributionIdentity: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
    };
});

vi.mock('@/components/ui/lists/ItemRowActions', async () => {
    const { createPassThroughModule } = await import('@/dev/testkit/mocks/components');
    return createPassThroughModule(['ItemRowActions']);
});

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
        isBundledAgentId: (agentId: unknown) => agentId === 'claude' || agentId === 'codex',
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
    resetSessionDraftRepositoryForTests();
    activeAccountScopeState.current = null;
    getActiveServerIdMock.mockReset();
    useMachineCapabilitiesCacheMock.mockReset();
    getMachineCapabilitiesCacheStateMock.mockReset();
    useMachineCliDetectionTargetMock.mockReset();
    endpointConnectivityState.status = 'online';
    invokeWithAlertsMock.mockReset();
    refreshMachineCapabilitiesMock.mockReset();
    machineMarketplaceSourceRegistryGetMock.mockReset();
    machineMarketplaceSourceRegistryMutateMock.mockReset();
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
    modalAlertAsyncMock.mockClear();
    prefetchMachineCapabilitiesMock.mockReset();
    screenFocusState.value = true;
    machineAdministrationFixture.setSelections.mockReset();
    webhookFeature.enabled = true;
    observedFeatureIds.length = 0;
    vi.unstubAllGlobals();
});

beforeEach(() => {
    clearDaemonMergedProjectionCacheForTests();
    setMachineAdministrationTargetFixture();
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
        projection: {
            v: 2,
            generation: 1,
            installedPackagesById: {},
            agentsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            diagnostics: [],
        },
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
            review?: Readonly<{ optionalHostAccess: readonly Readonly<{ id: string }>[] }>;
            onResolve?: (result: Readonly<{
                approved: boolean;
                optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
            }>) => void;
        }>;
    }>) => {
        if (config.chrome?.testID === 'settings.plugins.installReview') {
            config.props?.onResolve?.({
                approved: true,
                optionalSelections: (config.props.review?.optionalHostAccess ?? []).map((entry) => ({
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
    it.each(['create', 'createWithAgent'])('keeps the complete %s draft editable until scaffold submission', async (action) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => { screen.pressByTestId(`settings.plugins.management.development.action.${action}`); });
        const form = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm | undefined;
        expect(form).toBeDefined();
        if (!form) throw new Error('Expected the canonical authoring form');
        expect(form.getFields().map((field) => field.path)).toEqual(['targetDir', 'displayName', 'pluginId', 'ui']);
        const draft = { targetDir: '/workspace/plugin', displayName: 'Working Plugin', pluginId: 'com.example.working', ui: 'hostedWeb' };
        form.replaceInput(draft);
        expect(form.isRetired()).toBe(false);
        expect(form.getInput()).toEqual(draft);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(modalPromptMock).not.toHaveBeenCalled();
    });

    it('does not claim an empty installation list before the first successful read', async () => {
        let capabilityState: MachineCapabilitiesState = { status: 'loading' };
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({ state: capabilityState, refresh: vi.fn() }));
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderableHome = PluginSettingsHomeScreen as React.ComponentType<{ capabilityRevision?: number }>;
        const screen = await renderInAppPanes(React.createElement(RerenderableHome, { capabilityRevision: 1 }));
        await act(async () => { await flushAsync(); });
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeTruthy();

        capabilityState = createMachineCapabilitiesState([]);
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderableHome, { capabilityRevision: 2 })));
            await flushAsync();
        });
        expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeTruthy();
        await act(async () => { screen.pressRow('settings.plugins.marketplace.installed.empty.browse'); });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
    });

    it.each(['unselected', 'offline', 'missing'] as const)('only describes a disconnected machine when a target is selected: %s', async (kind) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        if (kind === 'unselected') {
            machineAdministrationFixture.machineListByServerId = {};
            clearMachineAdministrationTargetFixture();
        } else if (kind === 'offline') {
            machineAdministrationFixture.activeMachines[0]!.active = false;
            syncAdministrationTargetBoundary();
        } else {
            machineAdministrationFixture.machineListByServerId = {};
            syncAdministrationTargetBoundary();
        }
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        expect(Boolean(screen.findRow('settings.plugins.marketplace.readOnlySnapshot'))).toBe(kind !== 'unselected');
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('reads an online machine it cannot resolve yet as checking, never as disconnected or empty', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: { status: 'idle' }, refresh: vi.fn() });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        administrationTargetBoundary.controller.setExecutionPending(true);
        try {
            const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
            const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
            await act(async () => { await flushAsync(); await flushAsync(); });
            expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
            expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
            expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeTruthy();
        } finally {
            administrationTargetBoundary.controller.setExecutionPending(false);
        }
    });

    it('keeps Account data recovery for removed plugins on Diagnostics, off the everyday Plugins page', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const home = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        for (const view of ['installed', 'discover'] as const) {
            await selectPluginManagementView(home, view);
            expect(home.findRow('settings.plugins.accountDataErase')).toBeFalsy();
            expect(home.findRow('settings.plugins.diagnostics')?.props.onPress).toBeTypeOf('function');
        }
        const { PluginDiagnosticsScreen } = await import('./diagnostics/PluginDiagnosticsScreen');
        const diagnostics = await renderInAppPanes(React.createElement(PluginDiagnosticsScreen));
        expect(diagnostics.findRow('settings.plugins.accountDataErase')?.props.onPress).toBeTypeOf('function');
    });

    it.each(['home', 'detail'] as const)('offers cold capability failure recovery on %s without claiming absence', async (route) => {
        let capabilityState: MachineCapabilitiesState = { status: 'error' };
        const refresh = vi.fn(() => { capabilityState = createMachineCapabilitiesState([]); });
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({ state: capabilityState, refresh }));
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const element = route === 'home'
            ? React.createElement(PluginSettingsHomeScreen)
            : React.createElement(PluginDetailScreen, { pluginId: 'unread-plugin' });
        const screen = await renderInAppPanes(element);
        await act(async () => { await flushAsync(); await flushAsync(); });
        const retryTestID = route === 'home'
            ? 'settings.plugins.marketplace.installed.readFailed-action'
            : 'settings.plugins.detail.readOnlySnapshot-retry';
        expect(screen.findRow(retryTestID)).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeFalsy();
        await act(async () => {
            screen.pressRow(retryTestID);
            await flushAsync();
        });
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });

    it('routes plugin capabilities to the exact Administration target rather than active first-machine selection', async () => {
        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'admin-machine-b',
            daemonStateVersion: 7,
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        expect(useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0]).toMatchObject({
            machineId: 'admin-machine-b',
            serverId: 'server-b',
            cacheKeySalt: expect.stringContaining('7'),
            enabled: true,
        });
        expect(administrationTargetBoundary.controller.serverIdentityId).toBe('srv_identity-a');
        expect(useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0]).toMatchObject({
            machineId: 'admin-machine-b',
            serverId: 'server-b',
        });
    });

    it('links to plugin webhook administration from the canonical Plugins settings surface', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        expect(screen.findRow('settings.plugins.webhooks')).toBeTruthy();

        await act(async () => {
            screen.pressRow('settings.plugins.webhooks');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/settings/plugins/webhooks');
    });

    it('links to Sources & registries outside the Discover view', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        expect(screen.findRow('settings.plugins.sources')).toBeTruthy();
        await act(async () => { screen.pressRow('settings.plugins.sources'); });
        expect(routerPushSpy).toHaveBeenCalledWith('/settings/plugins/sources');
    });

    it('hides the webhook administration entry when the server webhook feature is unavailable', async () => {
        webhookFeature.enabled = false;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        expect(observedFeatureIds).toContain('plugins.webhooks');
        expect(screen.findRow('settings.plugins.webhooks')).toBeNull();
    });

    it('defaults to Installed and keeps every plugin-management view reachable through accessible selectors', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'com.acme.installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
        });
        const capabilityState = createMachineCapabilitiesState([installedPlugin]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: capabilityState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockReturnValue(capabilityState);
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'com.acme.installed-plugin': {
                        id: 'com.acme.installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [createPluginDiagnosticRecord({
                    id: 'com.acme.installed-plugin:normalization:capability-missing:0',
                    pluginId: 'com.acme.installed-plugin',
                    severity: 'warning',
                    code: 'plugin_runtime_capability_missing',
                    message: 'Missing actions capability',
                })],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const installedSelector = screen.findByTestId('settings.plugins.management.view:installed');
        const discoverSelector = screen.findByTestId('settings.plugins.management.view:discover');
        const developmentEntry = screen.findRow('settings.plugins.development');
        const diagnosticsEntry = screen.findRow('settings.plugins.diagnostics');

        expect(installedSelector?.props.accessibilityRole).toBe('tab');
        expect(installedSelector?.props.accessibilityState).toMatchObject({ selected: true });
        expect(discoverSelector?.props.accessibilityState).toMatchObject({ selected: false });
        expect(developmentEntry).toBeTruthy();
        expect(diagnosticsEntry).toBeTruthy();
        const taskOrder = screen.tree.root.findAll((node) => [
            'settings.plugins.management.view:installed',
            'settings.plugins.sources',
            'settings.plugins.development',
        ].includes(node.props.testID)).map((node) => node.props.testID);
        expect(taskOrder.indexOf('settings.plugins.management.view:installed')).toBeLessThan(taskOrder.indexOf('settings.plugins.sources'));
        expect(taskOrder.indexOf('settings.plugins.management.view:installed')).toBeLessThan(taskOrder.indexOf('settings.plugins.development'));
        expect(screen.findRow('settings.plugins.marketplace.installed.com.acme.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeFalsy();
        expect(screen.findRow('settings.plugins.registryDiagnostic.plugin_runtime_capability_missing.0')).toBeFalsy();

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.installed.com.acme.installed-plugin')).toBeFalsy();
        // Discover owns search, an explicit refresh row, and source chips. The
        // retired catalog-URL/registries home controls no longer exist.
        const searchInput = screen.findRow('settings.plugins.marketplace.search');
        expect(searchInput).toBeTruthy();
        expect(searchInput?.props.accessibilityLabel).toBe('settingsPlugins.discoverSearchPlaceholder');
        expect(searchInput?.props.value).toBe('');
        expect(findDiscoverSourceFilterIds(screen)).toEqual(['all', 'marketplace:community-npm']);
        // Entering Discover auto-loads the aggregate query: real (empty) search
        // text, no source filter, no client-side catalog fetch.
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            text: '',
            cursor: null,
            filters: { includeUnavailable: true },
        }), expect.any(Object));

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.value).toBe('');
        // Revisiting Discover does not re-query: the aggregate page is acquired
        // once per daemon authority, then the user owns refreshes.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);

        expect(screen.findByTestId('settings.plugins.management.view:activity')).toBeFalsy();
    }, 120_000);

    it('announces marketplace loading and query failures through the single polite Discover status region', async () => {
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
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');

        await act(async () => {
            await flushAsync();
        });

        // Entering Discover starts the aggregate query on its own; loading is
        // announced by the pane's one accessible status row, not by a separate
        // loading row.
        const loadingSummary = screen.findByTestId('settings.plugins.marketplace.discover.status.summary');
        const loadingAnnouncement = closestAccessibleAnnouncementAncestor(loadingSummary);
        expect(loadingAnnouncement?.props.accessible).toBe(true);
        expect(loadingAnnouncement?.props.accessibilityLiveRegion).toBe('polite');
        expect(loadingAnnouncement?.props.accessibilityLabel).toBe('settingsPlugins.discover.status.loading');

        rejectCatalogQuery(new Error('Marketplace query failed'));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        const errorSummary = screen.findByTestId('settings.plugins.marketplace.discover.status.summary');
        const errorAnnouncement = closestAccessibleAnnouncementAncestor(errorSummary);
        expect(errorAnnouncement?.props.accessibilityRole).toBe('alert');
        // The unified status region stays polite even for failures; the retired
        // assertive catalog.error region no longer exists.
        expect(errorAnnouncement?.props.accessibilityLiveRegion).toBe('polite');
        expect(errorAnnouncement?.props.accessibilityLabel)
            .toBe('settingsPlugins.discover.status.errorTitle settingsPlugins.discover.diagnostic.recovery');
        expect(screen.getTextContent()).not.toContain('Marketplace query failed');
    });

    it('keeps degraded-source, diagnostic, and non-installable detail rows traversable outside the single polite status announcement', async () => {
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
        // One stale source with its own diagnostic, one index-level diagnostic,
        // and one listing the stale source blocks: every detail family the
        // status summary only counts.
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult(
            [createMarketplaceCatalogEntry({ pluginId: 'locked-plugin', title: 'Locked Plugin' })],
            {
                freshnessState: 'stale',
                sourceDiagnostics: [{ code: 'source_index_stale', message: 'Source index is stale' }],
                indexDiagnostics: [{ code: 'index_partial', message: 'Index served partial results' }],
            },
        ));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');

        await act(async () => {
            // Entering Discover acquires the aggregate page on its own.
            await flushAsync();
            await flushAsync();
        });

        // One notice per source and one for the index; the raw messages and codes wait behind Details.
        const sourceHealthRow = screen.findByTestId('settings.plugins.marketplace.discover.issue.marketplace:curated');
        const diagnosticRow = screen.findByTestId('settings.plugins.marketplace.discover.issue.index');
        const nonInstallableRow = screen.findByTestId('settings.plugins.marketplace.discover.nonInstallable.marketplace:curated.locked-plugin');
        expect(sourceHealthRow).toBeTruthy();
        expect(diagnosticRow).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.diagnostic.behindTitle(source=Curated Marketplace)');
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.diagnostic.indexTitle');
        expect(screen.getTextContent()).not.toContain('Source index is stale');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover.issue.marketplace:curated.details');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.discover.issue.index.details');
        expect(screen.getTextContent()).toContain('Source index is stale');
        expect(screen.getTextContent()).toContain('settingsPlugins.diagnosticsTechnicalCode(code=source_index_stale)');
        expect(screen.getTextContent()).toContain('settingsPlugins.diagnosticsTechnicalCode(code=index_partial)');
        expect(nonInstallableRow).toBeTruthy();

        // Exactly one polite announcement remains, scoped to the compact
        // summary row, still carrying the aggregate counts.
        const summaryRow = screen.findByTestId('settings.plugins.marketplace.discover.status.summary');
        const announcement = closestAccessibleAnnouncementAncestor(summaryRow);
        expect(announcement?.props.accessible).toBe(true);
        expect(announcement?.props.accessibilityLiveRegion).toBe('polite');
        expect(announcement?.props.accessibilityLabel).not.toContain('settingsPlugins.discover.status.empty');
        expect(announcement?.props.accessibilityLabel).toContain('settingsPlugins.discover.status.nonInstallable');
        expect(announcement?.props.accessibilityLabel).toContain('settingsPlugins.discover.status.partial');

        // Each detail row sits outside the accessible announcement parent, so
        // VoiceOver and TalkBack can traverse the exact failures one by one.
        expect(closestAccessibleAnnouncementAncestor(sourceHealthRow)).toBeNull();
        expect(closestAccessibleAnnouncementAncestor(diagnosticRow)).toBeNull();
        expect(closestAccessibleAnnouncementAncestor(nonInstallableRow)).toBeNull();
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
                phase: 'retained_incumbent',
                occurrenceId: 'occurrence-development-plugin',
                diagnostic: {
                    code: 'plugin_development_watch_warning',
                    message: 'Development watch diagnostic',
                },
            }], [], [{
                kind: 'explicit',
                rootPath: '/plugins/development-plugin',
                trusted: true,
                persisted: true,
            }]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { action: 'test', pluginId: 'development-plugin' } },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

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

        expect(screen.findRow('settings.plugins.management.development.ordinary-path-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.archive-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.empty')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin.action.reload')).toBeFalsy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBeFalsy();
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'test')?.disabled).toBe(false);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'pack')?.disabled).toBe(false);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'unregister')?.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        const createForm = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        createForm.replaceInput({ targetDir: '/workspace/plugins/new-plugin', displayName: 'New Plugin', pluginId: 'acme.new-plugin', ui: 'reactNative' });
        await act(async () => { await createForm.submit(); await flushAsync(); });

        // Submitting the complete scaffold form is the creation decision; no
        // redundant confirmation sits between the author and the daemon.
        expect(modalConfirmMock).not.toHaveBeenCalled();
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
                    ui: 'reactNative',
                },
            },
        }));

        invokeWithAlertsMock.mockClear();
        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'unregister')?.onPress();
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'unregisterDevelopment',
                params: { sourceRootPath: '/plugins/development-plugin' },
            },
        }));

        // The author sees every canonical scaffold surface, including the
        // declarative default shared with the CLI.
        expect(createForm.getFields().find((field) => field.path === 'ui')?.options?.map((option) => option.value)).toEqual(['declarative', 'hostedWeb', 'reactNative']);

        invokeWithAlertsMock.mockClear();
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });
        const plainForm = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        plainForm.replaceInput({ targetDir: '/workspace/plugins/plain-plugin', displayName: 'Plain Plugin', pluginId: 'acme.plain-plugin', ui: 'declarative' });
        await act(async () => { await plainForm.submit(); await flushAsync(); });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'create',
                params: {
                    targetDir: '/workspace/plugins/plain-plugin',
                    displayName: 'Plain Plugin',
                    pluginId: 'acme.plain-plugin',
                    ui: 'declarative',
                },
            },
        }));
        invokeWithAlertsMock.mockClear();

        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'test')?.onPress();
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
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.development.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('settingsPlugins.developmentTestSucceeded');
    });

    it('re-resolves Edit with Agent through the selected daemon before opening an ordinary New Session', async () => {
        const accountScope = { serverId: 'server-a', accountId: 'account-a' } as const;
        activeAccountScopeState.current = accountScope;
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '3.0.0-dev',
            source: {
                kind: 'path',
                locator: '/plugins/development-plugin',
                devWatch: true,
            },
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([developmentPlugin], [{
                pluginId: 'development-plugin',
                sourceRootPath: '/plugins/development-plugin',
                phase: 'active',
                occurrenceId: 'occurrence-development-plugin',
            }]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'edit',
                    pluginId: 'development-plugin',
                    sourceRootPath: '/plugins/current-development-plugin',
                    sessionDirectory: '/plugins/current-development-plugin',
                },
            },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });

        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'editWithAgent')?.onPress();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'edit',
                params: { pluginId: 'development-plugin' },
            },
        }));
        const route = routerPushSpy.mock.calls.at(-1)?.[0] as Readonly<{
            pathname: string;
            params: Readonly<{ draftId: string }>;
        }>;
        expect(route).toEqual({
            pathname: '/new',
            params: { draftId: expect.any(String) },
        });
        expect(readNewSessionDraftFromRepository({ scope: accountScope, draftId: route.params.draftId })).toMatchObject({
            input: '/plugins/current-development-plugin\n\nsettingsPlugins.developmentEditWithAgentPrompt(pluginId=development-plugin)',
            selectedMachineId: 'machine-1',
            targetServerId: 'server-a',
            selectedPath: '/plugins/current-development-plugin',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-1' },
            },
            entryIntent: 'session',
        });
    });

    it('keeps a single-file Edit subject in the prompt while seeding its containing directory', async () => {
        const accountScope = { serverId: 'server-a', accountId: 'account-a' } as const;
        activeAccountScopeState.current = accountScope;
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '3.0.0-dev',
            source: {
                kind: 'path',
                locator: '/plugins/stale-plugin.ts',
                devWatch: true,
            },
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([developmentPlugin], [{
                pluginId: 'development-plugin',
                sourceRootPath: '/plugins/stale-plugin.ts',
                phase: 'active',
                occurrenceId: 'occurrence-development-plugin',
            }]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'edit',
                    pluginId: 'development-plugin',
                    sourceRootPath: '/plugins/current-plugin.ts',
                    sessionDirectory: '/plugins',
                },
            },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });

        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'editWithAgent')?.onPress();
            await flushAsync();
        });

        const route = routerPushSpy.mock.calls.at(-1)?.[0] as Readonly<{
            pathname: string;
            params: Readonly<{ draftId: string }>;
        }>;
        expect(readNewSessionDraftFromRepository({ scope: accountScope, draftId: route.params.draftId })).toMatchObject({
            input: '/plugins/current-plugin.ts\n\nsettingsPlugins.developmentEditWithAgentPrompt(pluginId=development-plugin)',
            selectedMachineId: 'machine-1',
            targetServerId: 'server-a',
            selectedPath: '/plugins',
        });
    });

    it.each([
        ['plugin-not-found', 'Installed plugin was not found'],
        ['plugin-development-source-unavailable', 'Installed plugin is not an admitted development source'],
    ])('does not open New Session when the daemon rejects a stale Edit target with %s', async (code, message) => {
        const developmentPlugin = createInstalledPlugin({
            pluginId: 'development-plugin',
            title: 'Development Plugin',
            version: '3.0.0-dev',
            source: {
                kind: 'path',
                locator: '/plugins/stale-development-plugin',
                devWatch: true,
            },
        });
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([developmentPlugin], [{
                pluginId: 'development-plugin',
                sourceRootPath: '/plugins/stale-development-plugin',
                phase: 'active',
                occurrenceId: 'occurrence-development-plugin',
            }]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: false,
                error: { code, message },
            },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });

        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'editWithAgent')?.onPress();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'edit',
                params: { pluginId: 'development-plugin' },
            },
            alerts: expect.objectContaining({
                errorTitle: 'common.error',
                successMessage: null,
            }),
        }));
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('creates through the deterministic scaffold owner before opening Create with Agent in that plugin root', async () => {
        const accountScope = { serverId: 'server-a', accountId: 'account-a' } as const;
        activeAccountScopeState.current = accountScope;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'create',
                    pluginId: 'acme.agent-plugin',
                    sourceRootPath: '/workspace/plugins/agent-plugin',
                },
            },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.createWithAgent');
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });
        const agentForm = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        agentForm.replaceInput({ targetDir: '/workspace/plugins/agent-plugin', displayName: 'Agent Plugin', pluginId: 'acme.agent-plugin', ui: 'reactNative' });
        await act(async () => { await agentForm.submit(); await flushAsync(); });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'create',
                params: {
                    targetDir: '/workspace/plugins/agent-plugin',
                    displayName: 'Agent Plugin',
                    pluginId: 'acme.agent-plugin',
                    ui: 'reactNative',
                },
            },
        }));
        const route = routerPushSpy.mock.calls.at(-1)?.[0] as Readonly<{
            pathname: string;
            params: Readonly<{ draftId: string }>;
        }>;
        expect(route.pathname).toBe('/new');
        expect(readNewSessionDraftFromRepository({ scope: accountScope, draftId: route.params.draftId })).toMatchObject({
            input: 'settingsPlugins.developmentCreateWithAgentPrompt(pluginId=acme.agent-plugin)',
            selectedMachineId: 'machine-1',
            targetServerId: 'server-a',
            selectedPath: '/workspace/plugins/agent-plugin',
            executionTarget: {
                kind: 'machine',
                target: { serverId: 'server-a', machineId: 'machine-1' },
            },
            entryIntent: 'session',
        });
    });

    it('keeps create pending until the daemon settles and preserves the draft after failure', async () => {
        const deferred = createDeferred();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockImplementationOnce(async () => {
            await deferred.promise;
            return {
                supported: true,
                response: { ok: false, error: { code: 'scaffold_failed', message: 'Could not create scaffold' } },
            };
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
        });
        const form = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        const draft = {
            targetDir: '/workspace/plugins/failed-plugin',
            displayName: 'Failed Plugin',
            pluginId: 'acme.failed-plugin',
            ui: 'declarative',
        };
        form.replaceInput(draft);
        let submitOutcome: Awaited<ReturnType<typeof form.submit>> | undefined;
        await act(async () => {
            void form.submit().then((outcome) => { submitOutcome = outcome; });
            await flushAsync();
        });

        expect(form.isSubmitting()).toBe(true);
        expect(form.isRetired()).toBe(false);
        expect(form.getInput()).toEqual(draft);

        deferred.resolve();
        await act(async () => { await flushAsync(); await flushAsync(); });

        expect(submitOutcome).toEqual({ kind: 'settled', outcome: { ok: false } });
        expect(form.isRetired()).toBe(false);
        expect(form.getInput()).toEqual(draft);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('does not settle create successfully after the selected daemon authority changes', async () => {
        const deferred = createDeferred();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockImplementationOnce(async () => {
            await deferred.promise;
            return {
                supported: true,
                response: {
                    ok: true,
                    result: {
                        action: 'create',
                        pluginId: 'acme.stale-plugin',
                        sourceRootPath: '/workspace/canonical/stale-plugin',
                    },
                },
            };
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const RerenderableDevelopmentScreen = PluginDevelopmentScreen as unknown as React.ComponentType<{ scopeToken: string }>;
        const screen = await renderInAppPanes(React.createElement(RerenderableDevelopmentScreen, { scopeToken: 'machine-1' }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
        });
        const form = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        const draft = {
            targetDir: '/workspace/requested/stale-plugin',
            displayName: 'Stale Plugin',
            pluginId: 'acme.stale-plugin',
            ui: 'declarative',
        };
        form.replaceInput(draft);
        let submitOutcome: Awaited<ReturnType<typeof form.submit>> | undefined;
        await act(async () => {
            void form.submit().then((outcome) => { submitOutcome = outcome; });
            await flushAsync();
        });

        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'machine-2',
        });
        getActiveServerIdMock.mockReturnValue('server-b');
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderableDevelopmentScreen, { scopeToken: 'machine-2' })));
            await flushAsync();
        });
        deferred.resolve();
        await act(async () => { await flushAsync(); await flushAsync(); });

        expect(submitOutcome).toEqual({ kind: 'settled', outcome: { ok: false } });
        expect(form.isRetired()).toBe(false);
        expect(form.getInput()).toEqual(draft);
        expect(screen.findByTestId('settings.plugins.management.development.createSettlement')).toBeFalsy();
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('retains the daemon create result inline and starts development from its exact source root without a success alert', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    ok: true,
                    result: {
                        action: 'create',
                        pluginId: 'acme.created-plugin',
                        sourceRootPath: '/workspace/canonical/created-plugin',
                    },
                },
            })
            .mockResolvedValueOnce({
                supported: true,
                response: {
                    ok: true,
                    result: { action: 'develop', kind: 'committed' },
                },
            });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.create');
            await flushAsync();
        });
        const form = modalShowMock.mock.calls.at(-1)?.[0]?.props?.form as import('@/components/plugins/actions/actionInputForm').ActionInputForm;
        form.replaceInput({
            targetDir: '/workspace/requested/created-plugin',
            displayName: 'Created Plugin',
            pluginId: 'acme.created-plugin',
            ui: 'declarative',
        });
        await act(async () => { await form.submit(); await flushAsync(); await flushAsync(); });

        const settlement = screen.findByTestId('settings.plugins.management.development.createSettlement');
        expect(settlement?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('/workspace/canonical/created-plugin');
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());

        await act(async () => {
            const start = screen.findAllByType('ItemRowActions' as never)
                .flatMap((node) => node.props.actions ?? [])
                .find((action) => action.inlineTestID === 'settings.plugins.management.development.createSettlement.action.startDevelopment');
            expect(start).toBeDefined();
            start.onPress();
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'develop',
                params: { sourceRootPath: '/workspace/canonical/created-plugin' },
            },
        }));
    });

    it('lists a pending change this app never started and lets the present user decide it', async () => {
        // The flagship agent-authored loop: an Agent prepares a plugin change
        // through its Action, the daemon issues a pending id, and nothing in
        // this app ever saw that id. Without this section the change is
        // invisible and expires unanswered, because approving project trust
        // is not delegable to an Agent.
        const refresh = vi.fn();
        const sourceRootPath = '/workspace/plugins/agent-authored';
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [{
                kind: 'reviewRequired', reviewKind: 'projectTrust',
                pendingChangeId: 'pending-agent-1',
                review: { source: { kind: 'path', locator: sourceRootPath } },
            }]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-1',
                    status: {
                        kind: 'reviewRequired', reviewKind: 'projectTrust',
                        pendingChangeId: 'pending-agent-1',
                        review: { source: { kind: 'path', locator: sourceRootPath } },
                    },
                },
            },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                kind: 'committed',
                pluginId: 'community-plugin',
                desiredGeneration: 'generation-1',
                appliedGeneration: 'generation-1',
                pendingSurfaces: [],
            });
        modalConfirmMock.mockResolvedValueOnce(true);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // Listed on the plugin settings surface itself, not behind a tab: a
        // decision waiting on this user is attention, not one view's content.
        expect(screen.findRow('settings.plugins.management.pendingChanges.pending-agent-1')).toBeTruthy();

        const approve = findPendingChangeAction(screen, 'pending-agent-1', 'review');
        expect(approve?.disabled).toBe(false);
        await act(async () => {
            approve?.onPress();
            await flushAsync();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        // The listed row is a projection that can be minutes old, so the change
        // is re-read at its owner before the user is asked anything.
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'changeStatus',
                params: { pendingChangeId: 'pending-agent-1' },
            },
        }));
        expect(modalConfirmMock).toHaveBeenCalledWith(
            'settingsPlugins.developmentTrustProjectSourceTitle',
            expect.stringContaining(sourceRootPath),
            expect.objectContaining({ confirmText: 'settingsPlugins.developmentTrustProjectSourceConfirm' }),
        );
        // Same canonical decision seam the CLI and this screen's own flows use.
        // Remembered project trust is the only code-trust decision.
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledOnce();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-agent-1',
                decision: 'installAndTrust', optionalSelections: [],
            },
        }));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('labels pending decision actions truthfully before any review has been seen', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [
                createCommunityInstallReviewResult('pending-agent-8').change,
            ]),
            refresh,
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.pendingChanges.pending-agent-8')).toBeTruthy();
        // The row action opens the full install-and-trust review; nothing has
        // been approved yet, so it must not be labeled as an approval.
        const review = findPendingChangeAction(screen, 'pending-agent-8', 'review');
        expect(review?.title).toBe('settingsPlugins.pendingChangeReviewAction');
        expect(review?.subtitle).toBe('settingsPlugins.pendingChangesReviewHint');
        // Reject discards the change without ever opening the review, so its
        // copy must not claim that it shows one.
        const reject = findPendingChangeAction(screen, 'pending-agent-8', 'reject');
        expect(reject?.title).toBe('approvals.reject');
        expect(reject?.subtitle).toBe('settingsPlugins.pendingChangeRejectHint');
    });

    it('rejects a pending change through the same daemon change owner', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [
                createCommunityInstallReviewResult('pending-agent-2').change,
            ]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-2',
                    status: createCommunityInstallReviewResult('pending-agent-2').change,
                },
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'cancelled' });
        modalConfirmMock.mockResolvedValueOnce(true);

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.pendingChanges.pending-agent-2')).toBeTruthy();
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-2', 'reject')?.onPress();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        // A rejection is a consequential machine-scoped operation: the exact
        // server and machine it discards the change on are named before the
        // user confirms, the same facts every other confirmation on this
        // screen carries.
        expect(modalConfirmMock).toHaveBeenCalledWith(
            'approvals.reject',
            'settingsPlugins.pendingChangeConfirmRejectBody(machine=machine-1,server=Server A)',
            expect.objectContaining({ confirmText: 'approvals.reject', cancelText: 'common.cancel', destructive: true }),
        );
        // A rejection never fabricates approval evidence: it is the daemon's
        // own cancel decision, carrying no actor evidence at all.
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: { v: 1, pendingChangeId: 'pending-agent-2', decision: 'cancel' },
        }));
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.pending.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('renders the change owner\'s own answer when a listed change is no longer decidable', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [
                createCommunityInstallReviewResult('pending-agent-3').change,
            ]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-3',
                    status: { kind: 'expired' },
                },
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-3', 'review')?.onPress();
            await flushAsync();
            await flushAsync();
        });

        // A stale row must never become an approval. The owner said the change
        // is gone, so nothing is decided and the user is told the truth.
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsPlugins.pendingChangeExpired');
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('presents a rejoin whose change the owner already committed as applied, not as a failure', async () => {
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [
                createCommunityInstallReviewResult('pending-agent-4').change,
            ]),
            refresh,
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-4',
                    status: {
                        kind: 'terminal',
                        pendingChangeId: 'pending-agent-4',
                        result: { kind: 'committed', pluginId: 'community-plugin' },
                    },
                },
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-4', 'review')?.onPress();
            await flushAsync();
            await flushAsync();
        });

        // The change owner answered `committed` — possibly decided by another
        // client while this rejoin was in flight. The applied state is the
        // success answer; re-presenting it as a failure would be untrue.
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        const settlement = screen.findByTestId('settings.plugins.pending.operationSettlement');
        expect(settlement?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('settingsPlugins.pendingChangeCommitted');
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.error', expect.anything());
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });

    it('reconciles an ambiguous approve decision against the exact original target instead of reporting failure', async () => {
        const initialState = createMachineCapabilitiesState([], [], [
            createCommunityInstallReviewResult('pending-agent-5').change,
        ]);
        let authoritativeState: MachineCapabilitiesState = initialState;
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: initialState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockImplementation(() => authoritativeState);
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = createMachineCapabilitiesState([
                createInstalledPlugin({
                    pluginId: 'community-plugin',
                    title: 'Community Plugin',
                    version: '2.0.0',
                }),
            ]);
        });
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-5',
                    status: createCommunityInstallReviewResult('pending-agent-5').change,
                },
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'outcomeUnknown', pluginId: 'community-plugin' });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-5', 'review')?.onPress();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        // Approving is commit-intended: the daemon may have applied the change
        // after the decision left this device. The answer is reconciled on the
        // exact original target only — the same path an ordinary install or
        // update already uses — and a proven landing is a success, never the
        // old false "was not applied" failure.
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({ bypassCache: true }),
        }));
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.pending.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.error', 'settingsPlugins.pendingChangeFailed');
    });

    it('presents the truthful unresolved copy when an ambiguous approve cannot be proven on the exact target', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'community-plugin',
            title: 'Community Plugin',
            version: '1.0.0',
        });
        const capabilityState = createMachineCapabilitiesState([installedPlugin], [], [
            createCommunityInstallReviewResult('pending-agent-6').change,
        ]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: capabilityState,
            refresh: vi.fn(),
        });
        // The authoritative re-read answers with the unchanged 1.0.0 record, so
        // the reviewed 2.0.0 commit cannot be proven.
        getMachineCapabilitiesCacheStateMock.mockReturnValue(capabilityState);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-6',
                    status: createCommunityInstallReviewResult('pending-agent-6').change,
                },
            },
        });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'outcomeUnknown', pluginId: 'community-plugin' });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-6', 'review')?.onPress();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        // Unprovable is not failed: the change may have committed, so the user
        // gets the truthful unresolved answer naming the exact target instead
        // of a failure that invites deciding the same change again.
        expect(modalAlertMock).toHaveBeenCalledWith(
            'settingsPlugins.pluginChangeOutcomeUnknownTitle',
            'settingsPlugins.pluginChangeOutcomeUnknownBody(action=settingsPlugins.installAndTrust,name=Community Plugin,machine=machine-1,server=Server A)',
        );
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.error', 'settingsPlugins.pendingChangeFailed');
    });

    it('reconciles a terminal outcome-unknown rejoin against the exact target before the unresolved copy', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'community-plugin',
            title: 'Community Plugin',
            version: '1.0.0',
        });
        const capabilityState = createMachineCapabilitiesState([installedPlugin], [], [
            createCommunityInstallReviewResult('pending-agent-7').change,
        ]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: capabilityState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockReturnValue(capabilityState);
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: true,
                result: {
                    action: 'changeStatus',
                    pendingChangeId: 'pending-agent-7',
                    status: {
                        kind: 'terminal',
                        pendingChangeId: 'pending-agent-7',
                        result: { kind: 'outcomeUnknown', pluginId: 'community-plugin' },
                    },
                },
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await act(async () => {
            findPendingChangeAction(screen, 'pending-agent-7', 'review')?.onPress();
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        // A terminal outcome-unknown answer is not "was not applied": the exact
        // original target is re-read first, and the unresolved copy is the
        // truthful presentation when the landing still cannot be proven.
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({ bypassCache: true }),
        }));
        expect(modalAlertMock).toHaveBeenCalledWith(
            'settingsPlugins.pluginChangeOutcomeUnknownTitle',
            'settingsPlugins.pluginChangeOutcomeUnknownBody(action=settingsPlugins.installAndTrust,name=community-plugin,machine=machine-1,server=Server A)',
        );
        expect(modalAlertMock).not.toHaveBeenCalledWith(
            'common.error',
            'settingsPlugins.pendingChangeFailed',
        );
    });

    it('accepts an exact single-file development locator only after saving the inline draft', async () => {
        const sourceFilePath = '/workspace/plugins/one-file-plugin.mjs';
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        invokeWithAlertsMock.mockResolvedValueOnce({
            supported: true,
            response: {
                ok: true,
                result: { action: 'develop', kind: 'committed' },
            },
        });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.develop');
            await flushAsync();
            await flushAsync();
        });

        const sourceField = screen.findByTestId('settings.plugins.development.sourceRootPath');
        expect(sourceField).toBeTruthy();
        await act(async () => {
            sourceField?.props.onChangeText(sourceFilePath);
        });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(modalPromptMock).not.toHaveBeenCalled();
        await act(async () => {
            screen.pressByTestId('settings.plugins.development.sourceRootPath.save');
            await flushAsync();
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'develop',
                params: { sourceRootPath: sourceFilePath },
            },
        }));
    });

    it('cancels the inline development source draft without trusting or installing it', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]), refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => { screen.pressByTestId('settings.plugins.management.development.action.develop'); });
        expect(screen.findByTestId('settings.plugins.development.sourceRootPath')).toBeTruthy();
        await act(async () => {
            screen.findByTestId('settings.plugins.development.sourceRootPath')?.props.onChangeText('/workspace/plugins/draft.mjs');
        });
        await act(async () => { screen.pressByTestId('settings.plugins.development.sourceRootPath.cancel'); });
        expect(screen.findByTestId('settings.plugins.development.sourceRootPath')).toBeNull();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(modalConfirmMock).not.toHaveBeenCalled();
    });

    it('names the exact project source in the single remembered trust decision', async () => {
        const refresh = vi.fn();
        const sourceRootPath = '/workspace/plugins/local-authoring';
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh,
        });
        const developResult = {
            action: 'develop',
            sourceRootPath,
            change: {
                kind: 'reviewRequired', reviewKind: 'projectTrust',
                pendingChangeId: 'pending-source-root-1',
                review: { source: { kind: 'path', locator: sourceRootPath } },
            },
        };
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: developResult },
        });
        machineRpcWithServerScopeMock
            .mockResolvedValueOnce({
                kind: 'committed',
                pluginId: 'community-plugin',
                desiredGeneration: 'generation-1',
                appliedGeneration: 'generation-1',
                pendingSurfaces: [],
            });
        modalConfirmMock.mockResolvedValueOnce(true);

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.development.action.develop')?.props.disabled).toBeFalsy();
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.develop');
            await flushAsync();
        });
        await act(async () => {
            screen.changeTextByTestId('settings.plugins.development.sourceRootPath', sourceRootPath);
        });
        await act(async () => {
            screen.pressByTestId('settings.plugins.development.sourceRootPath.save');
            await flushAsync();
            await flushAsync();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'develop',
                params: { sourceRootPath },
            },
        }));
        // The security payload is the path itself, and a path is a location on
        // ONE machine reached through ONE server: `/Users/me/project` exists on
        // several of them, so a trust decision naming only the path cannot tell
        // the user whose filesystem the daemon will build and run code from.
        expect(modalConfirmMock).toHaveBeenCalledWith(
            'settingsPlugins.developmentTrustProjectSourceTitle',
            'settingsPlugins.developmentTrustProjectSourceBody(path=/workspace/plugins/local-authoring,machine=machine-1,server=Server A)',
            expect.objectContaining({ confirmText: 'settingsPlugins.developmentTrustProjectSourceConfirm' }),
        );
        // Project/source trust is remembered and directly commits the prepared
        // plugin. It never opens a second code-trust dialog for the same code.
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledOnce();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-source-root-1',
                decision: 'installAndTrust', optionalSelections: [],
            },
        }));
        expect(refresh).toHaveBeenCalledTimes(1);

        // Declining project trust cancels the pending change.
        machineRpcWithServerScopeMock.mockClear();
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ kind: 'cancelled' });
        modalConfirmMock.mockResolvedValueOnce(false);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.develop');
            await flushAsync();
        });
        await act(async () => {
            screen.changeTextByTestId('settings.plugins.development.sourceRootPath', sourceRootPath);
        });
        await act(async () => {
            screen.pressByTestId('settings.plugins.development.sourceRootPath.save');
            await flushAsync();
            await flushAsync();
        });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: { v: 1, pendingChangeId: 'pending-source-root-1', decision: 'cancel' },
        }));
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('fails the local development affordance closed when the daemon does not advertise the develop action', async () => {
        const staleState: LoadedMachineCapabilitiesState = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        [MARKETPLACE_CAPABILITY_ID]: {
                            ok: true,
                            checkedAt: Date.now(),
                            data: { installedPlugins: [], developmentStatus: { roots: [], plugins: [] } },
                        },
                    },
                },
            },
        };
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: staleState, refresh: vi.fn() });

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.development.action.develop')?.props.disabled).toBe(true);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.development.action.develop');
            await flushAsync();
        });
        expect(modalPromptMock).not.toHaveBeenCalled();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
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
            phase: 'active',
            occurrenceId: 'occurrence-development-plugin',
        }]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: { ...errorState, status: 'error' },
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDevelopmentScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBe(true);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'test')?.disabled).toBe(true);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'pack')?.disabled).toBe(true);

        await act(async () => {
            findDevelopmentPluginAction(screen, 'development-plugin', 'pack')?.onPress();
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
            phase: 'active',
            occurrenceId: 'occurrence-development-plugin',
        }]);
        useMachineCliDetectionTargetMock.mockImplementation(() => machineTarget);
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({
            state: capabilityState,
            refresh: vi.fn(),
        }));
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);

        const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
        const RerenderablePluginDevelopmentScreen = PluginDevelopmentScreen as unknown as React.ComponentType<{
            capabilityRevision: number;
        }>;
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginDevelopmentScreen, {
            capabilityRevision: 1,
        }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();

        endpointConnectivityState.status = 'offline';
        capabilityState = { status: 'idle' };
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginDevelopmentScreen, {
                capabilityRevision: 2,
            })));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.development.readOnlySnapshot')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.development-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.management.development.action.create')?.props.disabled).toBe(true);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'test')?.disabled).toBe(true);
        expect(findDevelopmentPluginAction(screen, 'development-plugin', 'pack')?.disabled).toBe(true);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('reports a projection failure instead of a disconnect and retries the projection from the notice', async () => {
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
            supported: false,
            reason: 'error',
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const notice = screen.findRow('settings.plugins.marketplace.readOnlySnapshot');
        expect(notice).toBeTruthy();
        expect(notice?.props.accessibilityLabel).not.toBe('settingsPlugins.readOnlySnapshot');
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot-retry')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        });
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.readOnlySnapshot-retry');
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
    });

    it('keeps direct marketplace administration RPCs available when only the merged projection fails', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [],
        });
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: false,
            reason: 'error',
        });

        const { PluginMarketplaceSourcesScreen } = await import('./PluginMarketplaceSourcesScreen');
        await renderInAppPanes(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        expect(machineNpmRegistryProfilesGetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
    });

    it.each([
        ['Home', async () => (await import('./PluginSettingsHomeScreen')).PluginSettingsHomeScreen],
        ['Detail', async () => (await import('./detail/PluginDetailScreen')).PluginDetailScreen],
    ])('refreshes daemon-owned marketplace sources when the %s screen regains focus', async (_name, loadScreen) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [],
        });
        screenFocusState.value = true;
        const Screen = await loadScreen() as unknown as React.ComponentType<{
            pluginId?: string;
            revision?: number;
        }>;
        const props = _name === 'Detail' ? { pluginId: 'missing-plugin', revision: 1 } : { revision: 1 };
        const screen = await renderInAppPanes(React.createElement(Screen, props));
        await act(async () => { await flushAsync(); await flushAsync(); });
        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledTimes(1);

        screenFocusState.value = false;
        screen.tree.update(inAppPanes(React.createElement(Screen, { ...props, revision: 2 })));
        await act(async () => { await flushAsync(); });
        machineMarketplaceSourceRegistryGetMock.mockClear();

        screenFocusState.value = true;
        screen.tree.update(inAppPanes(React.createElement(Screen, { ...props, revision: 3 })));
        await act(async () => { await flushAsync(); await flushAsync(); });

        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledTimes(1);
        expect(machineMarketplaceSourceRegistryGetMock).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
    });

    it('keeps direct marketplace administration disabled when the exact daemon target is unreachable', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        // Exact daemon reachability belongs to the machine-inventory owner,
        // not to the active server endpoint. Make the selected machine itself
        // offline so this exercises the same authority production dispatch
        // re-resolves immediately before issuing an administration RPC.
        machineAdministrationFixture.activeMachines[0]!.active = false;
        machineAdministrationFixture.activeMachines[0]!.activeAt = 0;
        syncAdministrationTargetBoundary();

        const { PluginMarketplaceSourcesScreen } = await import('./PluginMarketplaceSourcesScreen');
        const screen = await renderInAppPanes(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceSourceRegistryGetMock).not.toHaveBeenCalled();
        expect(machineNpmRegistryProfilesGetMock).not.toHaveBeenCalled();
        expect(screen.findRow('settings.plugins.sources.add')?.props.disabled).toBe(true);
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
                projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
            };
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const RerenderablePluginSettingsHomeScreen = PluginSettingsHomeScreen as unknown as React.ComponentType<{
            capabilityRevision: number;
        }>;
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
            capabilityRevision: 1,
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
        const staleOnlineToggle = findInstalledRowToggle(screen, 'installed-plugin');
        expect(staleOnlineToggle).toMatchObject({ action: 'disable', disabled: false });
        const staleOnlineDisable = staleOnlineToggle?.toggle as (() => void);

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
            await flushAsync();
            await flushAsync();
        });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
        // Entering Discover auto-loads the aggregate page; a listing for
        // something already installed gets NO lifecycle action row here.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(screen.findRow(discoverListingTestID('installed-plugin'))).toBeTruthy();
        expect(findDiscoverListingActions(screen, 'installed-plugin').map((action) => action.id)).toEqual(['manage']);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:installed');
        });

        machineMarketplaceSourceRegistryGetMock.mockClear();
        machineMarketplaceIndexQueryMock.mockClear();
        const selectedMachine = machineAdministrationFixture.activeMachines[0];
        if (!selectedMachine) throw new Error('Expected the selected machine fixture.');
        // Execution authority comes from the selected machine's live presence,
        // not the active endpoint status. Retire this exact target while
        // retaining its selected scope, then restore it below to exercise the
        // reconnect freshness transition.
        selectedMachine.active = false;
        selectedMachine.activeAt = 0;
        await act(async () => {
            syncAdministrationTargetBoundary();
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 2,
            })));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.management.view:installed')?.props.accessibilityState).toMatchObject({ selected: true });

        // The retained row stays visible, but its one inline control (the
        // Enabled switch) is inert while the machine is away.
        const disconnectedToggle = findInstalledRowToggle(screen, 'installed-plugin');
        expect(disconnectedToggle).toMatchObject({ action: 'disable', disabled: true });

        await act(async () => {
            disconnectedToggle?.toggle();
            staleOnlineDisable();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(machineMarketplaceIndexQueryMock).not.toHaveBeenCalled();
        expect(machineMarketplaceSourceRegistryGetMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const detailScreen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        expect(detailScreen.findRow('settings.plugins.detail.readOnlySnapshot')).toBeTruthy();
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.reload')).toBeFalsy();
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.disable')?.props.disabled).toBe(true);
        expect(findDetailMenuAction(detailScreen, 'installed-plugin', 'rollback')?.disabled).toBe(true);
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.uninstall')?.props.disabled).toBe(true);
        expect(detailScreen.findRow('settings.plugins.detail.installed-plugin.action.forgetTrust')?.props.disabled).toBe(true);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        // While the snapshot is read-only, Discover makes no query of its own:
        // search stays non-editable, refresh is disabled, and the aggregate
        // query is neither issued nor repeated.
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.editable).toBe(false);
        expect(canSubmitDiscoverSearch(screen)).toBe(false);
        expect(machineMarketplaceIndexQueryMock).not.toHaveBeenCalled();

        selectedMachine.active = true;
        selectedMachine.activeAt = Date.now();
        await act(async () => {
            syncAdministrationTargetBoundary();
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 3,
            })));
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
        const reconnectCapabilityCacheKeySalt = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0]?.cacheKeySalt;
        expect(reconnectCapabilityCacheKeySalt).not.toBe(initialCapabilityCacheKeySalt);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);

        freshCapabilitiesReady = true;
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 4,
            })));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeTruthy();
        expect(canSubmitDiscoverSearch(screen)).toBe(false);
        expect(machineMarketplaceIndexQueryMock).not.toHaveBeenCalled();

        await act(async () => {
            resolveReconnectProjection?.();
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.editable).toBe(true);
        // With daemon truth current again, Discover acquires the aggregate page
        // by itself — once — and the installed listing still gets no lifecycle
        // row; update belongs to the installed record.
        expect(canSubmitDiscoverSearch(screen)).toBe(true);
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            text: '',
            cursor: null,
            filters: { includeUnavailable: true },
        }), expect.any(Object));
        expect(findDiscoverListingActions(screen, 'installed-plugin').map((action) => action.id)).toEqual(['manage']);
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:installed');
        });
        expect(findInstalledRowToggle(screen, 'installed-plugin')).toMatchObject({ action: 'disable', disabled: false });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', {
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-a',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'server-a', accountId: 'account-a' } }),
        });

        // Update is offered from the installed record itself (its page's `⋯`
        // menu) once the daemon is current again — never re-created as a
        // Discover-row action.
        const reconnectedDetail = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });
        expect(findDetailMenuAction(reconnectedDetail, 'installed-plugin', 'update')?.disabled).toBe(false);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('navigates installed plugin rows to a detail route instead of inlining plugin details on the home screen', async () => {
        deviceTypeOverride.value = 'phone';
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
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

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
            pluginId: 'com.acme.installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
            diagnostics: [{ code: 'install.note', message: 'Installed via host-owned flow' }],
        });
        const refresh = vi.fn();
        const capabilityState = createMachineCapabilitiesState([installedPlugin]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: capabilityState,
            refresh,
        });
        getMachineCapabilitiesCacheStateMock.mockReturnValue(capabilityState);
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'com.acme.installed-plugin': {
                        id: 'com.acme.installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                    },
                },
                agentsById: {},
                actionsById: {
                    'com.acme.installed-plugin.refresh': {
                        id: 'com.acme.installed-plugin.refresh',
                        pluginId: 'com.acme.installed-plugin',
                        occurrenceId: '12',
                        title: 'Refresh installed plugin',
                        description: 'Refresh plugin-owned resources',
                        scopes: ['settings'],
                        surfaces: ['ui'],
                        execution: { target: 'daemon' },
                        placementBindings: ['detailsPanel'],
                        dangerLevel: 'safe',
                        available: true,
                    },
                    'com.acme.installed-plugin.runSetup': {
                        id: 'com.acme.installed-plugin.runSetup',
                        pluginId: 'com.acme.installed-plugin',
                        occurrenceId: '12',
                        title: 'Run setup',
                        description: 'Run plugin setup',
                        scopes: ['settings'],
                        surfaces: ['ui'],
                        execution: { target: 'daemon' },
                        placementBindings: ['detailsPanel'],
                        dangerLevel: 'safe',
                        available: true,
                    },
                },
                toolsById: {},
                commandsById: {},
                resourcesById: {
                    'com.acme.installed-plugin.prompt': {
                        id: 'com.acme.installed-plugin.prompt',
                        pluginId: 'com.acme.installed-plugin',
                        resourceKind: 'prompt',
                        path: 'resources/review.md',
                        digest: 'sha256:prompt',
                        contentType: 'text/markdown',
                    },
                },
                diagnostics: [
                    createPluginDiagnosticRecord({
                        id: 'com.acme.installed-plugin:normalization:warning:0',
                        pluginId: 'com.acme.installed-plugin',
                        severity: 'warning',
                        code: 'registry.warning',
                        message: 'Registry rebuilt with warnings',
                    }),
                    createPluginDiagnosticRecord({
                        id: 'com.acme.installed-plugin:activation:info:0',
                        pluginId: 'com.acme.installed-plugin',
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'com.acme.installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
        }));
        // One title: the page header names the plugin; the native header is never retitled with it.
        expect(navigationSetOptionsSpy).not.toHaveBeenCalledWith(expect.objectContaining({
            headerTitle: 'Installed Plugin',
        }));
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.id')).toBeTruthy();
        expect(screen.getTextContent()).toContain('trusted');
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.contribution.action.com.acme.installed-plugin.refresh')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.contribution.resource.com.acme.installed-plugin.prompt')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.action.reload')).toBeFalsy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.action.disable')).toBeTruthy();
        expect(findDetailMenuAction(screen, 'com.acme.installed-plugin', 'rollback')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.action.uninstall')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.action.forgetTrust')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Plugin activated');
        expect(screen.getTextContent()).toContain('Registry rebuilt with warnings');
        await act(async () => {
            toggleDetailEnabled(screen, 'settings.plugins.detail.com.acme.installed-plugin.action.disable');
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'disable',
                params: expect.objectContaining({ pluginId: 'com.acme.installed-plugin' }),
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        expect(findDetailMenuAction(screen, installedPlugin.pluginId, 'rollback')).toBeFalsy();
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
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: 'installed-plugin',
            capabilityRevision: 1,
        }));
        await act(async () => {
            await flushAsync();
        });
        const staleRollbackPress = findDetailMenuAction(screen, 'installed-plugin', 'rollback')?.onSelect;
        expect(staleRollbackPress).toBeTypeOf('function');

        rollbackAvailability = 'unavailable';
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: 'installed-plugin',
                capabilityRevision: 2,
            })));
            await flushAsync();
        });
        expect(findDetailMenuAction(screen, 'installed-plugin', 'rollback')).toBeFalsy();

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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        modalConfirmMock.mockResolvedValueOnce(false);
        await act(async () => {
            pressDetailLifecycleAction(screen, installedPlugin.pluginId, method);
            await flushAsync();
        });
        // A plugin change lands on ONE machine reached through ONE server. The
        // confirmation must name that target: the same wording on a different
        // selected machine is a different, irreversible action.
        expect(modalConfirmMock).toHaveBeenCalledWith(
            confirmationTitle,
            `settingsPlugins.pluginChangeConfirmBody(action=${confirmationTitle},name=Installed Plugin,machine=machine-1,server=Server A)`,
            expect.objectContaining({
                confirmText: confirmationTitle,
                cancelText: 'common.cancel',
            }),
        );
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();

        modalConfirmMock.mockResolvedValueOnce(true);
        await act(async () => {
            pressDetailLifecycleAction(screen, installedPlugin.pluginId, method);
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
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
            const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
            }));
            await act(async () => {
                await flushAsync();
                pressDetailLifecycleAction(screen, installedPlugin.pluginId, method);
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
            expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
            expect(screen.findByTestId('settings.plugins.installed.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
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
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.installed.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
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
        // Reconciliation could not read authoritative truth, so the uninstall
        // may already have landed. Reporting a definite failure here invites a
        // retry of a change that is not necessarily outstanding.
        expect(modalAlertMock).not.toHaveBeenCalledWith(
            'common.error',
            'settingsPlugins.marketplaceChangeDecisionFailed',
        );
        expect(modalAlertMock).toHaveBeenCalledWith(
            'settingsPlugins.pluginChangeOutcomeUnknownTitle',
            'settingsPlugins.pluginChangeOutcomeUnknownBody(action=settingsPlugins.uninstall,name=Installed Plugin,machine=machine-1,server=Server A)',
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
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
            scopeToken: 'machine-1',
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
        });
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledTimes(1);

        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'machine-2',
        });
        getActiveServerIdMock.mockReturnValue('server-b');
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
                scopeToken: 'machine-2',
            })));
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
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/acme.hooks',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {
                    'acme.hooks.settings': {
                        id: 'acme.hooks.settings',
                        pluginId: 'acme.hooks',
                        version: 1,
                        title: 'Hooks settings',
                        scope: { kind: 'daemon' },
                        target: { kind: 'plugin' },
                        presentation: { sections: [], subagentSections: [] },
                        fields: [
                            {
                                id: 'endpoint',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'string' },
                                valueType: 'string',
                                control: 'text',
                                displayKey: 'Endpoint URL',
                                descriptionKey: 'Used when hook handlers call the remote API.',
                                capabilityGates: [],
                                permissionGates: [],
                                secretCustody: null,
                                redaction: 'none',
                                clearWhenEmpty: 'persist',
                                order: 1,
                            },
                            {
                                id: 'apiToken',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'string' },
                                valueType: 'string',
                                control: 'password',
                                displayKey: 'API token',
                                descriptionKey: 'Stored locally for this plugin.',
                                capabilityGates: [],
                                permissionGates: [],
                                secretCustody: 'daemon',
                                redaction: 'secret',
                                clearWhenEmpty: 'omit',
                                order: 2,
                            },
                            {
                                id: 'enabled',
                                kind: 'settings.field',
                                version: '1.0.0',
                                valueSchema: { type: 'boolean' },
                                valueType: 'boolean',
                                control: 'switch',
                                displayKey: 'Enable hooks',
                                capabilityGates: [],
                                permissionGates: [],
                                secretCustody: null,
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
                                valueType: 'string',
                                control: 'textarea',
                                displayKey: 'Notes',
                                capabilityGates: [],
                                permissionGates: [],
                                secretCustody: null,
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
        let currentRevision = 0;
        machineRpcWithServerScopeMock.mockImplementation(async (input: Readonly<{
            method?: string;
            payload?: Readonly<{
                fieldId?: string;
                mutation?: Readonly<{ kind: 'set'; value: unknown }> | Readonly<{ kind: 'delete' }>;
                pluginId?: string;
                secretId?: string;
            }>;
        }>) => {
            if (input.method === 'daemon.plugins.settings.get') {
                return {
                    protocolVersion: 1,
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    revision: String(currentRevision),
                    values: currentValues,
                    redactedKeys: ['apiToken'],
                };
            }
            if (input.method === 'daemon.plugins.settings.set') {
                const mutation = input.payload?.mutation;
                if (!mutation || mutation.kind !== 'set') {
                    throw new Error('Expected a canonical Settings set mutation.');
                }
                currentValues = {
                    ...currentValues,
                    [String(input.payload?.fieldId)]: mutation.value,
                };
                currentRevision += 1;
                return {
                    protocolVersion: 1,
                    pluginId: 'acme.hooks',
                    scope: { kind: 'daemon' },
                    revision: String(currentRevision),
                    values: currentValues,
                    redactedKeys: ['apiToken'],
                };
            }
            if (input.method === 'daemon.plugins.secrets.status') {
                return {
                    protocolVersion: 1,
                    pluginId: input.payload?.pluginId ?? 'acme.hooks',
                    secretId: input.payload?.secretId ?? 'apiToken',
                    state: 'configured',
                    revision: 'secret-0',
                };
            }
            if (input.method === 'daemon.plugins.secrets.set') {
                return {
                    protocolVersion: 1,
                    pluginId: input.payload?.pluginId ?? 'acme.hooks',
                    secretId: input.payload?.secretId ?? 'apiToken',
                    state: 'configured',
                    revision: 'secret-1',
                };
            }
            throw new Error(`Unexpected RPC method: ${input.method ?? '<missing>'}`);
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'acme.hooks' }));

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
                serverIdentityId: 'srv_identity-a',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'endpoint',
                mutation: { kind: 'set', value: 'https://api.changed.test' },
                expectedRevision: '0',
            },
            {
                serverIdentityId: 'srv_identity-a',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                scope: { kind: 'daemon' },
                fieldId: 'enabled',
                mutation: { kind: 'set', value: false },
                expectedRevision: '1',
            },
        ]);
        expect(machineRpcWithServerScopeMock.mock.calls
            .map(([input]) => input as { method?: string; payload?: Record<string, unknown> })
            .filter((input) => input.method === 'daemon.plugins.secrets.set')
            .map((call) => call.payload)).toEqual([{
                serverIdentityId: 'srv_identity-a',
                machineId: 'machine-1',
                pluginId: 'acme.hooks',
                secretId: 'apiToken',
                value: 'new-secret-token',
                expectedRevision: 'secret-0',
            }]);
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
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [],
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.header')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.installed-plugin.id')).toBeTruthy();
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
                    },
                },
                agentsById: {},
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
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.id')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
    });

    it('clears machine-scoped projection and Discover query state when the selected machine changes', async () => {
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

        getActiveServerIdMock.mockReturnValue('server-a');
        const machineOneCapabilityState = createMachineCapabilitiesState([installedPlugin]);
        const machineTwoCapabilityState = createMachineCapabilitiesState([installedPlugin]);
        useMachineCapabilitiesCacheMock.mockImplementation(({ machineId }: { machineId: string | null }) => ({
            state: machineId === 'machine-1' ? machineOneCapabilityState : machineTwoCapabilityState,
            refresh: vi.fn(),
        }));
        getMachineCapabilitiesCacheStateMock.mockImplementation((machineId: string) => (
            machineId === 'machine-1' ? machineOneCapabilityState : machineTwoCapabilityState
        ));
        machineMarketplaceSourceRegistryGetMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1' ? curatedMarketplaceRegistry : null
        ));
        machineMarketplaceIndexQueryMock.mockImplementation(async (machineId: string) => (
            machineId === 'machine-1'
                ? createDaemonMarketplaceIndexResult([
                    createMarketplaceCatalogEntry({ pluginId: 'sample-plugin', title: 'Sample Plugin', description: 'Descriptor served for machine-1', version: '1.0.0' }),
                ])
                : createDaemonMarketplaceIndexResult([])
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
                            },
                        },
                        agentsById: {},
                        actionsById: {},
                        toolsById: {},
                        commandsById: {},
                        resourcesById: {},
                        diagnostics: [],
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
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        await selectPluginManagementView(screen, 'discover');

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        // Discover acquired the aggregate page for machine-1 and shows it.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.anything(), expect.any(Object));
        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', {
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-a',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'server-a', accountId: 'account-a' } }),
        });

        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'machine-2',
        });
        getActiveServerIdMock.mockReturnValue('server-b');

        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-2',
            })));
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', {
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-b',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'server-b', accountId: 'account-a' } }),
        });
        // The machine-1 Discover page and its controls are cleared, never shown
        // as machine-2 truth; machine-2's projection is unsupported, so no new
        // aggregate query is issued and the stale listing is gone.
        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.value).toBe('');
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
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
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
            scopeToken: 'machine-1',
        }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const findRollbackAction = () => findDetailMenuAction(screen, installedPlugin.pluginId, 'rollback');

        await act(async () => {
            findRollbackAction()?.onSelect();
            await flushAsync();
        });
        expect(findRollbackAction()?.disabled).toBe(true);

        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'machine-2',
        });
        getActiveServerIdMock.mockReturnValue('server-b');
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
                scopeToken: 'machine-2',
            })));
            await flushAsync();
            await flushAsync();
        });

        expect(findRollbackAction()?.disabled).not.toBe(true);
        await act(async () => {
            findRollbackAction()?.onSelect();
            await flushAsync();
        });
        expect(findRollbackAction()?.disabled).toBe(true);

        machineOneAction.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(findRollbackAction()?.disabled).toBe(true);

        machineTwoAction.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(findRollbackAction()?.disabled).not.toBe(true);
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
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const findDisableAction = () => {
            const toggle = findInstalledRowToggle(screen, 'installed-plugin');
            return toggle?.action === 'disable' ? toggle : undefined;
        };
        const actionBeforeBusyRender = findDisableAction();
        expect(actionBeforeBusyRender?.disabled).toBe(false);

        act(() => {
            actionBeforeBusyRender?.toggle();
            actionBeforeBusyRender?.toggle();
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
                }>>>;
                agentsById: Record<string, never>;
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
        const screen = await renderInAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
            scopeToken: 'machine-1',
        }));

        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.generation')).toBeFalsy();

        clearMachineAdministrationTargetFixture();
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-none',
            })));
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
                    },
                },
                agentsById: {},
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
            pluginId: 'com.acme.installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });
        const capabilityState = createMachineCapabilitiesState([installedPlugin]);
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: capabilityState,
            refresh: vi.fn(),
        });
        getMachineCapabilitiesCacheStateMock.mockReturnValue(capabilityState);
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(null);
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 12,
                installedPackagesById: {
                    'com.acme.installed-plugin': {
                        id: 'com.acme.installed-plugin',
                        displayName: 'Installed Plugin',
                        version: '1.0.0',
                        enabled: true,
                        occurrenceId: '12',
                        source: {
                            kind: 'path',
                            locator: '/plugins/installed-plugin',
                        },
                    },
                },
                agentsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                diagnostics: [
                    createPluginDiagnosticRecord({
                        id: 'com.acme.installed-plugin:normalization:capability-missing:0',
                        pluginId: 'com.acme.installed-plugin',
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing actions capability',
                    }),
                    createPluginDiagnosticRecord({
                        id: 'com.acme.installed-plugin:normalization:capability-missing:1',
                        pluginId: 'com.acme.installed-plugin',
                        severity: 'warning',
                        code: 'plugin_runtime_capability_missing',
                        message: 'Missing resources capability',
                    }),
                ],
            },
        });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: 'com.acme.installed-plugin',
        }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.diagnostic.plugin_runtime_capability_missing.0')).toBeTruthy();
        expect(screen.findRow('settings.plugins.detail.com.acme.installed-plugin.diagnostic.plugin_runtime_capability_missing.1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Missing actions capability');
        expect(screen.getTextContent()).toContain('Missing resources capability');
    });

    it('opens a listing for inspection without installing and starts the existing exact-source action from its detail', async () => {
        deviceTypeOverride.value = 'phone';
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        const page = createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'new-plugin', title: 'New Plugin', version: '0.1.0', description: 'Inspect before installing.' }),
        ]);
        machineMarketplaceIndexQueryMock.mockResolvedValue(page);
        invokeWithAlertsMock.mockResolvedValue({ supported: true, response: {
            ok: false, error: { code: 'install_unavailable', message: 'The package is currently unavailable.' },
        } });
        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await selectPluginManagementView(screen, 'discover');
        await act(async () => { await flushAsync(); await flushAsync(); });

        await act(async () => { screen.pressRow(discoverListingTestID('new-plugin')); });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/(app)/settings/plugins/listing',
            params: { sourceId: 'marketplace:curated', pluginId: 'new-plugin' },
        }));
        const { PluginListingScreen } = await import('./listing/PluginListingScreen');
        const detail = await renderInAppPanes(React.createElement(PluginListingScreen, { sourceId: 'marketplace:curated', pluginId: 'new-plugin' }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        // The listing page re-reads exactly this source-qualified listing.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            filters: { sourceIds: ['marketplace:curated'], pluginIds: ['new-plugin'], includeUnavailable: true },
        }), expect.any(Object));
        expect(detail.getTextContent()).toContain('Inspect before installing.');
        expect(detail.getTextContent()).toContain('Curated Marketplace');
        await act(async () => {
            detail.pressByTestId('settings.plugins.listing.install');
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: { sourceId: 'marketplace:curated', pluginId: 'new-plugin', packageName: '@acme/new-plugin' },
            },
        }));
    });

    it('queries the aggregate daemon index for Discover and preserves the machine-installed inventory', async () => {
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
            createMarketplaceCatalogEntry({ pluginId: 'new-plugin', title: 'New Plugin', version: '0.1.0' }),
        ]));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

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
        expect(screen.getTextContent()).toContain('Installed via host-owned flow');
        // An incompatible install says why in its footer and keeps its switch in
        // the same place (there is nothing to review until Happier is updated);
        // Review replaces the switch only for a plugin that needs a decision.
        expect(screen.findAllByTestId('settings.plugins.marketplace.installed.installed-plugin.fix')).toHaveLength(0);
        expect(screen.findAll((node) => String(node.props?.testID ?? '')
            .startsWith('settings.plugins.marketplace.installed.installed-plugin.action.')).length).toBeGreaterThan(0);

        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // Browse is the active view (the pane no longer carries its own
        // subtitle; the page's one purpose line describes Plugins).
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState)
            .toMatchObject({ selected: true });

        // All is one aggregate daemon query: real (empty) search text, no
        // source filter, and no client-side catalog fetch anywhere.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            text: '',
            cursor: null,
            filters: { includeUnavailable: true },
        }), expect.any(Object));
        expect(screen.findRow(discoverListingTestID('installed-plugin'))).toBeTruthy();
        expect(screen.findRow(discoverListingTestID('new-plugin'))).toBeTruthy();
        // An installed listing shows its installed state instead of lifecycle
        // actions; an uninstalled one gets the full Install & Trust review.
        expect(findDiscoverListingActions(screen, 'installed-plugin').map((action) => action.id)).toEqual(['manage']);
        // Missing package copy stays missing. The pane-level explanation is
        // shown once in the toolbar; it is neither repeated nor replaced with a
        // synthetic per-plugin description.
        expect(screen.getTextContent()).not.toContain('deps.ui.notInstalled');
        expect(findDiscoverInstallAction(screen, 'installed-plugin')).toBeUndefined();
        expect(findDiscoverInstallAction(screen, 'new-plugin')).toBeTruthy();
    });

    it('offers the built-in community npm source filter exactly once and narrows the aggregate query per chip', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [
                { id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 },
                { id: 'marketplace:community-npm', title: 'Community npm', sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100', enabled: true, origin: 'user', addedAtMs: 2, updatedAtMs: 2 },
            ],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([]));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');

        expect(findDiscoverSourceFilterIds(screen).filter((id) => id === 'marketplace:community-npm')).toHaveLength(1);
        expect(findDiscoverSourceFilterIds(screen).filter((id) => id === 'marketplace:curated')).toHaveLength(1);

        // A chip narrows the same one aggregate query before acquisition; All
        // sends no source filter at all.
        await act(async () => {
            selectDiscoverSource(screen, 'marketplace:curated');
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            text: '',
            filters: { sourceIds: ['marketplace:curated'], includeUnavailable: true },
        }), expect.any(Object));
        await act(async () => {
            selectDiscoverSource(screen, 'all');
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            filters: { includeUnavailable: true },
        }), expect.any(Object));
    });

    it('coalesces source changes to the latest query intent after the current query settles', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [
                { id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 },
            ],
        });
        let settleInitial!: (result: MarketplaceIndexQueryResultV1) => void;
        machineMarketplaceIndexQueryMock
            .mockImplementationOnce(() => new Promise((resolve) => { settleInitial = resolve; }))
            .mockResolvedValue(createDaemonMarketplaceIndexResult([]));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
        });

        act(() => {
            selectDiscoverSource(screen, 'marketplace:curated');
            selectDiscoverSource(screen, 'marketplace:community-npm');
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);

        settleInitial(createDaemonMarketplaceIndexResult([]));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(2);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            filters: { sourceIds: ['marketplace:community-npm'], includeUnavailable: true },
        }), expect.any(Object));
    });

    it('accepts a same-revision continuation, then keeps shown rows and clears a changed-revision cursor', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'page-one-plugin', title: 'Page One Plugin', description: 'Descriptor on the loaded revision', version: '1.0.0' }),
            ], { revision: 1, nextCursor: 'cursor-1' }))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'page-two-plugin', title: 'Page Two Plugin', description: 'Descriptor from the loaded revision', version: '2.0.0' }),
            ], { revision: 1, nextCursor: 'cursor-2' }))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'changed-plugin', title: 'Changed Plugin', description: 'Descriptor from an incompatible revision', version: '2.1.0' }),
            ], { revision: 2, nextCursor: 'cursor-3' }))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'fresh-plugin', title: 'Fresh Plugin', description: 'Descriptor from the refreshed revision', version: '3.0.0' }),
            ], { revision: 2 }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow(discoverListingTestID('page-one-plugin'))).toBeTruthy();
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen.pressByTestId('settings.plugins.marketplace.loadMore');
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow(discoverListingTestID('page-one-plugin'))).toBeTruthy();
        expect(screen.findRow(discoverListingTestID('page-two-plugin'))).toBeTruthy();
        expect(screen.findAllHostsByTestId('settings.plugins.marketplace.loadMore')).toHaveLength(1);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            screen.pressByTestId('settings.plugins.marketplace.loadMore');
            await flushAsync();
            await flushAsync();
        });

        // Last-known-good rows stay; the incompatible page is discarded — a
        // revision mismatch is not an empty catalog.
        expect(screen.findRow(discoverListingTestID('page-one-plugin'))).toBeTruthy();
        expect(screen.findRow(discoverListingTestID('page-two-plugin'))).toBeTruthy();
        expect(screen.findRow(discoverListingTestID('changed-plugin'))).toBeFalsy();
        // The mismatched page's cursor is gone, so the stale list cannot request
        // another incompatible continuation.
        expect(screen.findAllHostsByTestId('settings.plugins.marketplace.loadMore')).toHaveLength(0);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(3);
        // The mismatch is announced by the pane's one accessible status row;
        // its label carries the exact error key like every other status fact.
        const mismatchSummary = screen.findByTestId('settings.plugins.marketplace.discover.status.summary');
        expect(closestAccessibleAnnouncementAncestor(mismatchSummary)?.props.accessibilityLabel).toBe(
            'settingsPlugins.discover.status.errorTitle settingsPlugins.discoverRevisionChanged',
        );

        // Recovery stays with the user's own fresh query from cursor null.
        await act(async () => {
            submitDiscoverSearch(screen);
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(4);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            cursor: null,
        }), expect.any(Object));
        expect(screen.findRow(discoverListingTestID('fresh-plugin'))).toBeTruthy();
        expect(screen.findAllHostsByTestId('settings.plugins.marketplace.loadMore')).toHaveLength(0);
    });

    it('keeps the shown daemon listings while the search draft changes until the user searches', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'sample-plugin', title: 'Sample Plugin', description: 'Descriptor for the shown page', version: '1.0.0' }),
            ]))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'replacement-plugin', title: 'Replacement Plugin', description: 'Descriptor for the searched page', version: '2.0.0' }),
            ]));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeTruthy();
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);

        // Typing only drafts the next query: nothing re-queries, and the list
        // the user is already reading stays on screen.
        await act(async () => {
            screen.findRow('settings.plugins.marketplace.search')?.props.onChangeText('replacement');
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeTruthy();
        // The controls now describe a different query than the shown list.
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.status.stale');

        await act(async () => {
            submitDiscoverSearch(screen);
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(2);
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            text: 'replacement',
            cursor: null,
        }), expect.any(Object));
        expect(screen.findRow(discoverListingTestID('replacement-plugin'))).toBeTruthy();
        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeFalsy();
    });

    it('names a search that found nothing and clears it back to every listing', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]),
            refresh: vi.fn(),
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'marketplace:curated', title: 'Curated Marketplace', sourceUrl: 'https://marketplace.example.test/catalog.json', enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1 }],
        });
        machineMarketplaceIndexQueryMock
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'sample-plugin', title: 'Sample Plugin', description: 'Shown first', version: '1.0.0' }),
            ]))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([]))
            .mockResolvedValueOnce(createDaemonMarketplaceIndexResult([
                createMarketplaceCatalogEntry({ pluginId: 'sample-plugin', title: 'Sample Plugin', description: 'Shown first', version: '1.0.0' }),
            ]));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => { await flushAsync(); await flushAsync(); });
        // Nothing searched yet: no "no match" line, whatever the result count.
        expect(screen.findRow('settings.plugins.marketplace.discover.noMatch')).toBeFalsy();

        await act(async () => {
            screen.findRow('settings.plugins.marketplace.search')?.props.onChangeText('jira');
        });
        await act(async () => {
            submitDiscoverSearch(screen);
            await flushAsync();
            await flushAsync();
        });
        expect(screen.findRow('settings.plugins.marketplace.discover.noMatch')).toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.noMatch');

        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.discover.clearSearch');
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceIndexQueryMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            text: '',
            cursor: null,
        }), expect.any(Object));
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.value).toBe('');
        expect(screen.findRow('settings.plugins.marketplace.discover.noMatch')).toBeFalsy();
        expect(screen.findRow(discoverListingTestID('sample-plugin'))).toBeTruthy();
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
                        kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
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
                                integrityBasis: 'expected',
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
                            rawCredentialAccess: [],
                            requestInterceptors: [],
                            compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
                            updatePolicy: 'allowed',
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

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow(discoverListingTestID('new-plugin'))).toBeTruthy();
        const installAction = findDiscoverInstallAction(screen, 'new-plugin');
        expect(installAction).toBeTruthy();

        await act(async () => {
            installAction?.onPress();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: {
                    sourceId: 'marketplace:curated',
                    pluginId: 'new-plugin',
                    packageName: '@acme/new-plugin',
                },
            },
        }));
        // The install review is the shared dialog fed by the exact serialized
        // protocol review, named to the exact machine and server it grants on.
        expect(modalShowMock).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({
                title: 'settingsPlugins.marketplaceInstallReviewTitle(name=New Plugin,version=0.1.0)',
            }),
            props: expect.objectContaining({
                review: expect.objectContaining({
                    pluginId: 'new-plugin',
                    packageIdentity: { name: '@acme/new-plugin', version: '0.1.0' },
                }),
                target: { machine: 'machine-1', server: 'Server A' },
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: {
                v: 1,
                pendingChangeId: 'pending-curated-1',
                decision: 'installAndTrust',
                optionalSelections: [],
            },
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            request: expect.objectContaining({ bypassCache: true }),
        }));
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.discover.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
    });

    it.each([
        ['continues', true],
        ['cancels', false],
    ] as const)('asks for the registry selection the daemon names and, when the user %s, prepares the same install again', async (_name, proceed) => {
        const teamSourceUrl = 'https://team.example.test/index.json';
        const privateOrigin = 'https://npm.acme.example';
        // The daemon's answer for a listing whose private registry this machine
        // has no profile or source binding for, exactly as the RPC returns it.
        const registryRequired = {
            action: 'install',
            pluginId: 'community-plugin',
            change: {
                kind: 'registryProfileRequired',
                registryOrigin: privateOrigin,
                packageName: '@acme/community-plugin',
                registryProfileId: null,
            },
        };
        const review = createCommunityInstallReviewResult('pending-private-1');
        review.change.review.updateChannel = {
            kind: 'npm',
            packageName: '@acme/community-plugin',
            registryOrigin: privateOrigin,
            marketplaceSource: { id: 'marketplace:team', kind: 'user', sourceUrl: teamSourceUrl },
        } as typeof review.change.review.updateChannel;
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        invokeWithAlertsMock
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: registryRequired } })
            .mockResolvedValueOnce({ supported: true, response: { ok: true, result: review } });
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            kind: 'committed',
            pluginId: 'community-plugin',
            desiredGeneration: 'generation-1',
            appliedGeneration: 'generation-1',
            pendingSurfaces: [],
        });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue({
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [{
                id: 'marketplace:team', title: 'Team catalog', sourceUrl: teamSourceUrl,
                enabled: true, origin: 'user', addedAtMs: 1, updatedAtMs: 1,
            }],
        });
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({ pluginId: 'community-plugin', title: 'Community Plugin', version: '2.0.0' }),
        ], {
            sourceId: 'marketplace:team',
            sourceTitle: 'Team catalog',
            sourceUrl: teamSourceUrl,
            sourceKind: 'user',
            reviewStatus: 'unreviewed',
            registryOrigin: privateOrigin,
            artifactAccessState: 'unverified-profile',
        }));
        const shownRegistrySelections: unknown[] = [];
        const reviewModal = modalShowMock.getMockImplementation();
        modalShowMock.mockImplementation((config: Readonly<{
            props?: Readonly<{ requirement?: unknown; onResolve?: (value: unknown) => void }>;
        }>) => {
            if (config.props?.requirement) {
                shownRegistrySelections.push(config.props);
                config.props.onResolve?.(proceed);
                return 'plugin-registry-selection-modal';
            }
            return reviewModal?.(config as never);
        });

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // The listing stays installable and says which registry it needs.
        expect(screen.getTextContent())
            .toContain(`settingsPlugins.discover.registrySelectionRequired(origin=${privateOrigin})`);
        const installAction = findDiscoverInstallAction(screen, 'community-plugin', 'marketplace:team');
        expect(installAction?.disabled).toBe(false);

        await act(async () => {
            installAction?.onPress();
            await flushAsync();
            await flushAsync();
        });

        expect(shownRegistrySelections).toEqual([expect.objectContaining({
            requirement: { registryOrigin: privateOrigin, packageName: '@acme/community-plugin', registryProfileId: null },
            pluginName: 'Community Plugin',
            sourceId: 'marketplace:team',
            target: { machine: 'machine-1', server: 'Server A' },
        })]);
        const installRequest = {
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: { sourceId: 'marketplace:team', pluginId: 'community-plugin', packageName: '@acme/community-plugin' },
            },
        };
        if (!proceed) {
            // Cancel ends the action: nothing is requested again and no review opens.
            expect(invokeWithAlertsMock).toHaveBeenCalledTimes(1);
            expect(modalShowMock).toHaveBeenCalledTimes(1);
            expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
            return;
        }
        expect(invokeWithAlertsMock).toHaveBeenCalledTimes(2);
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(1, expect.objectContaining(installRequest));
        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(2, expect.objectContaining(installRequest));
        // The re-prepared change reaches the one Install and Trust review.
        expect(modalShowMock).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({
                title: 'settingsPlugins.marketplaceInstallReviewTitle(name=Community Plugin,version=2.0.0)',
            }),
        }));
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.plugins.install.review.decide',
            payload: expect.objectContaining({ pendingChangeId: 'pending-private-1', decision: 'installAndTrust' }),
        }));
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
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        const communityRow = screen.findRow(discoverListingTestID('community-plugin', 'marketplace:community-npm'));
        expect(communityRow).toBeTruthy();
        // The Browse card's byline names the publisher and the source together.
        expect(screen.getTextContent()).toContain('Acme · Community npm');
        // The card footer names the review state; only a withdrawal warns (a dot).
        // Unreviewed stays a quiet fact: the Install & Trust review carries the
        // access decision.
        expect(screen.findByTestId('settings.plugins.marketplace.reviewStatus.marketplace:community-npm.community-plugin'))
            .toBeTruthy();
        expect(screen.findByTestId('settings.plugins.marketplace.reviewStatus.marketplace:community-npm.community-plugin:dot'))
            .toBeFalsy();
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.reviewStatus.unreviewed');
        const communityInstallAction = findDiscoverInstallAction(screen, 'community-plugin', 'marketplace:community-npm');
        expect(communityInstallAction).toBeTruthy();
        expect(communityInstallAction?.accessibilityLabel).toBe(
            'settingsPlugins.installAndTrust. Community Plugin. Community npm',
        );

        modalShowMock.mockImplementationOnce(() => 'plugin-install-review-modal');
        await act(async () => {
            communityInstallAction?.onPress();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'install',
                params: {
                    sourceId: 'marketplace:community-npm',
                    pluginId: 'community-plugin',
                    // The npm package name is not derivable from the manifest
                    // plugin id, so the listing's own coordinate must travel.
                    packageName: '@acme/community-plugin',
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
                review: PluginInstallationReview;
                onResolve: (result: Readonly<{
                    approved: boolean;
                    optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
                }>) => void;
            }>>;
            props: Readonly<{
                review: PluginInstallationReview;
                onResolve: (result: Readonly<{
                    approved: boolean;
                    optionalSelections: readonly Readonly<{ accessId: string; selected: boolean }>[];
                }>) => void;
            }>;
        }>;
        expect(reviewModalConfig.props.review).toMatchObject({
            pluginId: 'community-plugin',
            packageIdentity: { name: '@acme/community-plugin', version: '2.0.0' },
            requiredHostAccess: [expect.objectContaining({ capability: 'network' })],
        });
        const reviewModal = await renderInAppPanes(React.createElement(reviewModalConfig.component, {
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
            findDiscoverInstallAction(screen, 'community-plugin', 'marketplace:community-npm')?.onPress();
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

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'community-plugin' }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // Update starts from the installed record itself (its page's `⋯`
        // menu); Discover never advertised a lifecycle row for something
        // already installed.
        const updateAction = findDetailMenuAction(screen, 'community-plugin', 'update');
        expect(updateAction).not.toBeNull();
        expect(updateAction?.disabled).not.toBe(true);
        await act(async () => {
            updateAction?.onSelect();
            await flushAsync();
        });

        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: {
                id: MARKETPLACE_CAPABILITY_ID,
                method: 'update',
                params: {
                    pluginId: 'community-plugin',
                },
            },
            alerts: expect.objectContaining({ successMessage: null }),
        }));
        expect(modalShowMock).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({
                title: 'settingsPlugins.marketplaceInstallReviewTitle(name=Community Plugin,version=2.0.0)',
            }),
            props: expect.objectContaining({
                review: expect.objectContaining({
                    pluginId: 'community-plugin',
                    packageIdentity: { name: '@acme/community-plugin', version: '2.0.0' },
                }),
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
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.installed.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('reconciles an ambiguous update against the installed record the update owner advanced, not the catalog version', async () => {
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
        // The canonical update owner selected the newest compatible version, which
        // is not the version this catalog listing advertises.
        prefetchMachineCapabilitiesMock.mockImplementationOnce(async () => {
            authoritativeState = createMachineCapabilitiesState([{
                ...installedPlugin,
                version: '1.4.0',
            }]);
        });
        invokeWithAlertsMock.mockResolvedValueOnce({ supported: false, reason: 'error' });

        const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'community-plugin' }));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        const updateAction = findDetailMenuAction(screen, 'community-plugin', 'update');
        expect(updateAction).not.toBeNull();
        await act(async () => {
            updateAction?.onSelect();
            await flushAsync();
        });
        expect(invokeWithAlertsMock).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ method: 'update', params: { pluginId: 'community-plugin' } }),
        }));

        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', expect.anything());
        expect(screen.findByTestId('settings.plugins.installed.operationSettlement')?.props.accessibilityLiveRegion).toBe('polite');
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.error', expect.anything());
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
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // The listing is not silently dropped: it surfaces as a non-installable
        // row with its reason, and nothing installable or mutating appears.
        expect(screen.findRow(discoverListingTestID('new-plugin'))).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.marketplace.discover.nonInstallable.marketplace:curated.new-plugin')).toBeTruthy();
        expect(findDiscoverInstallAction(screen, 'new-plugin')).toBeUndefined();
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
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // All is the unfiltered aggregate query: the daemon decides what a
        // withdrawal means, no source filter is sent from the client.
        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            filters: { includeUnavailable: true },
        }), expect.any(Object));
        const withdrawnRow = screen.findRow(discoverListingTestID('withdrawn-plugin'));
        expect(withdrawnRow).toBeTruthy();
        // The listing's own footer status carries the withdrawal, with the
        // warning dot, rather than a second warning line or a separate row.
        expect(screen.findByTestId('settings.plugins.marketplace.reviewStatus.marketplace:curated.withdrawn-plugin:dot'))
            .toBeTruthy();
        expect(screen.getTextContent()).toContain('settingsPlugins.discover.reviewStatus.withdrawn');
        // The warning never becomes authority over installed code: Discover
        // renders no install (or any lifecycle) action for the installed listing.
        expect(findDiscoverListingActions(screen, 'withdrawn-plugin').map((action) => action.id)).toEqual(['manage']);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('routes installed-row enable and disable through the host capability', async () => {
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

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        // Enable/disable live on the installed row (its Enabled switch);
        // Discover renders no lifecycle actions for installed listings at all.
        const disableAction = findInstalledRowToggle(screen, 'existing-plugin');
        const enableAction = findInstalledRowToggle(screen, 'disabled-plugin');
        expect(disableAction).toMatchObject({ action: 'disable', disabled: false });
        expect(enableAction).toMatchObject({ action: 'enable', disabled: false });

        await act(async () => {
            disableAction?.toggle();
            await flushAsync();
        });

        await act(async () => {
            enableAction?.toggle();
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
        // Discover is the one aggregate daemon query; the retired client-side
        // catalog-URL loader no longer exists, and the daemon's own listing for
        // the other source still must not offer Install & Trust for code this
        // machine already has installed and trusted.
        machineMarketplaceIndexQueryMock.mockResolvedValue(createDaemonMarketplaceIndexResult([
            createMarketplaceCatalogEntry({
                pluginId: 'existing-plugin',
                title: 'Existing Plugin',
                description: 'Descriptor from a different catalog source',
                version: '9.9.9',
                sourceUrl: 'https://catalog-b.example.test/entries/existing-plugin.json',
                packageUrl: 'https://catalog-b.example.test/plugins/existing-plugin.tgz',
            }),
        ], {
            sourceId: 'marketplace:other',
            sourceTitle: 'Other Marketplace',
            sourceUrl: 'https://catalog-b.example.test/catalog.json',
        }));

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        await selectPluginManagementView(screen, 'discover');
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(machineMarketplaceIndexQueryMock).toHaveBeenCalledTimes(1);
        expect(screen.findRow(discoverListingTestID('existing-plugin', 'marketplace:other'))).toBeTruthy();
        expect(findDiscoverInstallAction(screen, 'existing-plugin', 'marketplace:other')).toBeUndefined();
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
                    },
                },
                agentsById: {},
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

        const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        const installedAction = findInstalledRowToggle(screen, 'installed-plugin');
        const otherAction = findInstalledRowToggle(screen, 'other-plugin');
        expect(installedAction).toMatchObject({ action: 'disable', disabled: false });
        expect(otherAction).toMatchObject({ action: 'disable', disabled: false });

        await act(async () => {
            installedAction?.toggle();
            await flushAsync();
        });

        expect(findInstalledRowToggle(screen, 'installed-plugin')?.disabled).toBe(true);
        expect(findInstalledRowToggle(screen, 'other-plugin')?.disabled).toBe(false);

        deferred.resolve();
        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
    });
});

describe('PluginMarketplaceSourcesScreen', () => {
    it('keeps unread Sources unavailable until the exact machine returns an authoritative registry', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        const machine = machineAdministrationFixture.activeMachines[0]!;
        machine.active = false;
        machine.activeAt = 0;
        syncAdministrationTargetBoundary();
        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1', schemaVersion: 1,
            sources: [{ id: 'user-known', title: 'Known source', sourceUrl: 'https://plugins.example.test/index.json', origin: 'user', enabled: true, addedAtMs: 1, updatedAtMs: 1 }],
        };
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(registry);
        const { PluginMarketplaceSourcesScreen } = await import('./PluginMarketplaceSourcesScreen');
        const RerenderableSources = PluginMarketplaceSourcesScreen as React.ComponentType<{ revision: number }>;
        const screen = await renderInAppPanes(React.createElement(RerenderableSources, { revision: 1 }));
        await act(async () => { await flushAsync(); });
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.unavailable')).toBeTruthy();
        expect(machineMarketplaceSourceRegistryGetMock).not.toHaveBeenCalled();

        machine.active = true;
        machine.activeAt = Date.now();
        await act(async () => {
            syncAdministrationTargetBoundary();
            screen.tree.update(inAppPanes(React.createElement(RerenderableSources, { revision: 2 })));
            await flushAsync(); await flushAsync();
        });
        expect(screen.findRow('settings.plugins.sources.source.user-known')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.unavailable')).toBeNull();
        machineMarketplaceSourceRegistryGetMock.mockRejectedValueOnce(new Error('read failed'));
        screenFocusState.value = false;
        await act(async () => { screen.tree.update(inAppPanes(React.createElement(RerenderableSources, { revision: 3 }))); });
        screenFocusState.value = true;
        await act(async () => {
            screen.tree.update(inAppPanes(React.createElement(RerenderableSources, { revision: 4 })));
            await flushAsync(); await flushAsync();
        });
        expect(screen.findRow('settings.plugins.sources.source.user-known')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.retry')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        machineMarketplaceSourceRegistryGetMock.mockResolvedValueOnce({ ...registry, sources: [] });
        await act(async () => { screen.pressRow('settings.plugins.sources.retry'); await flushAsync(); });
        expect(screen.findRow('settings.plugins.sources.empty')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.source.user-known')).toBeNull();

        setMachineAdministrationTargetFixture({ serverIdentityId: 'srv_identity-b', serverId: 'server-b', machineId: 'machine-2' });
        const replacement = machineAdministrationFixture.machineListByServerId['server-b']![0]!;
        replacement.active = false;
        replacement.activeAt = 0;
        await act(async () => {
            syncAdministrationTargetBoundary();
            screen.tree.update(inAppPanes(React.createElement(RerenderableSources, { revision: 5 })));
            await flushAsync();
        });
        expect(screen.findRow('settings.plugins.sources.empty')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.unavailable')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.source.user-known')).toBeNull();
    });

    it('keeps Community npm read-only and mutates only user sources through the canonical registry operations', async () => {
        const registry: MarketplaceSourceRegistryV1 = {
            t: 'happier_marketplace_source_registry_v1',
            schemaVersion: 1,
            sources: [
                {
                    id: 'curated', title: 'Curated', sourceUrl: 'https://curated.example/index.json',
                    enabled: true, origin: 'curated', addedAtMs: 1, updatedAtMs: 1,
                },
                {
                    id: 'user', title: 'My source', sourceUrl: 'https://mine.example/index.json',
                    enabled: true, origin: 'user', addedAtMs: 1, updatedAtMs: 1,
                },
            ],
        };
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
        machineMarketplaceSourceRegistryGetMock.mockResolvedValue(registry);
        // The op's own settlement shape: a parsed registry snapshot on success
        // (or `outcomeUnknown` after the mutation was issued), never a raw registry.
        machineMarketplaceSourceRegistryMutateMock.mockImplementation(async () => ({ status: 'success' as const, registry }));

        const { PluginMarketplaceSourcesScreen } = await import('./PluginMarketplaceSourcesScreen');
        const screen = await renderInAppPanes(React.createElement(PluginMarketplaceSourcesScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });

        const communityNpmRow = screen.findRow('settings.plugins.sources.communityNpm');
        expect(communityNpmRow).toBeTruthy();
        expect(communityNpmRow?.props.accessibilityLabel).toBe(
            'settingsPlugins.sourceAdministration.communityTitle. settingsPlugins.sourceAdministration.communitySubtitle',
        );
        expect(communityNpmRow?.props.onPress).toBeUndefined();
        expect(screen.findRow('settings.plugins.sources.source.curated')).toBeTruthy();
        expect(screen.findRow('settings.plugins.sources.remove.curated')).toBeNull();
        expect(screen.findRow('settings.plugins.sources.remove.user')).toBeTruthy();

        await act(async () => {
            screen.findByTestId('settings.plugins.sources.enabled.user')?.props.onValueChange(false);
            await flushAsync();
        });
        expect(machineMarketplaceSourceRegistryMutateMock).toHaveBeenCalledWith(
            'machine-1',
            { kind: 'setEnabled', sourceId: 'user', enabled: false },
            { serverId: 'server-a' },
        );

        // The current editor keeps the address editable until Save. The daemon derives the
        // display title, and Edit stays the owner of optional metadata.
        await act(async () => {
            screen.pressRow('settings.plugins.sources.add');
            await flushAsync();
        });
        const address = screen.findByTestId('settings.plugins.sources.draft.sourceUrl');
        expect(address).toBeTruthy();
        expect(machineMarketplaceSourceRegistryMutateMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            address?.props.onChangeText('https://new.example/index.json');
        });
        expect(screen.findByTestId('settings.plugins.sources.draft.sourceUrl')?.props.value).toBe('https://new.example/index.json');
        await act(async () => {
            screen.pressByTestId('settings.plugins.sources.draft.save');
            await flushAsync();
            await flushAsync();
        });
        expect(machineMarketplaceSourceRegistryMutateMock).toHaveBeenLastCalledWith(
            'machine-1',
            { kind: 'upsert', input: { sourceUrl: 'https://new.example/index.json', origin: 'user', enabled: true } },
            { serverId: 'server-a' },
        );
        expect(screen.findByTestId('settings.plugins.sources.draft.sourceUrl')).toBeNull();
    });
});
