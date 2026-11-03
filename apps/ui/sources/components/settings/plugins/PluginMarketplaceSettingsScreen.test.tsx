import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavigationContext } from '@react-navigation/native';

import type { PluginDiagnosticRecordV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { InstalledPluginCapabilityEntryV1 } from '@happier-dev/protocol/capabilities';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
    clearDaemonMergedProjectionCacheForTests,
    loadDaemonMergedProjectionCacheEntry,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { flattenTestStyle, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
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
        updatePolicy?: InstalledPluginCapabilityEntryV1['install']['updatePolicy'];
        trust?: InstalledPluginCapabilityEntryV1['install']['trust'];
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
// The external Home Action response is the lifecycle boundary. Admission,
// Account capture, confirmation and mounted execution remain production code.
const lifecycleActionBoundary = vi.hoisted(() => vi.fn());
const refreshMachineCapabilitiesMock = vi.hoisted(() => vi.fn());
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

// Static destination imports retain the navigation boundary before the Settings
// helper is configured. Register the canonical router factory for those imports.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: '/settings/plugins',
        router: { push: value => routerPushSpy(value) },
        navigation: { setOptions: (options: Readonly<Record<string, unknown>>) => navigationSetOptionsSpy(options) },
    }).module;
});

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
        // The canonical Home harness adopts the URL-derived device id. Keep
        // that real predecessor alias on this presentation fixture so genuine
        // credential writes resolve to the same portable Home identity.
        legacyServerIds: ['server-a.example.test'],
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
                legacyServerIds: ['server-b.example.test'],
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
                            developmentActions: { create: true },
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

type DiscoverListingAction = Readonly<{
    id: string;
    title: string;
    accessibilityLabel?: string;
    subtitle?: string;
    disabled: boolean;
    onPress: () => void;
}>;




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




function findDiscoverSourceFilter(screen: Awaited<ReturnType<typeof renderSettingsView>>): ReactTestInstance | null {
    return screen.findAll((node) => node.props?.testID === 'settings.plugins.marketplace.sourceFilter'
        && Array.isArray(node.props.items))[0] ?? null;
}

/** The source choices the Browse filter offers, "all" first. */
function findDiscoverSourceFilterIds(screen: Awaited<ReturnType<typeof renderSettingsView>>): readonly string[] {
    return (findDiscoverSourceFilter(screen)?.props.items ?? []).map((item: { id: string }) => item.id);
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
        const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            // List rows mount without the grid's measured viewport. Supply the
            // read subscription the page actually uses for its device preference.
            useLocalSetting: createUseLocalSettingMock({ values: {
                pluginsCollectionViewV1: { installed: 'list', discover: 'list' },
            } }),
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

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 1,
}));

vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createLiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const storage = createLiveStorageStoreMock(() => ({
        ...machineAdministrationFixture.storageState,
        settingsScope: activeAccountScopeState.current,
    }));
    return { storage, getStorage: () => storage };
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (...args: unknown[]) => useMachineCapabilitiesCacheMock(...args),
    getMachineCapabilitiesCacheState: (...args: unknown[]) => getMachineCapabilitiesCacheStateMock(...args),
    prefetchMachineCapabilities: (...args: unknown[]) => prefetchMachineCapabilitiesMock(...args),
}));

vi.mock('@/sync/store/hooks', async () => ({
    // Early runtime imports retain the hooks facade before the Settings helper
    // configures its storage boundary; give both paths the same canonical defaults.
    ...(await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}),
    useEndpointStatus: () => endpointConnectivityState.status,
    useLocalSetting: (await import('@/dev/testkit/mocks/storage')).createUseLocalSettingMock({ values: {
        pluginsCollectionViewV1: { installed: 'list', discover: 'list' },
    } }),
    useMachineCliDetectionTarget: (...args: unknown[]) => useMachineCliDetectionTargetMock(...args),
    useMachineRecordValues: () => machineAdministrationFixture.activeMachines,
    useMachineRecordListsByServerId: () => machineAdministrationFixture.machineListByServerId,
    useMachineListStatusByServerId: () => machineAdministrationFixture.machineListStatusByServerId,
    useIsDataReady: () => true,
    useActiveServerAccountScope: () => activeAccountScopeState.current,
    useActiveServerAccountScopeLifetime: () => activeAccountScopeState.current ? activeAccountLifetime : null,
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

afterEach(async () => {
    // Retire mounted readers before clearing their HTTP/credential boundaries.
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    resetSessionDraftRepositoryForTests();
    activeAccountScopeState.current = null;
    await lifecycleHomes.reset();
    getActiveServerIdMock.mockReset();
    useMachineCapabilitiesCacheMock.mockReset();
    getMachineCapabilitiesCacheStateMock.mockReset();
    useMachineCliDetectionTargetMock.mockReset();
    endpointConnectivityState.status = 'online';
    invokeWithAlertsMock.mockReset();
    refreshMachineCapabilitiesMock.mockReset();
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

beforeEach(async () => {
    clearDaemonMergedProjectionCacheForTests();
    setMachineAdministrationTargetFixture();
    getActiveServerIdMock.mockReturnValue('server-a');
    // Device credential IO is the boundary; singular and plural scope readers
    // retain the real decoder, Account binding, and retirement lifecycle.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async serverUrl =>
        machineAdministrationFixture.profiles.some(profile => profile.serverUrl === serverUrl)
            ? { token: createAccountTokenForTests(activeAccountLifetime.scope.accountId, { currentAccount: true }) }
            : null);
    await lifecycleHomes.reset();
    lifecycleActionBoundary.mockReset();
    lifecycleActionBoundary.mockImplementation(async ({ actionId, input }: { actionId: string; input: { pluginId?: string; id?: string; targetDir?: string } }) => ({
        ok: true, result: actionId === 'plugins.scaffold'
            ? { ok: true, kind: 'plugins_scaffold', plugin: { pluginId: input.id }, createdPaths: { targetDir: input.targetDir } }
            : { ok: true, kind: actionId.replaceAll('.', '_'),
                action: actionId === 'plugins.trust.forget' ? 'forgetTrust'
                    : actionId === 'plugins.update_policy.set' ? 'setUpdatePolicy' : actionId.slice('plugins.'.length),
                pluginId: input.pluginId, change: { kind: 'committed' } },
    }));
    for (const [name, serverUrl, serverIdentityId] of [
        ['Server A', 'https://server-a.example.test', 'srv_identity-a'],
        ['Server B', 'https://server-b.example.test', 'srv_identity-b'],
    ] as const) {
        const homeId = await lifecycleHomes.addHome({ name, serverUrl, serverIdentityId,
            accountId: 'account-a', currentAccount: true, active: false });
        lifecycleHomes.answer(homeId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: Object.fromEntries(lifecycleActionIds.map(id => [id, ['ui']])) },
        } } } });
        const machines = ['machine-1', 'machine-2'].map(id => ({
            ...createPlainMachineRowFixture({ id, accountId: 'account-a' }),
            installationId: `${id}-installation`, runnerContentKeyBinding: null,
        }));
        lifecycleHomes.answer(homeId, '/v1/machines', { body: machines });
        // Exact admission and its batched transport share these same published
        // rows through the Home testkit; a census alone grants no authority.
        for (const machine of machines) {
            lifecycleHomes.answer(homeId, `/v1/machines/${machine.id}`, { body: { machine } });
        }
        for (const actionId of lifecycleActionIds) lifecycleHomes.answer(homeId, `/v1/actions/${actionId}`, { select: async body => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(body);
            const execution = await lifecycleActionBoundary({ actionId, ...request });
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: request.requestId, execution }) };
        } });
    }
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


            resourcesById: {},
            diagnostics: [],
        },
    });
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

// Load real screen owners after boundary setup, outside behavior deadlines.
const [{ TokenStorage }, { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance }] = await Promise.all([
    import('@/auth/storage/tokenStorage'),
    import('@/dev/testkit/harness/homeGovernanceHarness'),
]);
const lifecycleActionIds = ['plugins.enable', 'plugins.disable', 'plugins.rollback', 'plugins.uninstall', 'plugins.trust.forget', 'plugins.update_policy.set', 'plugins.scaffold'] as const;
const lifecycleHomes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(lifecycleHomes);
const { Switch: NativeSwitch } = await import('react-native');
const { PluginDevelopmentScreen } = await import('./development/PluginDevelopmentScreen');
const { PluginSettingsHomeScreen } = await import('./PluginSettingsHomeScreen');
const { PluginDetailScreen } = await import('./detail/PluginDetailScreen');
const { PluginDiagnosticsScreen } = await import('./diagnostics/PluginDiagnosticsScreen');
const { PluginListingScreen } = await import('./listing/PluginListingScreen');

describe('PluginSettingsHomeScreen', () => {
    it.each(['create', 'createWithAgent'])('keeps the complete %s draft editable until scaffold submission', async (action) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
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
        const RerenderableHome = PluginSettingsHomeScreen as React.ComponentType<{ capabilityRevision?: number }>;
        const screen = await renderInAppPanes(React.createElement(RerenderableHome, { capabilityRevision: 1 }));
        await act(async () => { await flushAsync(); });
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeTruthy();

        capabilityState = createMachineCapabilitiesState([]);
        await act(async () => {
            await screen.update(inAppPanes(React.createElement(RerenderableHome, { capabilityRevision: 2 })));
            await flushAsync();
        });
        expect(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row')).toBeFalsy();
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeTruthy();
        await act(async () => { screen.pressRow('settings.plugins.marketplace.installed.empty.browse'); });
        expect(screen.findByTestId('settings.plugins.management.view:discover')?.props.accessibilityState).toMatchObject({ selected: true });
    });

    it.each(['unselected', 'offline', 'missing'] as const)('only describes a disconnected machine when a target is selected: %s', async (kind) => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([]), refresh: vi.fn() });
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
        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => { await flushAsync(); await flushAsync(); });
        expect(Boolean(screen.findRow('settings.plugins.marketplace.readOnlySnapshot'))).toBe(kind !== 'unselected');
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('reads an online machine it cannot resolve yet as checking, never as disconnected or empty', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: { status: 'idle' }, refresh: vi.fn() });
        administrationTargetBoundary.controller.setExecutionPending(true);
        try {
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
        const home = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        for (const view of ['installed', 'discover'] as const) {
            await selectPluginManagementView(home, view);
            expect(home.findRow('settings.plugins.accountDataErase')).toBeFalsy();
            expect(home.findRow('settings.plugins.diagnostics')?.props.onPress).toBeTypeOf('function');
        }
        const diagnostics = await renderInAppPanes(React.createElement(PluginDiagnosticsScreen));
        expect(diagnostics.findRow('settings.plugins.accountDataErase')?.props.onPress).toBeTypeOf('function');
    });

    it.each(['home', 'detail'] as const)('offers cold capability failure recovery on %s without claiming absence', async (route) => {
        let capabilityState: MachineCapabilitiesState = { status: 'error' };
        const refresh = vi.fn(() => { capabilityState = createMachineCapabilitiesState([]); });
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({ state: capabilityState, refresh }));
        const element = route === 'home'
            ? React.createElement(PluginSettingsHomeScreen)
            : React.createElement(PluginDetailScreen, { pluginId: 'unread-plugin' });
        const screen = await renderInAppPanes(element);
        await act(async () => { await flushAsync(); await flushAsync(); });
        const retryTestID = route === 'home'
            ? 'settings.plugins.marketplace.readOnlySnapshot-retry'
            : 'settings.plugins.detail.readOnlySnapshot-retry';
        expect(screen.findRow(retryTestID)).toBeTruthy();
        expect(screen.findRow('settings.plugins.marketplace.installed.empty')).toBeFalsy();
        // The Account-wide inventory is an independent read while the selected
        // daemon's failed read remains recoverable from the notice above it.
        expect(Boolean(screen.findByTestId('settings.plugins.marketplace.installed:skeleton-row'))).toBe(route === 'home');
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
        expect(findDiscoverSourceFilterIds(screen)).toContain('all');
        await act(async () => {
            screen.pressByTestId('settings.plugins.management.view:discover');
        });
        expect(screen.findRow('settings.plugins.marketplace.search')?.props.value).toBe('');


        expect(screen.findByTestId('settings.plugins.management.view:activity')).toBeFalsy();
    }, 120_000);



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
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: { ok: true, result: { action: 'test', pluginId: 'development-plugin' } },
        });

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
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.scaffold')).toEqual([
            expect.objectContaining({ input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-1' },
                input: {
                    machineId: 'machine-1',
                    targetDir: '/workspace/plugins/new-plugin',
                    name: 'New Plugin',
                    id: 'acme.new-plugin',
                    ui: 'reactNative',
                },
            }) }),
        ]);


        // The author sees every canonical scaffold surface, including the
        // declarative default shared with the CLI.
        expect(createForm.getFields().find((field) => field.path === 'ui')?.options?.map((option) => option.value)).toEqual(['declarative', 'hostedWeb', 'reactNative']);

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
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.scaffold').at(-1)).toMatchObject({
            input: { input: {
                    machineId: 'machine-1',
                    targetDir: '/workspace/plugins/plain-plugin',
                    name: 'Plain Plugin',
                    id: 'acme.plain-plugin',
                    ui: 'declarative',
            } },
        });
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
        invokeWithAlertsMock.mockResolvedValue({
            supported: true,
            response: {
                ok: false,
                error: { code, message },
            },
        });

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
        lifecycleActionBoundary.mockResolvedValue({ ok: true, result: { ok: true, kind: 'plugins_scaffold',
            plugin: { pluginId: 'acme.agent-plugin' }, createdPaths: { targetDir: '/workspace/plugins/agent-plugin' } } });

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

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.scaffold')).toEqual([
            expect.objectContaining({ input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-1' },
                input: {
                    machineId: 'machine-1',
                    targetDir: '/workspace/plugins/agent-plugin',
                    name: 'Agent Plugin',
                    id: 'acme.agent-plugin',
                    ui: 'reactNative',
                },
            }) }),
        ]);
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
        lifecycleActionBoundary.mockImplementationOnce(async () => {
            await deferred.promise;
            return { ok: false, errorCode: 'scaffold_failed', error: 'Could not create scaffold' };
        });

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
        lifecycleActionBoundary.mockImplementationOnce(async () => {
            await deferred.promise;
            return { ok: true, result: { ok: true, kind: 'plugins_scaffold',
                plugin: { pluginId: 'acme.stale-plugin' }, createdPaths: { targetDir: '/workspace/canonical/stale-plugin' } } };
        });

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
            await screen.update(inAppPanes(React.createElement(RerenderableDevelopmentScreen, { scopeToken: 'machine-2' })));
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
        lifecycleActionBoundary.mockResolvedValueOnce({ ok: true, result: { ok: true, kind: 'plugins_scaffold',
            plugin: { pluginId: 'acme.created-plugin' }, createdPaths: { targetDir: '/workspace/canonical/created-plugin' } } });

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

    });

    it('keeps daemon trust reviews out of Plugins because Inbox owns the decision', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([], [], [{
                kind: 'reviewRequired',
                reviewKind: 'projectTrust',
                pendingChangeId: 'pending-agent-1',
                review: { source: { kind: 'path', locator: '/workspace/plugins/agent-authored' } },
            }]),
            refresh: vi.fn(),
        });

        const screen = await renderInAppPanes(React.createElement(PluginSettingsHomeScreen));
        await act(async () => {
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.management.pendingChanges.pending-agent-1')).toBeNull();
        expect(machineRpcWithServerScopeMock.mock.calls.some(([input]) => (input as { method?: string }).method === 'daemon.plugins.install.review.decide')).toBe(false);
    });
    it('cancels the inline development source draft without trusting or installing it', async () => {
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([]), refresh: vi.fn(),
        });
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


    it('fails the local development affordance closed without admitted daemon development status', async () => {
        const staleState: LoadedMachineCapabilitiesState = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        [MARKETPLACE_CAPABILITY_ID]: {
                            ok: true,
                            checkedAt: Date.now(),
                            data: { installedPlugins: [] },
                        },
                    },
                },
            },
        };
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: staleState, refresh: vi.fn() });

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
        let capabilityState: MachineCapabilitiesState = createMachineCapabilitiesState([developmentPlugin], [{
            pluginId: 'development-plugin',
            sourceRootPath: '/plugins/development-plugin',
            phase: 'active',
            occurrenceId: 'occurrence-development-plugin',
        }]);
        useMachineCapabilitiesCacheMock.mockImplementation(() => ({
            state: capabilityState,
            refresh: vi.fn(),
        }));

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

        const selectedMachine = machineAdministrationFixture.activeMachines[0];
        if (!selectedMachine) throw new Error('Expected the selected machine fixture.');
        selectedMachine.active = false;
        selectedMachine.activeAt = 0;
        capabilityState = { status: 'idle' };
        await act(async () => {
            syncAdministrationTargetBoundary();
            await screen.update(inAppPanes(React.createElement(RerenderablePluginDevelopmentScreen, {
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
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: false,
            reason: 'error',
        });

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
            projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
        });
        await act(async () => {
            screen.pressRow('settings.plugins.marketplace.readOnlySnapshot-retry');
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
    });


    it('keeps a loaded cached plugin snapshot read-only until same-version reconnect refreshes capabilities and projection', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
            rollbackAvailability: 'available',
        });
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
                projection: { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},   resourcesById: {}, settingsById: {}, familiesById: {}, diagnostics: [] },
            };
        });

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
            await screen.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
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
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

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

        selectedMachine.active = true;
        selectedMachine.activeAt = Date.now();
        await act(async () => {
            syncAdministrationTargetBoundary();
            await screen.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 3,
            })));
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.installed.installed-plugin')).toBeTruthy();
        // Reconnecting is a fresh read, not a warning. The controls remain
        // unavailable until the exact daemon's fresh truth has arrived.
        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.management.view:installed')?.props.accessibilityState).toMatchObject({ selected: true });
        const reconnectCapabilityCacheKeySalt = useMachineCapabilitiesCacheMock.mock.calls.at(-1)?.[0]?.cacheKeySalt;
        expect(reconnectCapabilityCacheKeySalt).not.toBe(initialCapabilityCacheKeySalt);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);

        freshCapabilitiesReady = true;
        await act(async () => {
            await screen.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                capabilityRevision: 4,
            })));
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();

        await act(async () => {
            resolveReconnectProjection?.();
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.marketplace.readOnlySnapshot')).toBeFalsy();
        expect(screen.findByTestId('settings.plugins.management.view:installed')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(findInstalledRowToggle(screen, 'installed-plugin')).toMatchObject({ action: 'disable', disabled: false });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(2);
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-a',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'srv_identity-a', accountId: 'account-a' } }),
        }));

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


                resourcesById: {},
                diagnostics: [],
            },
        });

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
        lifecycleActionBoundary.mockResolvedValue({ ok: true, result: {
            ok: true, kind: 'plugins_disable', action: 'disable', pluginId: 'com.acme.installed-plugin', change: { kind: 'committed' },
        } });

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

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.disable')).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-a.example.test', input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-1' },
                input: { machineId: 'machine-1', pluginId: 'com.acme.installed-plugin' },
            }) }),
        ]);
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
            await screen.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
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
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.rollback')).toHaveLength(0);
    });

    it.each([
        ['rollback', 'plugins.rollback'],
        ['uninstall', 'plugins.uninstall'],
        ['forgetTrust', 'plugins.trust.forget'],
    ] as const)('admits %s through Action policy and delivers the exact plugin and Machine', async (method, actionId) => {
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
        lifecycleActionBoundary.mockResolvedValue({ ok: true, result: {
            ok: true, kind: actionId.replaceAll('.', '_'), action: method, pluginId: installedPlugin.pluginId, change: { kind: 'committed' },
        } });

        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
        });

        await act(async () => {
            pressDetailLifecycleAction(screen, installedPlugin.pluginId, method);
            await flushAsync();
        });
        expect(lifecycleHomes.requestsFor(`/v1/actions/${actionId}`)).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-a.example.test', input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-1' },
                input: { machineId: 'machine-1', pluginId: installedPlugin.pluginId },
            }) }),
        ]);
        // Waiving the Account's default approval reaches the effect directly;
        // the caller cannot insert an independent confirmation decision.
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('refuses lifecycle dispatch when exact Machine admission is bound only on another Home', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'acme.admission', title: 'Admission plugin', version: '1.0.0',
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({
            state: createMachineCapabilitiesState([installedPlugin]), refresh,
        });
        const home = lifecycleHomes.findByServerUrl('https://server-a.example.test');
        if (!home) throw new Error('Expected the selected Home fixture');
        // Its census and the other Home still publish machine-1. Neither may
        // substitute for the exact target's missing admission row.
        lifecycleHomes.answer(home.serverId, '/v1/machines/machine-1', { status: 404 });
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            pressDetailLifecycleAction(screen, installedPlugin.pluginId, 'uninstall');
            await flushAsync();
        });
        await waitForHomeGovernance(() => expect(modalAlertMock).toHaveBeenCalledWith('common.error', expect.any(String)));
        const admissionReads = lifecycleHomes.requestsFor('/v1/machines/read-batch');
        expect(admissionReads).toContainEqual(expect.objectContaining({
            serverUrl: 'https://server-a.example.test', input: { machineIds: ['machine-1'] },
        }));
        expect(admissionReads.every(request => request.serverUrl === 'https://server-a.example.test')).toBe(true);
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.uninstall')).toEqual([]);
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.findRow(`settings.plugins.detail.${installedPlugin.pluginId}.header`)).toBeTruthy();
    });

    it.each([
        ['uninstall', 'plugins.uninstall', 'approval_rejected'],
        ['forgetTrust', 'plugins.trust.forget', 'approval_canceled'],
    ] as const)('keeps an admitted %s Action decline quiet', async (method, actionId, errorCode) => {
        const approvalId = 'daemon-uninstall-review';
        const daemonReplyReady = createDeferred();
        let daemonReplyError: unknown;
        if (method === 'uninstall') {
            // A Machine-placed Action returns its daemon-owned approval, not a
            // second app-side confirmation. Keep another Home active to prove
            // that review and the mounted continuation retain the exact Home.
            setMachineAdministrationTargetFixture({ serverIdentityId: 'srv_identity-b', serverId: 'server-b', machineId: 'machine-2' });
            const home = lifecycleHomes.findByServerUrl('https://server-b.example.test');
            if (!home) throw new Error('Expected the lifecycle Home fixture');
            await lifecycleHomes.requireUiApproval(home.serverId, actionId);
            // Validate the daemon fixture before entering the transport: a
            // schema failure is setup evidence, never lost-ACK evidence.
            const approvalTemplate = ApprovalRequestV2Schema.parse({
                v: 2, status: 'open', createdAtMs: Date.now(), updatedAtMs: Date.now(),
                createdBy: { surface: 'system' }, requestedSurface: 'ui',
                executionOriginV1: {
                    v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                    serverId: 'server-b', serverIdentityId: 'srv_identity-b', accountId: 'account-a',
                    machineId: 'machine-2', target: { kind: 'machine', machineId: 'machine-2' },
                    actionId, requestId: 'daemon-uninstall-request',
                },
                approval: getActionSpec(actionId).approval, actionId,
                actionArgs: { machineId: 'machine-2', pluginId: 'installed-plugin' },
                summary: 'Uninstall Installed Plugin',
            });
            lifecycleHomes.answer(home.serverId, `/v1/actions/${actionId}`, { select: async body => {
                try {
                    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
                    const request = ApprovalRequestV2Schema.parse({ ...approvalTemplate, actionArgs: envelope.input,
                        executionOriginV1: { ...approvalTemplate.executionOriginV1,
                            target: envelope.target, requestId: envelope.requestId },
                    });
                    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
                    const account = await captureLazyActionAccountContext('server-b');
                    try {
                        await account.createArtifactDocument({ artifactId: approvalId,
                            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) });
                    } finally { account.dispose(); }
                    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                        requestId: envelope.requestId, execution: { ok: true, result: {
                            kind: 'approval_request_created', actionId, artifactId: approvalId,
                        } },
                    }) };
                } catch (error) {
                    daemonReplyError = error;
                    throw error;
                } finally { daemonReplyReady.resolve(); }
            } });
        }
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([
            createInstalledPlugin({ pluginId: 'installed-plugin', title: 'Installed Plugin', version: '1.0.0' }),
        ]), refresh });
        // The real Action path decodes the Home's decline. Confirmation policy
        // stays with the Action/daemon owner, not this caller.
        lifecycleActionBoundary.mockResolvedValueOnce({ ok: false, errorCode, error: errorCode });
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        const control = () => screen.findAll(node => node.props?.testID === `settings.plugins.detail.installed-plugin.action.${method}`
            && typeof node.props.onPress === 'function')[0];
        await waitForHomeGovernance(() => {
            expect(control()).toBeTruthy();
            expect(control()?.props.disabled).not.toBe(true);
        });
        await act(async () => {
            pressDetailLifecycleAction(screen, 'installed-plugin', method);
            await flushAsync();
        });
        await waitForHomeGovernance(() => expect(lifecycleHomes.requestsFor(`/v1/actions/${actionId}`)).toEqual([
            expect.objectContaining({ serverUrl: method === 'uninstall' ? 'https://server-b.example.test' : 'https://server-a.example.test', input: expect.objectContaining({
                target: { kind: 'machine', machineId: method === 'uninstall' ? 'machine-2' : 'machine-1' },
                input: { machineId: method === 'uninstall' ? 'machine-2' : 'machine-1', pluginId: 'installed-plugin' },
            }) }),
        ]));
        if (method === 'uninstall') {
            await daemonReplyReady.promise;
            expect(daemonReplyError).toBeUndefined();
            const home = lifecycleHomes.findByServerUrl('https://server-b.example.test');
            if (!home) throw new Error('Expected the lifecycle Home fixture');
            expect(lifecycleHomes.artifacts(home.serverId).readPlainBody(approvalId),
                JSON.stringify({ alerts: modalAlertMock.mock.calls, paths: lifecycleHomes.requests.map(request => request.path) }))
                .not.toBeNull();
            await act(async () => { await flushAsync(); await flushAsync(); });
            // Registration starts the exact-Home Artifact reader. Navigation is
            // synchronous with that registration, so observing this GET proves
            // the mounted owner has already had its opportunity to open review.
            expect(lifecycleHomes.requestsFor(`/v1/artifacts/${approvalId}`),
                JSON.stringify({ alerts: modalAlertMock.mock.calls, paths: lifecycleHomes.requests.map(request => request.path) }))
                .toContainEqual(expect.objectContaining({ serverUrl: 'https://server-b.example.test' }));
            expect(routerPushSpy).toHaveBeenCalledWith(`/inbox/approvals/${approvalId}?serverId=srv_identity-b`);
            expect(getActiveServerIdMock()).toBe('server-a');
            expect(control()?.props.disabled).toBe(true);
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            expect(await createDefaultActionExecutor().execute('approval.request.decide', {
                artifactId: approvalId, decision: 'reject',
            }, { serverId: 'server-b', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
                .toMatchObject({ ok: true });
            expect(ApprovalRequestV2Schema.parse(JSON.parse(
                lifecycleHomes.artifacts(home.serverId).readPlainBody(approvalId) ?? 'null',
            )).status).toBe('rejected');
        }
        await act(async () => { await flushAsync(); await flushAsync(); });
        await waitForHomeGovernance(() => expect(control()?.props.disabled).not.toBe(true));
        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(lifecycleHomes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(1);
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(modalAlertMock).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('common.done');
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
        lifecycleActionBoundary.mockResolvedValue({ ok: false, errorCode: 'plugin-not-found', error: 'Installed plugin was not found' });

        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
        });

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.uninstall')).toHaveLength(1);
        expect(refresh).not.toHaveBeenCalled();
        expect(publishMachineContributionRegistryProjectionInvalidationMock).not.toHaveBeenCalled();
    });

    it('keeps update policy on the selected Home while another Home stays active', async () => {
        setMachineAdministrationTargetFixture({ serverIdentityId: 'srv_identity-b', serverId: 'server-b', machineId: 'machine-2' });
        const installedPlugin = createInstalledPlugin({
            pluginId: 'acme.policy', title: 'Policy plugin', version: '1.0.0',
            install: { mode: 'managed_install', manifestVersion: '1', updatePolicy: 'allowed', trust: {
                pluginId: 'acme.policy', state: 'trusted', approvedAtMs: 1,
                distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/policy' },
            } },
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([installedPlugin]), refresh });
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: installedPlugin.pluginId }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.policy.updatePolicy:pinned');
            await flushAsync();
        });
        expect(getActiveServerIdMock()).toBe('server-a');
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.update_policy.set')).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-b.example.test', input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'machine-2' },
                input: { machineId: 'machine-2', pluginId: 'acme.policy', policy: 'pinned' },
            }) }),
        ]);
        expect(refresh).toHaveBeenCalledWith({ bypassCache: true });
        expect(invokeWithAlertsMock).not.toHaveBeenCalled();
    });

    it('does not refresh or report success when an admitted update-policy effect refuses the change', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'acme.policy', title: 'Policy plugin', version: '1.0.0',
            install: { mode: 'managed_install', manifestVersion: '1', updatePolicy: 'allowed', trust: {
                pluginId: 'acme.policy', state: 'trusted', approvedAtMs: 1,
                distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/policy' },
            } },
        });
        const refresh = vi.fn();
        useMachineCapabilitiesCacheMock.mockReturnValue({ state: createMachineCapabilitiesState([installedPlugin]), refresh });
        lifecycleActionBoundary.mockResolvedValue({ ok: true, result: { ok: false, kind: 'plugins_update_policy_set',
            action: 'setUpdatePolicy', pluginId: installedPlugin.pluginId,
            change: { kind: 'failed', code: 'plugin-not-found', message: 'Installed plugin was not found' } } });
        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: installedPlugin.pluginId }));
        await act(async () => { await flushAsync(); await flushAsync(); });
        await act(async () => {
            screen.pressByTestId('settings.plugins.detail.acme.policy.updatePolicy:pinned');
            await flushAsync();
        });
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.update_policy.set')).toHaveLength(1);
        expect(refresh).not.toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', expect.any(String));
        expect(screen.getTextContent()).not.toContain('common.done');
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
            lifecycleActionBoundary.mockResolvedValueOnce({ ok: false, errorCode: 'outcomeUnknown',
                error: 'The daemon may have committed the requested mutation' });

            const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
                pluginId: installedPlugin.pluginId,
            }));
            await act(async () => {
                await flushAsync();
                pressDetailLifecycleAction(screen, installedPlugin.pluginId, method);
                await flushAsync();
                await flushAsync();
            });

            expect(lifecycleActionBoundary).toHaveBeenCalledTimes(1);
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

    it.each(['transport loss', 'empty 502 acknowledgement'] as const)(
        'reconciles commit-intended %s from authoritative truth without retrying uninstall', async failure => {
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
        if (failure === 'transport loss') {
            lifecycleActionBoundary.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        } else {
            const home = lifecycleHomes.findByServerUrl('https://server-a.example.test');
            if (!home) throw new Error('Expected the lifecycle Home fixture');
            // The real Action route loses the daemon acknowledgement after
            // dispatch and answers with no response body, not an error envelope.
            lifecycleHomes.answer(home.serverId, '/v1/actions/plugins.uninstall', { status: 502 });
        }

        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, {
            pluginId: installedPlugin.pluginId,
        }));
        await act(async () => {
            await flushAsync();
            screen.pressRow(`settings.plugins.detail.${installedPlugin.pluginId}.action.uninstall`);
            await flushAsync();
            await flushAsync();
        });

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.uninstall')).toHaveLength(1);
        expect(prefetchMachineCapabilitiesMock).toHaveBeenCalledTimes(1);
        expect(publishMachineContributionRegistryProjectionInvalidationMock).toHaveBeenCalledWith({
            machineId: 'machine-1', serverId: 'server-a',
        });
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.error', expect.anything());
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
        lifecycleActionBoundary.mockResolvedValueOnce({ ok: false, errorCode: 'outcomeUnknown',
            error: 'The daemon may have committed the requested mutation' });

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
        lifecycleActionBoundary.mockResolvedValueOnce({ ok: false, errorCode: 'outcomeUnknown',
            error: 'The daemon may have committed the requested mutation' });

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
            await screen.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
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

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.uninstall')).toHaveLength(1);
        expect(modalAlertMock).not.toHaveBeenCalledWith('common.success', 'common.done');
        expect(publishMachineContributionRegistryProjectionInvalidationMock).not.toHaveBeenCalled();
    });

    it('renders and edits hooks-only generic plugin settings from settingsById without leaking redacted values', async () => {
        activeAccountScopeState.current = activeAccountLifetime.scope;
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
        await waitForHomeGovernance(() => expect(endpointInput?.props.value).toBe('https://api.example.test'));
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


                resourcesById: {},
                diagnostics: [],
            },
        });

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


                resourcesById: {},
                diagnostics: [],
            },
        });

        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const credential = await renderHook(() => useServerCredentialAccountScopeBinding('server-a'));
        const accountLifetime = credential.getCurrent().binding;
        if (!accountLifetime) throw new Error('Expected the credential-backed projection scope');
        await loadDaemonMergedProjectionCacheEntry({
            machineId: 'machine-1',
            serverId: 'server-a',
            accountLifetime,
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);

        const screen = await renderInAppPanes(React.createElement(PluginDetailScreen, { pluginId: 'installed-plugin' }));

        await act(async () => {
            await flushAsync();
            await flushAsync();
        });

        expect(screen.findRow('settings.plugins.detail.installed-plugin.id')).toBeTruthy();
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledTimes(1);
    });

    it('clears machine-scoped projection when the selected machine changes', async () => {
        const installedPlugin = createInstalledPlugin({
            pluginId: 'installed-plugin',
            title: 'Installed Plugin',
            version: '1.0.0',
            enabled: true,
        });

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


                        resourcesById: {},
                        diagnostics: [],
                    },
                }
                : {
                    supported: false,
                }
        ));

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


        await act(async () => {
            await flushAsync();
            await flushAsync();
        });
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-a',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'srv_identity-a', accountId: 'account-a' } }),
        }));

        setMachineAdministrationTargetFixture({
            serverIdentityId: 'srv_identity-b',
            serverId: 'server-b',
            machineId: 'machine-2',
        });
        getActiveServerIdMock.mockReturnValue('server-b');

        await act(async () => {
            await screen.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
                scopeToken: 'machine-2',
            })));
            await flushAsync();
            await flushAsync();
        });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            // The read is routed to, and shared only within, this Home's
            // Account; the RPC transport owns its deadline.
            serverId: 'server-b',
            accountLifetime: expect.objectContaining({ scope: { serverId: 'srv_identity-b', accountId: 'account-a' } }),
        }));
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
        lifecycleActionBoundary.mockImplementation(async ({ target }: { target: { machineId: string } }) => {
            const machineId = target.machineId;
            await (machineId === 'machine-1' ? machineOneAction.promise : machineTwoAction.promise);
            return { ok: true, result: { ok: true, kind: 'plugins_rollback', action: 'rollback',
                pluginId: installedPlugin.pluginId, change: { kind: 'committed' } } };
        });

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
            await screen.update(inAppPanes(React.createElement(RerenderablePluginDetailScreen, {
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
        lifecycleActionBoundary.mockImplementation(async () => {
            await action.promise;
            return { ok: true, result: { ok: true, kind: 'plugins_disable', action: 'disable',
                pluginId: installedPlugin.pluginId, change: { kind: 'committed' } } };
        });

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
        await act(async () => { await flushAsync(); });
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.disable')).toHaveLength(1);
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
            await screen.update(inAppPanes(React.createElement(RerenderablePluginSettingsHomeScreen, {
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











    it('routes installed-row enable and disable through admitted public Actions', async () => {
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
        lifecycleActionBoundary.mockImplementation(async ({ actionId, input }: { actionId: string; input: { pluginId: string } }) => ({
            ok: true, result: { ok: true, kind: actionId.replaceAll('.', '_'), action: actionId.slice('plugins.'.length),
                pluginId: input.pluginId, change: { kind: 'committed' } },
        }));

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
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalledTimes(1));
        await waitForHomeGovernance(() => expect(findInstalledRowToggle(screen, 'disabled-plugin'))
            .toMatchObject({ action: 'enable', disabled: false }));

        await act(async () => {
            findInstalledRowToggle(screen, 'disabled-plugin')?.toggle();
            await flushAsync();
        });
        await waitForHomeGovernance(() => expect(refresh).toHaveBeenCalledTimes(2));

        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.disable')).toEqual([
            expect.objectContaining({ input: expect.objectContaining({ input: { machineId: 'machine-1', pluginId: 'existing-plugin' } }) }),
        ]);
        expect(lifecycleHomes.requestsFor('/v1/actions/plugins.enable')).toEqual([
            expect.objectContaining({ input: expect.objectContaining({ input: { machineId: 'machine-1', pluginId: 'disabled-plugin' } }) }),
        ]);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(refresh).toHaveBeenNthCalledWith(1, { bypassCache: true });
        expect(refresh).toHaveBeenNthCalledWith(2, { bypassCache: true });
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


                resourcesById: {},
                diagnostics: [],
            },
        });
        lifecycleActionBoundary.mockImplementation(async () => {
            await deferred.promise;
            return { ok: true, result: { ok: true, kind: 'plugins_disable', action: 'disable',
                pluginId: 'installed-plugin', change: { kind: 'committed' } } };
        });

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
