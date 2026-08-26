import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionV2,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import {
    PluginUiArtifactsManifestV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    normalizePluginUiDestinationBindingV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    selectCurrentAppShellPluginExecutionOrigins,
    selectCurrentAppShellPluginUiCurrentness,
    settleAppShellPluginRuntimeUpdate,
    useAppShellHasRenderableRightSidebarTabPlacements,
    useAppShellPluginUiProjection,
} from './AppShellPluginUiProjection';
import { selectPluginSurfacePlacementsForBinding } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import {
    getQualifiedConnectedServiceRegistryEntry,
    getConnectedServiceRegistrySnapshot,
    installConnectedAccountDescriptorProjection,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { acquireBundledConversationRuntimeGeneration } from '@/voice/registry/bundledConversationRuntimeGeneration';
import type {
    VoiceConversationProviderContribution,
} from '@/voice/registry/externalVoiceProviderActivation';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
} from '@/sync/domains/plugins/availability/projection';
import type {
    PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';
import type {
    PluginReactNativeArtifactAvailability,
} from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage as persistentStorage } from '@/sync/domains/state/storageStore';
import type { PluginUiPageHeaderActionProjection } from '@/sync/domains/plugins/ui/projection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import {
    createPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    getPluginUiClientExecutableComposition,
    resolvePluginUiClientActionRegistration,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import {
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from '@/components/plugins/reactNative/executableModuleHost';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import type { PluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { PluginAppPageHeaderActions } from './pluginAppPageHeaderActions';
import type { PluginAppPage } from './pluginAppPages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MachineContributionRegistryProjectionModule = typeof import(
    '@/sync/ops/machineContributionRegistryProjection'
);
type ServerRuntimeModule = typeof import('@/sync/domains/server/serverRuntime');
type SupportedMachineContributionRegistryProjectionDescribeResult = Extract<
    Awaited<ReturnType<MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']>>,
    Readonly<{ supported: true }>
>;

const projectionDescribeSpy = vi.hoisted(() => vi.fn<
    MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']
>());
const clientArtifactAvailabilitySpy = vi.hoisted(() => vi.fn());
const pluginRuntimeSpies = vi.hoisted(() => ({
    activate: vi.fn<(input: unknown) => Promise<readonly unknown[]>>(async () => []),
    withdraw: vi.fn<() => Promise<void>>(async () => {}),
    invalidate: vi.fn<(
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => Promise<void>>(async () => {}),
    reconcileSourceUpdate: vi.fn<(input: unknown) => void>(),
    reconcileSourceDispose: vi.fn<() => void>(),
    replaceAuthority: vi.fn<(authority: unknown) => Promise<void>>(async () => {}),
}));
const pluginExecutableHostState = vi.hoisted(() => ({
    override: null as PluginUiExecutableModuleHost | null,
}));
const appShellClientExecutableRuntimeState = vi.hoisted(() => ({
    useRealActivation: false,
    cache: null as PluginReactNativeBundleCache | null,
    loaderBackend: null as PluginReactNativeLoaderBackend | null,
    availability: null as Extract<PluginReactNativeArtifactAvailability, { kind: 'available' }> | null,
}));
const storageState = vi.hoisted(() => ({
    machines: [] as Array<Record<string, unknown>>,
    voiceExecutionMachine: {
        mode: 'auto' as 'auto' | 'fixed',
        machineId: null as string | null,
        autoMachineId: null as string | null,
    },
    activeServer: { serverId: 'server-1', serverUrl: 'https://server.example.test', generation: 1 },
    endpointConnectivity: {
        status: 'online' as 'online' | 'offline',
        lastConnectedAt: 1 as number | null,
    },
    machineTargets: {} as Record<string, { daemonStateVersion: number; isOnline: boolean }>,
}));
const serverProfilesState = vi.hoisted(() => ({
    generation: 0,
    profiles: [] as ServerProfile[],
}));
const localServicePreviewPlatformState = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android' | 'desktop',
}));
const projectionRefreshState = vi.hoisted(() => {
    let revision = 0;
    const listeners = new Set<() => void>();
    return {
        getRevision: () => revision,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        publish: () => {
            revision += 1;
            for (const listener of listeners) listener();
        },
        reset: () => {
            revision = 0;
            listeners.clear();
        },
    };
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
    const { mergeModuleMock } = await import('@/dev/testkit/mocks/_shared');
    return mergeModuleMock<MachineContributionRegistryProjectionModule>({
        importOriginal,
        overrides: {
            machineContributionRegistryProjectionDescribe: (...args) => projectionDescribeSpy(...args),
            getMachineContributionRegistryProjectionRevision: () => projectionRefreshState.getRevision(),
            subscribeMachineContributionRegistryProjectionInvalidation: (_scope, listener) => (
                projectionRefreshState.subscribe(listener)
            ),
        },
    });
});

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const { mergeModuleMock } = await import('@/dev/testkit/mocks/_shared');
    return mergeModuleMock<ServerRuntimeModule>({
        importOriginal,
        overrides: {
            getActiveServerSnapshot: () => storageState.activeServer,
            subscribeActiveServer: () => () => {},
        },
    });
});

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, {
        listServerProfiles: () => serverProfilesState.profiles,
        overrides: {
            getServerProfilesGeneration: () => serverProfilesState.generation,
            subscribeServerProfiles: () => () => {},
        },
    });
});

vi.mock('./appShellClientExecutableActivation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./appShellClientExecutableActivation')>();
    return {
        ...actual,
        reconcileAppShellProjectedClientExecutables: async (
            ...args: Parameters<typeof actual.reconcileAppShellProjectedClientExecutables>
        ) => (
            appShellClientExecutableRuntimeState.useRealActivation
                ? await actual.reconcileAppShellProjectedClientExecutables(...args)
                : await pluginRuntimeSpies.activate(args[0])
        ),
        unloadAppShellProjectedClientExecutables: async (
            ...args: Parameters<typeof actual.unloadAppShellProjectedClientExecutables>
        ) => (
            appShellClientExecutableRuntimeState.useRealActivation
                ? await actual.unloadAppShellProjectedClientExecutables(...args)
                : await pluginRuntimeSpies.withdraw()
        ),
    };
});

vi.mock('@/components/plugins/reactNative/projectionInvalidation', () => ({
    applyInstalledAppShellPluginUiReactNativeExecutableAuthorityInvalidation: (
        previous: Readonly<{ generation: number | null }>,
        next: Readonly<{ generation: number | null }>,
    ) => pluginRuntimeSpies.invalidate(previous, next),
    createInstalledPluginUiReactNativeRuntimeProjectionSource: () => ({
        update: pluginRuntimeSpies.reconcileSourceUpdate,
        dispose: pluginRuntimeSpies.reconcileSourceDispose,
    }),
}));

vi.mock('@/components/plugins/reactNative/executableModuleHost', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/plugins/reactNative/executableModuleHost')>();
    return {
        ...actual,
        getInstalledPluginUiExecutableModuleHost: () => (
            pluginExecutableHostState.override ?? actual.getInstalledPluginUiExecutableModuleHost()
        ),
    };
});

vi.mock('../../plugins/reactNative/bundleCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../plugins/reactNative/bundleCache')>();
    return {
        ...actual,
        getInstalledPluginReactNativeBundleCache: () => (
            appShellClientExecutableRuntimeState.cache ?? actual.getInstalledPluginReactNativeBundleCache()
        ),
    };
});

vi.mock('../../plugins/reactNative/resolveDefaultReactNativeLoaderBackend', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../plugins/reactNative/resolveDefaultReactNativeLoaderBackend')>();
    return {
        ...actual,
        resolveDefaultReactNativeLoaderBackend: () => (
            appShellClientExecutableRuntimeState.loaderBackend ?? actual.resolveDefaultReactNativeLoaderBackend()
        ),
    };
});

vi.mock('@/sync/domains/plugins/availability/reactNativeArtifactAvailability', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/plugins/availability/reactNativeArtifactAvailability')>();
    return {
        ...actual,
        acquirePluginReactNativeArtifactAvailability: async (
            ...args: Parameters<typeof actual.acquirePluginReactNativeArtifactAvailability>
        ) => {
            clientArtifactAvailabilitySpy(args[0]);
            return appShellClientExecutableRuntimeState.availability
                ?? await actual.acquirePluginReactNativeArtifactAvailability(...args);
        },
    };
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => storageState.activeServer,
}));

vi.mock('@/sync/domains/local/services/preview/platform', () => ({
    resolveLocalServicePreviewPlatform: () => localServicePreviewPlatformState.platform,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const readStorageState = () => ({
        machines: Object.fromEntries(storageState.machines.map((machine) => [machine.id, machine])),
        settings: {
            recentMachinePaths: [],
            voice: {
                executionMachine: storageState.voiceExecutionMachine,
            },
        },
    });
    const storage = Object.assign(
        (selector: (state: ReturnType<typeof readStorageState>) => unknown) => selector(readStorageState()),
        {
            getState: readStorageState,
            getInitialState: readStorageState,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return createStorageModuleStub({
        storage,
        useAllMachines: () => storageState.machines,
        useEndpointStatus: () => storageState.endpointConnectivity.status,
        useMachineCliDetectionTarget: (machineId: string | null) => (
            machineId
                ? storageState.machineTargets[machineId] ?? {
                    daemonStateVersion: Number(
                        storageState.machines.find((machine) => machine.id === machineId)?.daemonStateVersion ?? 0,
                    ),
                    isOnline: storageState.machines.some((machine) => machine.id === machineId),
                }
                : { daemonStateVersion: 0, isOnline: false }
        ),
    });
});

const initialPersistentStorageState = persistentStorage.getState();

afterEach(async () => {
    vi.useRealTimers();
    standardCleanup();
    const executableHost = pluginExecutableHostState.override;
    if (executableHost) {
        await getPluginUiClientExecutableComposition(executableHost).unload();
    }
    clearPluginAccountAvailabilityProjection();
    retireActiveServerAccountScopeLifetime();
    persistentStorage.setState(initialPersistentStorageState, true);
    projectionDescribeSpy.mockReset();
    clientArtifactAvailabilitySpy.mockReset();
    pluginRuntimeSpies.activate.mockReset();
    pluginRuntimeSpies.activate.mockResolvedValue([]);
    pluginRuntimeSpies.withdraw.mockReset();
    pluginRuntimeSpies.withdraw.mockResolvedValue(undefined);
    pluginRuntimeSpies.invalidate.mockReset();
    pluginRuntimeSpies.invalidate.mockResolvedValue(undefined);
    pluginRuntimeSpies.reconcileSourceUpdate.mockReset();
    pluginRuntimeSpies.reconcileSourceDispose.mockReset();
    pluginRuntimeSpies.replaceAuthority.mockReset();
    pluginRuntimeSpies.replaceAuthority.mockResolvedValue(undefined);
    pluginExecutableHostState.override = null;
    appShellClientExecutableRuntimeState.useRealActivation = false;
    appShellClientExecutableRuntimeState.cache = null;
    appShellClientExecutableRuntimeState.loaderBackend = null;
    appShellClientExecutableRuntimeState.availability = null;
    storageState.machines = [];
    storageState.voiceExecutionMachine = {
        mode: 'auto',
        machineId: null,
        autoMachineId: null,
    };
    storageState.activeServer = { serverId: 'server-1', serverUrl: 'https://server.example.test', generation: 1 };
    storageState.endpointConnectivity = { status: 'online', lastConnectedAt: 1 };
    storageState.machineTargets = {};
    serverProfilesState.generation = 0;
    serverProfilesState.profiles = [];
    localServicePreviewPlatformState.platform = 'web';
    projectionRefreshState.reset();
    installConnectedAccountDescriptorProjection(createConnectedAccountDescriptorProjectionLoadingState('test-cleanup'));
});

function projection(entriesById: Record<string, unknown>): PluginProjectionV2 {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 5,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            connectedAccounts: {
                family: 'connectedAccounts',
                entriesById,
            },
        },
        diagnostics: [],
    });
}

const APP_SCOPE_FIXTURE = Object.freeze({
    accountId: 'account-app-shell-fixture',
    serverId: 'server-1',
    serverIdentityId: 'srv_app_shell_fixture',
});
const APP_SCOPE_ARCHIVE_DIGEST = computePluginUiArtifactSha256DigestV1(
    new TextEncoder().encode('app-shell-fixture-release'),
);

type AppScopeArtifactFixture = Readonly<{
    contributionId: string;
    tier: 'reactNative';
    platform: 'web';
    artifactDigest: `sha256:${string}`;
    compatibility: Readonly<{
        hostUiApiVersion: string;
        reactVersion: string;
        reactNativeVersion: string;
    }>;
}>;

function createLiveMachine(machineId: string): Machine {
    return {
        id: machineId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

/**
 * Supplies the real Account Availability and Administration inputs for an
 * AppShell union. The AppShell must never infer a selected origin from the
 * raw daemon projection, so tests that need a visible app contribution build
 * the same three facts production consumes: account scope, exact release
 * materialization, and live machine inventory.
 */
function installSelectedAppScopePluginFixture(input: Readonly<{
    machineId: string;
    pluginId: string;
    artifacts?: readonly AppScopeArtifactFixture[];
}>): PluginMachineExecutionOriginV1 {
    const artifacts = input.artifacts ?? [];
    const origin: PluginMachineExecutionOriginV1 = Object.freeze({
        serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: input.machineId,
            materializationId: `${input.machineId}:${input.pluginId}:install`,
            pluginId: input.pluginId,
        }),
    });
    const machine = createLiveMachine(input.machineId);
    const previous = persistentStorage.getState();
    persistentStorage.setState({
        isDataReady: true,
        profile: { ...previous.profile, id: APP_SCOPE_FIXTURE.accountId },
        profileScope: {
            serverId: APP_SCOPE_FIXTURE.serverId,
            accountId: APP_SCOPE_FIXTURE.accountId,
        },
        machines: { [machine.id]: machine },
        machineListByServerId: {
            ...(previous.machineListByServerId ?? {}),
            [APP_SCOPE_FIXTURE.serverId]: [machine],
            [APP_SCOPE_FIXTURE.serverIdentityId]: [machine],
        },
        machineListStatusByServerId: {
            ...(previous.machineListStatusByServerId ?? {}),
            [APP_SCOPE_FIXTURE.serverId]: 'idle',
            [APP_SCOPE_FIXTURE.serverIdentityId]: 'idle',
        },
        settings: {
            ...previous.settings,
            machineAdministrationSelectionsV1: {
                v: 1,
                targetsByKey: {},
                pluginExecutionOriginsByPluginId: { [input.pluginId]: origin },
            },
        },
    });
    serverProfilesState.profiles = [{
        id: 'app-shell-fixture-profile',
        name: 'AppShell fixture',
        serverUrl: 'https://app-shell-fixture.example.test',
        serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
        legacyServerIds: [APP_SCOPE_FIXTURE.serverId],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        source: 'manual',
    }];
    serverProfilesState.generation += 1;

    const materialization: PluginAccountAvailabilitySnapshot['materializations'][number] = {
        serverIdentityId: origin.serverIdentityId,
        machineId: origin.materializationRef.machineId,
        materializationId: origin.materializationRef.materializationId,
        pluginId: origin.materializationRef.pluginId,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        archiveDigestSha256: APP_SCOPE_ARCHIVE_DIGEST,
        uiArtifacts: artifacts.map(({ compatibility: _compatibility, ...artifact }) => artifact),
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const snapshot: PluginAccountAvailabilitySnapshot = {
        availabilityCursor: 1,
        intentReads: [{
            pluginId: input.pluginId,
            response: {
                availabilityCursor: 1,
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: input.pluginId,
                    desiredVersion: '1.0.0',
                    enabled: true,
                    offlineUiHosting: 'disabled',
                    writableCollections: [],
                    revision: 'fixture-1',
                },
                release: {
                    ref: { pluginId: input.pluginId, version: '1.0.0' },
                    archiveDigestSha256: APP_SCOPE_ARCHIVE_DIGEST,
                    normalizedManifest: {
                        schemaVersion: 2,
                        id: input.pluginId,
                        version: '1.0.0',
                        displayName: input.pluginId,
                        engines: { happier: '^1.0.0' },
                        runtime: { apiVersion: 1 },
                        hostAccess: { required: [], optional: [] },
                        secrets: [],
                        contributes: PluginContributesV2Schema.parse({}),
                    },
                    collectionContracts: [],
                    uiSlots: artifacts,
                    packageAssetArchive: {
                        archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                        resources: [],
                    },
                },
                uiArtifacts: [],
            },
        }],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            revision: 1,
            materializations: [materialization],
        }],
    };
    replacePluginAccountAvailabilityProjection({
        scope: {
            serverId: APP_SCOPE_FIXTURE.serverId,
            accountId: APP_SCOPE_FIXTURE.accountId,
        },
        snapshot,
    });
    return origin;
}

function projectionWithConnectedAccount(input: Readonly<{
    serviceId: string;
    pluginId?: string;
    title?: string;
    availability?: 'available' | 'disabled' | 'blocked';
    diagnostics?: readonly string[];
}>): PluginProjectionV2 {
    return projection({
        account: {
                        id: 'account',
                        serviceId: input.serviceId,
                        ...(input.pluginId ? { pluginId: input.pluginId } : {}),
                        provenance: 'external',
                        sourceKind: 'bundled',
                        title: input.title ?? 'Account',
                        authentication: {
                            defaultModeId: 'manual',
                            modes: [{
                                id: 'manual',
                                kind: 'manual',
                                outcomeReconciliation: 'none',
                                fields: [{
                                    id: 'token',
                                    title: 'Token',
                                    schema: { type: 'string', minLength: 1 },
                                    secret: true,
                                }],
                            }],
                        },
                        capabilities: [],
                        availability: {
                            state: input.availability ?? 'available',
                            reason: input.availability && input.availability !== 'available' ? 'plugin_diagnostics' : 'resolved',
                        },
                        diagnostics: input.diagnostics ?? [],
                    },
    });
}

function getProjectedEntry(pluginId: string) {
    return getQualifiedConnectedServiceRegistryEntry({
        pluginId,
        localId: 'account',
    });
}

function installActiveAccountScope(accountId: string): void {
    const previous = persistentStorage.getState();
    persistentStorage.setState({
        ...previous,
        isDataReady: true,
        profile: { ...previous.profile, id: accountId },
        profileScope: { serverId: 'server-1', accountId },
    }, true);
}

function requireConversationDeclaration(
    declaration: VoiceProviderContribution,
): VoiceConversationProviderContribution {
    if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
    return declaration;
}

function ProjectionProbe() {
    const value = useAppShellPluginUiProjection();
    return React.createElement('ProjectionProbe', { value });
}

function ClientActionHeaderPresentationProbe(props: Readonly<{
    action: PluginUiPageHeaderActionProjection;
    page: PluginAppPage;
    actionAuthority: PluginSurfaceLaunchAuthority;
}>) {
    const { pluginUiProjection } = useAppShellPluginUiProjection();
    return (
        <PluginAppPageHeaderActions
            actions={[props.action]}
            page={props.page}
            projection={pluginUiProjection}
            actionAuthority={props.actionAuthority}
            openSurface={async () => ({ ok: true })}
        />
    );
}

function ScopedProjectionProbe() {
    const value = useScopedPluginUiProjection({ machineId: 'machine-scoped', serverId: 'server-scoped' });
    return React.createElement('ScopedProjectionProbe', { value });
}

function RightSidebarTabProbe() {
    const value = useAppShellHasRenderableRightSidebarTabPlacements();
    return React.createElement('RightSidebarTabProbe', { value });
}

function accountLifetimeFixture(input: Readonly<{
    accountId: string;
    isCurrent?: () => boolean;
}>) {
    return {
        scope: { serverId: 'server-1', accountId: input.accountId },
        isCurrent: input.isCurrent ?? (() => true),
        onRetire: () => ({ dispose() {} }),
    } as const;
}

function createAvailableClientArtifactHandle() {
    let current = true;
    const revocationListeners = new Set<() => void>();
    const dispose = vi.fn(() => {
        current = false;
        revocationListeners.clear();
    });
    return Object.freeze({
        availability: Object.freeze({
            kind: 'available' as const,
            cacheKey: 'app-shell-client-action-artifact',
            isCurrent: () => current,
            onRevoke: (listener: () => void) => {
                revocationListeners.add(listener);
                return Object.freeze({ dispose: () => revocationListeners.delete(listener) });
            },
            dispose,
        }),
        dispose,
    });
}

function unselectedAppScopeOrigin(input: Readonly<{
    machineId: string;
    pluginId: string;
}>): PluginMachineExecutionOriginV1 {
    return Object.freeze({
        serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: input.machineId,
            materializationId: `${input.machineId}:${input.pluginId}:install`,
            pluginId: input.pluginId,
        }),
    });
}

function pluginUiProjectionWithAppTab(input: Readonly<{
    generation: number;
    pluginId: string;
    localId?: string;
    origin?: PluginMachineExecutionOriginV1;
}>): PluginProjectionV2 {
    const localId = input.localId ?? 'panel';
    const id = `surfacePlacement:${input.pluginId}:${localId}`;
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: localId,
        rendererId: 'inspector',
        container: 'rightSidebarTab',
        target: { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: input.generation,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    [id]: {
                        id,
                        pluginId: input.pluginId,
                        contributionKind: 'surfacePlacement',
                        descriptorId: localId,
                        ...(input.origin ? {
                            serverIdentityId: input.origin.serverIdentityId,
                            materializationRef: input.origin.materializationRef,
                        } : {}),
                        binding,
                        target: { kind: 'app' },
                        renderer: { kind: 'declarative', contributionId: 'inspector' },
                        display: { developerFallback: 'Panel' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    },
                },
            },
        },
        diagnostics: [],
    });
}

function pluginUiProjectionWithClientAction(input: Readonly<{
    generation: number;
    pluginId: string;
    origin: PluginMachineExecutionOriginV1;
}>): PluginProjectionV2 {
    const localId = 'open-client-action';
    return PluginProjectionV2Schema.parse({
        ...pluginUiProjectionWithAppTab(input),
        actionsById: {
            [`${input.pluginId}/${localId}`]: {
                id: localId,
                pluginId: input.pluginId,
                title: 'Open client action',
                scopes: ['session'],
                surfaces: ['ui'],
                placementBindings: ['detailsPanel'],
                dangerLevel: 'safe',
                available: true,
                execution: {
                    target: 'client',
                    client: {
                        artifactId: 'client-action-runtime',
                        modulePath: './clientActionRuntime',
                        exportName: 'activate',
                    },
                    platforms: ['web'],
                },
                serverIdentityId: input.origin.serverIdentityId,
                materializationRef: input.origin.materializationRef,
            },
        },
    });
}

describe('AppShellPluginUiProjectionProvider', () => {
    it('withholds same-server same-plugin selection and currentness reports from the retired Account', () => {
        const accountA = accountLifetimeFixture({ accountId: 'account-a' });
        const accountB = accountLifetimeFixture({ accountId: 'account-b' });
        const originA = {
            serverIdentityId: 'server-identity-1',
            materializationRef: {
                pluginId: 'acme.notes',
                machineId: 'machine-a',
                materializationId: 'account-a-install',
            },
        } as const;
        const originReports = new Map([[
            'acme.notes',
            { accountLifetime: accountA, origin: originA },
        ]]);
        const currentnessA = {
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            interactionEnabled: true,
        } as never;
        const currentnessReports = new Map([[
            'machine-a',
            { accountLifetime: accountA, currentness: currentnessA },
        ]]);

        // Control: Account A can read its own exactly-selected plugin and
        // machine report.
        expect(selectCurrentAppShellPluginExecutionOrigins({
            reports: originReports,
            accountLifetime: accountA,
            admittedPluginIds: ['acme.notes'],
        })).toEqual(new Map([['acme.notes', originA]]));
        expect(selectCurrentAppShellPluginUiCurrentness({
            reports: currentnessReports,
            accountLifetime: accountA,
        })).toEqual(new Map([['machine-a', currentnessA]]));

        // Same server and same plugin id are deliberately insufficient. Before
        // the Account-B children publish, these old reports must be invisible
        // synchronously rather than surviving one render as a stale union.
        expect(selectCurrentAppShellPluginExecutionOrigins({
            reports: originReports,
            accountLifetime: accountB,
            admittedPluginIds: ['acme.notes'],
        })).toEqual(new Map());
        expect(selectCurrentAppShellPluginUiCurrentness({
            reports: currentnessReports,
            accountLifetime: accountB,
        })).toEqual(new Map());
    });

    it('contains projection invalidation and activation rejections from the React effect', async () => {
        const activationAfterFailedInvalidation = vi.fn(async () => {});
        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: async () => { throw new Error('invalidation failed'); },
            activate: activationAfterFailedInvalidation,
            isCancelled: () => false,
        })).resolves.toBeUndefined();
        expect(activationAfterFailedInvalidation).not.toHaveBeenCalled();

        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: async () => {},
            activate: async () => { throw new Error('activation failed'); },
            isCancelled: () => false,
        })).resolves.toBeUndefined();

        const supersededInvalidation = vi.fn(async () => {});
        const supersededActivation = vi.fn(async () => {});
        await expect(settleAppShellPluginRuntimeUpdate({
            invalidate: supersededInvalidation,
            activate: supersededActivation,
            isCancelled: () => true,
        })).resolves.toBeUndefined();
        expect(supersededInvalidation).not.toHaveBeenCalled();
        expect(supersededActivation).not.toHaveBeenCalled();
    });

    it('invalidates from the last applied projection when a queued refresh is superseded', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        const pluginId = 'acme.app-shell-queued-invalidation';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({
                generation,
                pluginId,
                origin,
            }),
        }));
        const firstActivation = createDeferred<readonly unknown[]>();
        pluginRuntimeSpies.activate.mockImplementationOnce(async () => await firstActivation.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
        pluginRuntimeSpies.invalidate.mockClear();

        generation = 6;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 3 });

        generation = 7;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 3 });

        firstActivation.resolve([]);
        await flushHookEffects({ cycles: 8 });

        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: null }),
            expect.objectContaining({ generation: 7 }),
        );
        expect(pluginRuntimeSpies.invalidate).not.toHaveBeenCalledWith(
            expect.objectContaining({ generation: 6 }),
            expect.objectContaining({ generation: 7 }),
        );

        await screen.unmount();
    });

    // The app-target `rightSidebarTab` opener must be installed by the SHELL, at
    // app lifetime. While it was registered from the sidebar leaf instead, a
    // plugin's FIRST open answered `plugin_surface_open_destination_owner_unavailable`
    // precisely because the route that would have installed the resolver had
    // never been entered. This exercises the production shell rather than a
    // mirror of it, so deleting that registration cannot stay green.
    it('installs the app-target rightSidebarTab opener before any sidebar route mounts', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        const pluginId = 'acme.app-shell-cold-right-sidebar';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 3, pluginId, origin }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { usePluginSurfaceDestinationNavigationBinding } = await import(
            '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation'
        );
        type AppTargetBinding = ReturnType<typeof usePluginSurfaceDestinationNavigationBinding>;
        let binding: AppTargetBinding = null;
        function AppTargetBindingProbe() {
            binding = usePluginSurfaceDestinationNavigationBinding();
            return null;
        }

        // No sidebar route is mounted: only the shell boundary and the app pane
        // owner it writes selection through.
        const screen = await renderScreen(
            <AppPaneProvider>
                <AppShellPluginUiProjectionProvider>
                    <AppTargetBindingProbe />
                </AppShellPluginUiProjectionProvider>
            </AppPaneProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(binding).not.toBeNull();
        await act(async () => {
            await expect(binding!.openSurface({
                destination: { pluginId, localId: 'panel' },
            })).resolves.toEqual({ ok: true });
        });

        await screen.unmount();
    });

    it('retries invalidation from the last applied projection after an invalidation failure', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        const pluginId = 'acme.app-shell-invalidation-retry';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({
                generation,
                pluginId,
                origin,
            }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        pluginRuntimeSpies.invalidate.mockClear();
        // Fail the invalidation that carries the NEW generation. Targeting the
        // generation rather than a call ordinal keeps the simulated failure on
        // the attempt whose basis this test is about, independently of the
        // content no-op passes an authority flip also schedules.
        pluginRuntimeSpies.invalidate.mockImplementation(async (
            _previous: Readonly<{ generation: number | null }>,
            next: Readonly<{ generation: number | null }>,
        ) => {
            if (next.generation === 6) throw new Error('synthetic invalidation failure');
        });

        generation = 6;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 5 });

        generation = 7;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 5 });

        // The contract is the BASIS each attempt starts from, not the call
        // ordinal: an authority flip republishes the same generation, which is a
        // content no-op for artifact invalidation and must not be asserted away.
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 6 }),
        );
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 7 }),
        );
        // The failed attempt must not become the new basis.
        expect(pluginRuntimeSpies.invalidate).not.toHaveBeenCalledWith(
            expect.objectContaining({ generation: 6 }),
            expect.objectContaining({ generation: 7 }),
        );

        await screen.unmount();
    });

    it('installs an explicit loading lifecycle for the current server before the first projection settles', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        const pending = createDeferred<{ supported: false; reason: 'error' }>();
        projectionDescribeSpy.mockReturnValue(pending.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({
            scopeKey: 'server-1',
            status: 'loading',
            entries: expect.any(Array),
        });

        pending.resolve({ supported: false, reason: 'error' });
        await flushHookEffects({ cycles: 3 });
        await screen.unmount();
    });

    it('loads the sole machine browser projection while withholding unselected app UI', async () => {
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 5,
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
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
            </AppShellPluginUiProjectionProvider>,
        );

        await flushHookEffects({ cycles: 4 });

        const probe = screen.tree.findByType('ProjectionProbe' as never);
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-1',
        }));
        // The AppShell is an app-scope union. A raw machine projection does not
        // grant it authority to publish UI contributions: this fixture has no
        // Availability/Administration-selected contribution. The browser
        // projection remains machine-scoped and is therefore still available
        // for the sole current machine.
        expect(probe.props.value).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            pluginUiProjection: null,
            interactionEnabled: false,
            pluginBrowserProjection: expect.objectContaining({ generation: 5 }),
        }));
    });

    it('binds projected Voice activation to the fixed Voice execution machine instead of the newer AppShell target', async () => {
        storageState.machines = [
            {
                id: 'machine-a',
                active: true,
                activeAt: Date.now(),
                createdAt: 2,
                metadata: { host: 'newest-app-shell-target' },
            },
            {
                id: 'machine-b',
                active: true,
                activeAt: Date.now() - 1_000,
                createdAt: 1,
                metadata: { host: 'fixed-voice-target' },
            },
        ];
        storageState.voiceExecutionMachine = {
            mode: 'fixed',
            machineId: 'machine-b',
            autoMachineId: null,
        };
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: {
                v: 2,
                generation: machineId === 'machine-b' ? 7 : 5,
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
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        // F7: two eligible machines means the app scope has no single machine, and
        // the newest heartbeat is NOT promoted into one. Voice keeps its own,
        // user-selected execution binding regardless.
        expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
            expect.objectContaining({ machineId: null }),
        );
        expect(pluginRuntimeSpies.activate).toHaveBeenLastCalledWith(expect.objectContaining({
            voice: expect.objectContaining({
                machineId: 'machine-b',
                projection: expect.objectContaining({ generation: 7 }),
            }),
        }));
        expect(pluginRuntimeSpies.activate).not.toHaveBeenCalledWith(expect.objectContaining({
            voice: expect.objectContaining({ machineId: 'machine-a' }),
        }));
    });

    it('does not activate projected Voice providers when the fixed Voice machine is offline and another machine is online', async () => {
        storageState.machines = [
            {
                id: 'machine-a',
                active: true,
                activeAt: Date.now(),
                createdAt: 2,
                metadata: { host: 'online-app-shell-target' },
            },
            {
                id: 'machine-b',
                active: false,
                activeAt: 0,
                createdAt: 1,
                metadata: { host: 'offline-fixed-voice-target' },
            },
        ];
        storageState.voiceExecutionMachine = {
            mode: 'fixed',
            machineId: 'machine-b',
            autoMachineId: null,
        };
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 5,
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
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
            expect.objectContaining({ machineId: 'machine-a' }),
        );
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledWith(expect.objectContaining({ voice: null }));
    });

    it('reconciles selected app client Actions into the generic index while the fixed Voice machine is offline', async () => {
        storageState.machines = [
            {
                id: 'machine-a', active: true, activeAt: Date.now(), createdAt: 2,
                metadata: { host: 'online-app-action-target' },
            },
            {
                id: 'machine-b', active: false, activeAt: 0, createdAt: 1,
                metadata: { host: 'offline-fixed-voice-target' },
            },
        ];
        storageState.voiceExecutionMachine = {
            mode: 'fixed',
            machineId: 'machine-b',
            autoMachineId: null,
        };
        const pluginId = 'acme.app-shell-action-without-voice';
        const actionId = 'open-client-action';
        const actionArtifactId = 'client-action-runtime';
        const generation = 5;
        const entryPath = 'react-native/client-action-runtime/index.js';
        const bytes = new TextEncoder().encode('// synthetic AppShell client Action executable');
        const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestV1Schema.parse({
            version: 1,
            entries: [{
                contributionId: actionArtifactId,
                tier: 'reactNative',
                platform: 'web',
                entry: entryPath,
                files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }],
                digest: artifactDigest,
                builtWith: { bundler: 'vite', version: '7.0.0' },
                hostUiApiVersion: '1.0.0',
                compat: { react: '19.0.0', reactNative: '0.83.4' },
            }],
        }).entries[0]!;
        const cacheIdentity = Object.freeze({
            pluginId,
            contributionId: actionId,
            artifactDigest,
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'web' as const,
            channel: 'internal',
            nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
            projectionGeneration: generation,
        });
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-a',
            pluginId,
            artifacts: [{
                contributionId: actionArtifactId,
                tier: 'reactNative',
                platform: 'web',
                artifactDigest,
                compatibility: {
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.0.0',
                    reactNativeVersion: '0.83.4',
                },
            }],
        });
        const baseProjection = pluginUiProjectionWithClientAction({
            generation,
            pluginId,
            origin,
        });
        const baseClientAction = baseProjection.actionsById[`${pluginId}/${actionId}`];
        if (!baseClientAction) {
            throw new Error('AppShell client Action test fixture is missing its Action declaration');
        }
        const appProjection = PluginProjectionV2Schema.parse({
            ...baseProjection,
            actionsById: {
                ...baseProjection.actionsById,
                [`${pluginId}/${actionId}`]: {
                    ...baseClientAction,
                    authorization: {
                        generation: {
                            targetGeneration: String(generation),
                            desiredGeneration: String(generation),
                            appliedGeneration: String(generation),
                        },
                        resourceSelections: [],
                        scopedGrants: [],
                        serviceAvailability: [],
                        operatingSystemAuthorization: [],
                    },
                },
            },
            familiesById: {
                ...baseProjection.familiesById,
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        ...baseProjection.familiesById.pluginUi?.entriesById,
                        [`reactNativeBundle:${pluginId}:${actionId}`]: {
                            id: `reactNativeBundle:${pluginId}:${actionId}`,
                            pluginId,
                            serverIdentityId: origin.serverIdentityId,
                            materializationRef: origin.materializationRef,
                            contributionKind: 'reactNativeBundle',
                            contributionId: actionId,
                            generatedOwnerKind: 'clientContribution',
                            artifactGraph,
                            runtime: {
                                decision: { state: 'load' },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheIdentity,
                            },
                        },
                    },
                },
            },
        });
        const clientActionHeaderAction = Object.freeze({
            id: 'run-client-action',
            title: 'Run client action',
            command: Object.freeze({
                kind: 'executeAction' as const,
                action: Object.freeze({ pluginId, localId: actionId }),
            }),
        }) satisfies PluginUiPageHeaderActionProjection;
        const clientActionHeaderPage = Object.freeze({
            id: `plugin:${pluginId}:client-action`,
            pluginId,
        }) as unknown as PluginAppPage;
        const clientActionHeaderAuthority = Object.freeze({
            machineId: 'machine-a',
            serverId: 'server-1',
            generation,
            accountLifetime: null,
            executionOrigin: origin,
        }) satisfies PluginSurfaceLaunchAuthority;
        const appPluginUiFamily = appProjection.familiesById.pluginUi;
        const appActionBundle = appPluginUiFamily?.entriesById[`reactNativeBundle:${pluginId}:${actionId}`];
        if (!appPluginUiFamily || !appActionBundle) {
            throw new Error('AppShell client Action test fixture is missing its React Native bundle');
        }
        const malformedActionProjection = PluginProjectionV2Schema.parse({
            ...appProjection,
            familiesById: {
                ...appProjection.familiesById,
                pluginUi: {
                    ...appPluginUiFamily,
                    entriesById: {
                        ...appPluginUiFamily.entriesById,
                        [`reactNativeBundle:${pluginId}:${actionId}`]: {
                            ...appActionBundle,
                            generatedOwnerKind: undefined,
                        },
                    },
                },
            },
        });
        // The AppShell activation and page-header presentation both resolve
        // the installed host in production. Keep this composed test on that
        // same host rather than creating a test-only second registration index.
        const executableHost = getInstalledPluginUiExecutableModuleHost();
        const executableCache = createPluginReactNativeBundleCache();
        executableCache.putInstalledArtifact({ identity: cacheIdentity, bytes, format: 'plainJs' });
        let failActivation = true;
        const activate = vi.fn((api: PluginClientApi) => {
            if (failActivation) throw new Error('synthetic client executable activation failure');
            api.actions.register(actionId, async () => null);
        });
        const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'reactNativeWebModule',
            available: true,
            loadInstalledBundle: vi.fn(async () => activate),
        });
        const failedActivationArtifactAvailability = createAvailableClientArtifactHandle();
        pluginExecutableHostState.override = executableHost;
        appShellClientExecutableRuntimeState.cache = executableCache;
        appShellClientExecutableRuntimeState.loaderBackend = loaderBackend;
        appShellClientExecutableRuntimeState.availability = failedActivationArtifactAvailability.availability;
        appShellClientExecutableRuntimeState.useRealActivation = true;
        let describedAppProjection = appProjection;
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: machineId === 'machine-a'
                ? describedAppProjection
                : PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 5,
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
                }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
                <ClientActionHeaderPresentationProbe
                    action={clientActionHeaderAction}
                    page={clientActionHeaderPage}
                    actionAuthority={clientActionHeaderAuthority}
                />
            </AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 7 });

        expect(screen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection).toEqual(
            expect.objectContaining({
                actionsById: expect.objectContaining({
                    [`${pluginId}/${actionId}`]: expect.objectContaining({
                        hostOrigin: expect.objectContaining({ executionOrigin: origin }),
                    }),
                }),
                reactNativeBundlesById: expect.objectContaining({
                    [`reactNativeBundle:${pluginId}:${actionId}`]: expect.objectContaining({
                        hostOrigin: expect.objectContaining({ executionOrigin: origin }),
                    }),
                }),
            }),
        );
        await vi.waitFor(() => {
            expect(clientArtifactAvailabilitySpy).toHaveBeenCalledWith(expect.objectContaining({
                artifactOwnerKind: 'clientContribution',
                clientContribution: {
                    family: 'actions',
                    action: { pluginId, localId: actionId },
                },
            }));
        });
        await vi.waitFor(() => {
            expect(activate).toHaveBeenCalledTimes(1);
        });

        const registration = () => getPluginUiClientExecutableComposition(executableHost).read({
            family: 'actions',
            pluginId,
            localId: actionId,
            target: {
                artifactId: actionArtifactId,
                modulePath: './clientActionRuntime',
                exportName: 'activate',
                platform: 'web',
            },
            executionOrigin: origin,
            projectionGeneration: generation,
        });
        const headerControl = () => screen.tree.findByProps({
            testID: 'plugin-app-page-header-action:run-client-action',
        });
        // A typed executable activation failure is fail-closed at the generic
        // registration index. The daemon projection remains current, but no
        // client Action can be presented or dispatched before its target
        // commits the exact registration.
        expect(registration()).toBeNull();
        expect(failedActivationArtifactAvailability.dispose).toHaveBeenCalledTimes(1);
        expect(pluginRuntimeSpies.activate).not.toHaveBeenCalled();
        expect(headerControl().props.disabled).toBe(true);
        expect(headerControl().props.onPress).toBeUndefined();

        // Projection invalidation is the incumbent reload signal. It must
        // re-run the same complete-set owner without AppShell adding a retry
        // loop or a second availability projection.
        const recoveredActivationArtifactAvailability = createAvailableClientArtifactHandle();
        appShellClientExecutableRuntimeState.availability = recoveredActivationArtifactAvailability.availability;
        failActivation = false;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 6 });
        await vi.waitFor(() => {
            expect(registration()).not.toBeNull();
            expect(activate).toHaveBeenCalledTimes(2);
            const projectedAction = screen.tree.findByType('ProjectionProbe' as never)
                .props.value.pluginUiProjection?.actionsById[`${pluginId}/${actionId}`];
            expect(projectedAction).toEqual(expect.objectContaining({
                authorization: expect.any(Object),
                available: true,
            }));
            expect(resolvePluginUiClientActionRegistration({
                action: projectedAction!,
                projectionGeneration: generation,
                platform: 'web',
            })).not.toBeNull();
            expect(headerControl().props.disabled).toBe(false);
            expect(headerControl().props.onPress).toEqual(expect.any(Function));
        });
        const artifactAvailabilityCallCountBeforeMalformed = clientArtifactAvailabilitySpy.mock.calls.length;

        describedAppProjection = malformedActionProjection;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 6 });

        await vi.waitFor(() => {
            expect(registration()).toBeNull();
            expect(recoveredActivationArtifactAvailability.dispose).toHaveBeenCalledTimes(1);
        });
        expect(activate).toHaveBeenCalledTimes(2);
        expect(clientArtifactAvailabilitySpy).toHaveBeenCalledTimes(artifactAvailabilityCallCountBeforeMalformed);

        const accountTeardownArtifactAvailability = createAvailableClientArtifactHandle();
        appShellClientExecutableRuntimeState.availability = accountTeardownArtifactAvailability.availability;
        describedAppProjection = appProjection;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 6 });

        await vi.waitFor(() => {
            expect(registration()).not.toBeNull();
            expect(activate).toHaveBeenCalledTimes(3);
        });

        await act(async () => {
            installActiveAccountScope('account-after-client-action');
        });
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        await vi.waitFor(() => {
            expect(registration()).toBeNull();
            expect(accountTeardownArtifactAvailability.dispose).toHaveBeenCalledTimes(1);
        });
    });

    it('revokes an in-flight projection activation on unmount before same-generation remount', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });
        const firstActivation = createDeferred<never[]>();
        pluginRuntimeSpies.activate.mockImplementationOnce(async () => await firstActivation.promise);

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const first = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(1);
        const nullInvalidationsBeforeUnmount = pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null).length;

        await first.unmount();
        await flushHookEffects({ cycles: 2 });
        expect(pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null)).toHaveLength(
                nullInvalidationsBeforeUnmount + 1,
            );

        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(3);

        firstActivation.resolve([]);
        await flushHookEffects({ cycles: 4 });
        expect(pluginRuntimeSpies.invalidate.mock.calls
            .filter(([, next]) => (next as { generation?: unknown }).generation === null)).toHaveLength(
                nullInvalidationsBeforeUnmount + 1,
            );
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(3);
    });

    it('reapplies an unchanged projection when the Voice runtime host generation is replaced', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        const initialActivationCount = pluginRuntimeSpies.activate.mock.calls.length;
        expect(initialActivationCount).toBeGreaterThan(0);

        let replacementGeneration!: ReturnType<typeof acquireBundledConversationRuntimeGeneration>;
        await act(async () => {
            replacementGeneration = acquireBundledConversationRuntimeGeneration();
        });
        await flushHookEffects({ cycles: 5 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(initialActivationCount + 1);

        await screen.unmount();
        replacementGeneration.revoke();
    });

    it('keeps the active plugin runtime when the same target republishes the same projection generation', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });
        const initialActivationCount = pluginRuntimeSpies.activate.mock.calls.length;
        expect(initialActivationCount).toBeGreaterThan(0);
        const describesAfterInitialLoad = projectionDescribeSpy.mock.calls.length;
        const invalidationsAfterInitialLoad = pluginRuntimeSpies.invalidate.mock.calls.length;

        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now() + 1_000, metadata: { host: 'local' },
        }];
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 5 });

        // A presence-only republish carries no new projection authority, so it must
        // neither re-describe the target nor disturb the active runtime.
        expect(projectionDescribeSpy).toHaveBeenCalledTimes(describesAfterInitialLoad);
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledTimes(invalidationsAfterInitialLoad);
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(initialActivationCount);
    });

    it('does not load a projection when the app shell has no active machine scope', async () => {
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
            </AppShellPluginUiProjectionProvider>,
        );

        await flushHookEffects({ cycles: 2 });

        const probe = screen.tree.findByType('ProjectionProbe' as never);
        expect(projectionDescribeSpy).not.toHaveBeenCalled();
        expect(probe.props.value).toEqual(expect.objectContaining({
            machineId: null,
            pluginUiProjection: null,
        }));
    });

    it('revokes executable authority when the mounted app shell loses its machine target', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });
        pluginRuntimeSpies.activate.mockClear();

        storageState.machines = [];
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 5 });

        expect(pluginRuntimeSpies.activate).toHaveBeenCalledWith(expect.objectContaining({
            projection: expect.objectContaining({ generation: null }),
            voice: null,
        }));
    });

    it('reports scoped projection currentness to the central cache reconciler', async () => {
        storageState.machineTargets['machine-scoped'] = {
            daemonStateVersion: 5,
            isOnline: true,
        };
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: {
                v: 2, generation: 5, installedPackagesById: {}, agentsById: {}, backendsById: {},
                actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {},
                settingsById: {}, familiesById: {}, diagnostics: [],
            },
        });

        await renderScreen(<ScopedProjectionProbe />);
        await flushHookEffects({ cycles: 5 });

        expect(pluginRuntimeSpies.reconcileSourceUpdate).toHaveBeenCalled();
        expect(pluginRuntimeSpies.invalidate).not.toHaveBeenCalled();
        expect(pluginRuntimeSpies.replaceAuthority).not.toHaveBeenCalled();
    });

    it('keeps last-known projection authority inert until reconnect re-description settles', async () => {
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        const pluginId = 'acme.app-shell-reconnect-authority';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 5, pluginId, origin }),
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 5 });

        type AuthorityAwareProjection = Readonly<{
            pluginUiProjection: Readonly<{ generation: number | null }> | null;
            pluginBrowserProjection: Readonly<{ generation: number | null }> | null;
            interactionEnabled?: boolean;
        }>;
        const readProjection = (): AuthorityAwareProjection => (
            screen.tree.findByType('ProjectionProbe' as never).props.value as AuthorityAwareProjection
        );
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 5 }),
        }));
        const currentnessRequestEpochs = () => projectionDescribeSpy.mock.calls
            .map((call) => (call[1] as { requestEpoch?: unknown } | undefined)?.requestEpoch)
            .filter((requestEpoch): requestEpoch is string => typeof requestEpoch === 'string');
        const initialRequestEpoch = currentnessRequestEpochs().at(-1);
        expect(typeof initialRequestEpoch).toBe('string');

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: null,
        }));

        const reDescription = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        projectionDescribeSpy.mockReturnValueOnce(reDescription.promise);
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        const reconnectRequestEpoch = currentnessRequestEpochs().at(-1);
        expect(reconnectRequestEpoch).not.toBe(initialRequestEpoch);

        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: null,
        }));

        reDescription.resolve({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 6, pluginId, origin }),
        });
        await flushHookEffects({ cycles: 5 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 6 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 6 }),
        }));
    });

    it('normalizes Tauri Voice preparation to web, then unwinds it offline until fresh re-description', async () => {
        const declaration = requireConversationDeclaration(PluginContributesV2Schema.parse({
            voiceProviders: [{
                id: 'conversation',
                title: 'Synthetic',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    turn: { cancelResponse: true, bargeIn: false },
                },
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceRuntime',
                    exportName: 'activate',
                },
            }],
        }).voiceProviders[0]!);
        const pluginId = 'acme.app-shell-currentness';
        const providerId = `${pluginId}/${declaration.id}`;
        const generation = 12;
        const entryPath = 'react-native/voice-runtime-web/index.js';
        const bytes = new TextEncoder().encode('// synthetic app-shell Voice executable');
        const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestV1Schema.parse({
            version: 1,
            entries: [{
                contributionId: declaration.client.artifactId,
                tier: 'reactNative',
                platform: 'web',
                entry: entryPath,
                files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }],
                digest,
                builtWith: { bundler: 'vite', version: '7.0.0' },
                hostUiApiVersion: '1.0.0',
                compat: { react: '19.0.0', reactNative: '0.83.4' },
            }],
        }).entries[0]!;
        const identity = Object.freeze({
            pluginId,
            contributionId: declaration.id,
            artifactDigest: digest,
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'web' as const,
            channel: 'internal',
            nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
            projectionGeneration: generation,
        });
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
            artifacts: [{
                contributionId: declaration.client.artifactId,
                tier: 'reactNative',
                platform: 'web',
                artifactDigest: digest,
                compatibility: {
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.0.0',
                    reactNativeVersion: '0.83.4',
                },
            }],
        });
        const rawProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {
                voiceProviders: {
                    family: 'voiceProviders',
                    entriesById: {
                        [providerId]: {
                            id: providerId,
                            pluginId,
                            generation,
                            contributionKey: providerId,
                            definition: declaration,
                        },
                    },
                },
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        [`reactNativeBundle:${pluginId}:${declaration.id}`]: {
                            id: `reactNativeBundle:${pluginId}:${declaration.id}`,
                            pluginId,
                            serverIdentityId: origin.serverIdentityId,
                            materializationRef: origin.materializationRef,
                            contributionKind: 'reactNativeBundle',
                            contributionId: declaration.id,
                            artifactGraph,
                            runtime: {
                                decision: { state: 'load' },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheIdentity: identity,
                            },
                        },
                    },
                },
            },
            diagnostics: [],
        });
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        localServicePreviewPlatformState.platform = 'desktop';
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        let reconnectDescription: ReturnType<typeof createDeferred<{
            supported: true;
            projection: typeof rawProjection;
        }>> | null = null;
        projectionDescribeSpy.mockImplementation((
            _machineId: string,
            options?: Readonly<{ requestEpoch?: unknown }>,
        ) => (
            typeof options?.requestEpoch === 'string' && reconnectDescription
                ? reconnectDescription.promise
                : Promise.resolve({ supported: true as const, projection: rawProjection })
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 8 });
        expect(pluginRuntimeSpies.activate).toHaveBeenLastCalledWith(expect.objectContaining({
            platform: 'web',
            reader: expect.objectContaining({ readCurrentArtifact: expect.any(Function) }),
            accountLifetime: expect.objectContaining({ isCurrent: expect.any(Function) }),
            // Platform normalization happens ONCE, on the reconciliation payload
            // itself (`platform: 'web'` above). The voice arm carries only the
            // direct-machine authority its projection came from, so asserting a
            // second platform here would police a field the owner no longer has.
            voice: expect.objectContaining({
                serverId: APP_SCOPE_FIXTURE.serverId,
                machineId: expect.any(String),
                projection: expect.objectContaining({
                    generation,
                    voiceProvidersById: expect.objectContaining({
                        [providerId]: expect.objectContaining({
                            generation,
                            definition: expect.objectContaining({
                                id: declaration.id,
                                kind: 'conversation',
                                platforms: ['web'],
                                client: expect.objectContaining({
                                    artifactId: declaration.client.artifactId,
                                }),
                            }),
                        }),
                    }),
                    reactNativeBundlesById: expect.objectContaining({
                        [`reactNativeBundle:${pluginId}:${declaration.id}`]: expect.objectContaining({
                            serverIdentityId: origin.serverIdentityId,
                            materializationRef: origin.materializationRef,
                            artifactGraph: expect.objectContaining({
                                contributionId: declaration.client.artifactId,
                                tier: 'reactNative',
                                platform: 'web',
                                digest,
                            }),
                            runtime: expect.objectContaining({
                                decision: { state: 'load' },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheIdentity: identity,
                            }),
                        }),
                    }),
                }),
            }),
        }));
        const initialActivationCount = pluginRuntimeSpies.activate.mock.calls.length;
        expect(initialActivationCount).toBeGreaterThan(0);

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(pluginRuntimeSpies.activate).toHaveBeenLastCalledWith(expect.objectContaining({ voice: null }));
        const activationCountAfterOffline = pluginRuntimeSpies.activate.mock.calls.length;

        reconnectDescription = createDeferred();
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(activationCountAfterOffline + 1);
        expect(pluginRuntimeSpies.activate).toHaveBeenLastCalledWith(expect.objectContaining({ voice: null }));

        reconnectDescription.resolve({ supported: true, projection: rawProjection });
        await flushHookEffects({ cycles: 8 });
        expect(pluginRuntimeSpies.activate).toHaveBeenCalledTimes(activationCountAfterOffline + 2);
    });

    it('ignores a pre-disconnect describe result that settles after reconnect starts', async () => {
        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        storageState.machines = [{
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'local' },
        }];
        storageState.machineTargets = {
            'machine-1': { daemonStateVersion: 5, isOnline: true },
        };
        const pluginId = 'acme.app-shell-reconnect-currentness';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        const beforeDisconnect = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        const afterReconnect = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        let currentnessRequestCount = 0;
        projectionDescribeSpy.mockImplementation((
            _machineId: string,
            options?: Readonly<{ requestEpoch?: unknown }>,
        ) => {
            if (typeof options?.requestEpoch !== 'string') {
                return Promise.resolve({
                    supported: true,
                    projection: pluginUiProjectionWithAppTab({ generation: 5, pluginId, origin }),
                });
            }
            currentnessRequestCount += 1;
            return currentnessRequestCount === 1
                ? beforeDisconnect.promise
                : afterReconnect.promise;
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(currentnessRequestCount).toBe(1);

        type AuthorityAwareProjection = Readonly<{
            pluginUiProjection: Readonly<{ generation: number | null }> | null;
            pluginBrowserProjection: Readonly<{ generation: number | null }> | null;
            interactionEnabled?: boolean;
        }>;
        const readProjection = (): AuthorityAwareProjection => (
            screen.tree.findByType('ProjectionProbe' as never).props.value as AuthorityAwareProjection
        );

        storageState.endpointConnectivity = { status: 'offline', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginBrowserProjection: null,
        }));

        storageState.endpointConnectivity = { status: 'online', lastConnectedAt: null };
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(currentnessRequestCount).toBe(2);

        beforeDisconnect.resolve({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 5, pluginId, origin }),
        });
        await flushHookEffects({ cycles: 3 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginBrowserProjection: null,
        }));

        afterReconnect.resolve({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 6, pluginId, origin }),
        });
        await flushHookEffects({ cycles: 5 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: true,
            pluginUiProjection: expect.objectContaining({ generation: 6 }),
            pluginBrowserProjection: expect.objectContaining({ generation: 6 }),
        }));
    });

    it('refetches the AppShell projection when its machine scope is invalidated after a plugin mutation', async () => {
        storageState.machines = [{
            id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' },
        }];
        const pluginId = 'acme.app-shell-invalidation-refresh';
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-1',
            pluginId,
        });
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation, pluginId, origin }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        const describesBeforeInvalidation = projectionDescribeSpy.mock.calls.length;
        pluginRuntimeSpies.invalidate.mockClear();

        generation = 6;
        await act(async () => projectionRefreshState.publish());
        await flushHookEffects({ cycles: 5 });

        expect(projectionDescribeSpy.mock.calls.length).toBeGreaterThan(describesBeforeInvalidation);
        expect(pluginRuntimeSpies.invalidate).toHaveBeenCalledWith(
            expect.objectContaining({ generation: 5 }),
            expect.objectContaining({ generation: 6 }),
        );
    });

    it('keeps a divergent same-owner descriptor visible as a fail-closed conflict', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket',
                pluginId: 'acme.same',
                title: machineId === 'machine-a' ? 'Machine A' : 'Machine B',
            }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getProjectedEntry('acme.same')).toMatchObject({
            projectionStatus: 'conflict',
            executable: false,
            projectedDescriptorCandidates: expect.arrayContaining([
                expect.objectContaining({ title: 'Machine A' }),
                expect.objectContaining({ title: 'Machine B' }),
            ]),
        });
    });

    it('keeps different descriptor owners with the same scalar presentation independently executable', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket',
                pluginId: machineId === 'machine-a' ? 'acme.plugin.a' : 'acme.plugin.b',
            }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({
            service: { pluginId: 'acme.plugin.a', localId: 'account' },
            executable: true,
        });
        expect(getProjectedEntry('acme.plugin.b')).toMatchObject({
            service: { pluginId: 'acme.plugin.b', localId: 'account' },
            executable: true,
        });
    });

    it('retains last-known-good through one machine transport failure and clears it when machines are removed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        let failMachineB = false;
        projectionDescribeSpy.mockImplementation(async (machineId: string) => {
            if (failMachineB && machineId === 'machine-b') throw new Error('offline');
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });

        failMachineB = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'partial_machine_failure' });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({
            projectionStatus: 'stale',
            executable: false,
            projectedDescriptor: expect.objectContaining({ pluginId: 'acme.plugin.a' }),
        });

        storageState.machines = [];
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 4 });
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready' });
    });

    it('keeps the scheduled union refresh on its own cadence while machine presence heartbeats replace machine records', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        const describesAfterMount = projectionDescribeSpy.mock.calls.length;

        // Daemon keep-alive republishes the same machine with a fresh `activeAt`.
        // Nothing the union depends on changed, so no machine may be re-described.
        for (let heartbeat = 0; heartbeat < 2; heartbeat += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
            storageState.machines = [
                { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            ];
            await screen.update(
                <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
            );
            await flushHookEffects({ cycles: 4 });
        }
        expect(projectionDescribeSpy.mock.calls.length).toBe(describesAfterMount);

        // The scheduled refresh still lands 30s after mount; heartbeats must not restart it.
        await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
        await flushHookEffects({ cycles: 4 });
        expect(projectionDescribeSpy.mock.calls.length).toBe(describesAfterMount + 1);
    });

    it('refreshes the global union so plugin disable or removal clears stale descriptors without a machine-list change', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let includeDescriptor = true;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: includeDescriptor
                ? projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' })
                : {
                    ...projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
                    familiesById: {},
                },
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });

        includeDescriptor = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
    });

    it('retains last-known-good through all-machine transport failure and recovers stale to ready', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let mode: 'ready' | 'failed' = 'ready';
        projectionDescribeSpy.mockImplementation(async () => {
            if (mode === 'failed') return { supported: false, reason: 'error' };
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready' });

        mode = 'failed';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
        expect(getProjectedEntry('acme.plugin.a')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.plugin.a' }));

        mode = 'ready';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ executable: true, supportsToken: true });
    });

    it('does not clear last-known-good for rejected or unsupported projection responses', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let mode: 'ready' | 'rejected' | 'unsupported' = 'ready';
        projectionDescribeSpy.mockImplementation(async () => {
            if (mode === 'unsupported') return { supported: false, reason: 'not-supported' };
            if (mode === 'rejected') return { supported: false, reason: 'error' };
            return { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }) };
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        mode = 'rejected';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'transport' });
        expect(getProjectedEntry('acme.plugin.a')?.projectedDescriptor).toBeTruthy();

        mode = 'unsupported';
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'unsupported' });
        expect(getProjectedEntry('acme.plugin.a')?.projectedDescriptor).toBeTruthy();
    });

    it('isolates last-known-good when the active server changes', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockImplementation(async (
            _machineId: string,
            options?: Parameters<MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']>[1],
        ) => (
            options?.serverId === 'server-1'
                ? { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.one' }) }
                : { supported: false, reason: 'error' }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.server.one')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.one' }));

        storageState.activeServer = { serverId: 'server-2', serverUrl: 'https://server-two.example.test', generation: 2 };
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'server-2', status: 'error' });
        expect(getProjectedEntry('acme.server.one')).toBeNull();
    });

    it('ignores a late projection from the previous server after a server switch', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const serverOne = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        projectionDescribeSpy.mockImplementation(async (
            _machineId: string,
            options?: Parameters<MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']>[1],
        ) => (
            options?.serverId === 'server-1'
                ? serverOne.promise
                : { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.two' }) }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        storageState.activeServer = { serverId: 'server-2', serverUrl: 'https://server-two.example.test', generation: 2 };
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.server.two')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.two' }));

        serverOne.resolve({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.one' }),
        });
        await flushHookEffects({ cycles: 4 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'server-2', status: 'ready' });
        expect(getProjectedEntry('acme.server.two')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.two' }));
    });

    it('synchronously removes same-server descriptors when the active Account changes', async () => {
        installActiveAccountScope('account-a');
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const accountB = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        let descriptorDescribes = 0;
        projectionDescribeSpy.mockImplementation((_machineId, options) => {
            if (options?.requestEpoch) {
                return Promise.resolve({ supported: true, projection: projection({}) });
            }
            descriptorDescribes += 1;
            return descriptorDescribes === 1
                ? Promise.resolve({
                    supported: true,
                    projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.account.a' }),
                })
                : accountB.promise;
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.account.a')?.projectedDescriptor).toEqual(
            expect.objectContaining({ pluginId: 'acme.account.a' }),
        );

        installActiveAccountScope('account-b');
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({
            scopeKey: 'server-1',
            status: 'loading',
            entries: [],
        });
        expect(getProjectedEntry('acme.account.a')).toBeNull();
    });

    it('does not commit a late same-server descriptor from the retired Account', async () => {
        installActiveAccountScope('account-a');
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const accountA = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        const accountB = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        let descriptorDescribes = 0;
        projectionDescribeSpy.mockImplementation((_machineId, options) => {
            // App-shell plugin UI projection currentness shares this daemon
            // boundary, but descriptor union reads are the behavior under test.
            if (options?.requestEpoch) {
                return Promise.resolve({ supported: true, projection: projection({}) });
            }
            descriptorDescribes += 1;
            return descriptorDescribes === 1 ? accountA.promise : accountB.promise;
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        installActiveAccountScope('account-b');
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });
        expect(descriptorDescribes).toBe(2);

        accountB.resolve({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.account.b' }),
        });
        await flushHookEffects({ cycles: 4 });
        expect(getProjectedEntry('acme.account.b')?.projectedDescriptor).toEqual(
            expect.objectContaining({ pluginId: 'acme.account.b' }),
        );

        accountA.resolve({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.account.a' }),
        });
        await flushHookEffects({ cycles: 4 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({
            scopeKey: 'server-1',
            status: 'ready',
        });
        expect(getProjectedEntry('acme.account.b')?.projectedDescriptor).toEqual(
            expect.objectContaining({ pluginId: 'acme.account.b' }),
        );
        expect(getProjectedEntry('acme.account.a')).toBeNull();
    });

    it('removes a descriptor when its machine ages out of the online grace period', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-13T00:00:00Z'));
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });

        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
        await flushHookEffects({ cycles: 4 });
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
    });

    it('withholds app-scope contributions while Account Availability has not loaded', async () => {
        storageState.machines = [
            { id: 'machine-newer', active: true, activeAt: Date.now(), metadata: { host: 'newer-heartbeat' } },
            { id: 'machine-older', active: true, activeAt: Date.now() - 30_000, metadata: { host: 'older-heartbeat' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: machineId === 'machine-older'
                // The entry carries an exact producer stamp, so it is a
                // MATERIALIZED contribution awaiting Administration selection.
                // (An unstamped contribution has no selection to wait for and
                // is admitted structurally; that arm belongs to the union owner
                // and must not be what this test accidentally exercises.)
                ? pluginUiProjectionWithAppTab({
                    generation: 7,
                    pluginId: 'acme.inspector',
                    origin: unselectedAppScopeOrigin({
                        machineId: 'machine-older',
                        pluginId: 'acme.inspector',
                    }),
                })
                : {
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
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
                <RightSidebarTabProbe />
            </AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        // Both machines are described AS PROJECTION TARGETS — `requestEpoch` is
        // stamped only by the plugin-UI currentness owner, so this cannot be
        // satisfied by the connected-account union that describes every machine
        // for its own reasons.
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-older', expect.objectContaining({
            requestEpoch: expect.stringContaining('server-1:machine-older'),
        }));
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-newer', expect.objectContaining({
            requestEpoch: expect.stringContaining('server-1:machine-newer'),
        }));

        // No Account Availability reader exists in this harness. F7 fails closed
        // rather than deriving a source from projection order or freshness.
        expect(screen.tree.findByType('RightSidebarTabProbe' as never).props.value).toBe(false);

        const value = screen.tree.findByType('ProjectionProbe' as never).props.value;
        const placements = value.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(value.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements).toEqual([]);
        expect(value.pluginUiProjection).toBeNull();
        // No single machine owns the app scope, and none is inferred from `activeAt`.
        expect(value.machineId).toBeNull();
    });

    it('does not elect a source for different app plugins before selection, even across heartbeats', async () => {
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
            </AppShellPluginUiProjectionProvider>
        );
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now() - 20_000, metadata: { host: 'b' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: machineId === 'machine-a'
                // Both contributions are exactly stamped, so each is selectable
                // and neither may be elected before Administration selects one.
                ? pluginUiProjectionWithAppTab({
                    generation: 3,
                    pluginId: 'acme.alpha',
                    origin: unselectedAppScopeOrigin({
                        machineId: 'machine-a',
                        pluginId: 'acme.alpha',
                    }),
                })
                : pluginUiProjectionWithAppTab({
                    generation: 4,
                    pluginId: 'acme.beta',
                    origin: unselectedAppScopeOrigin({
                        machineId: 'machine-b',
                        pluginId: 'acme.beta',
                    }),
                }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 6 });

        const readPlacements = () => {
            const projection = screen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection;
            return projection
                ? selectPluginSurfacePlacementsForBinding(projection, {
                    container: 'rightSidebarTab',
                    targetKind: 'app',
                })
                : [];
        };
        expect(readPlacements()).toEqual([]);
        const projectionBeforeHeartbeat = screen.tree.findByType('ProjectionProbe' as never)
            .props.value.pluginUiProjection;

        // A presence-only republish that reverses the heartbeat order changes
        // nothing: the union is not ordered by, or selected on, `activeAt`.
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now() - 40_000, metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now() + 1_000, metadata: { host: 'b' } },
        ];
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 4 });

        expect(screen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection)
            .toBe(projectionBeforeHeartbeat);
    });

    it('clears account-scoped projected descriptors when the app-shell owner unmounts', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        projectionDescribeSpy.mockResolvedValue({
            supported: true,
            projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });

        await screen.unmount();
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
    });
});
