import { publishMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    PluginContributesV2Schema,
    PluginProjectionV2Schema,
    type PluginProjectionV2,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';
import { PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1, type PluginMachineMaterializationExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { DaemonPluginUiArtifactBytesReadResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import {
    PluginUiArtifactsManifestV2Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiSettingsPageBindingV1,
} from '@happier-dev/protocol/plugins/ui';

import { createDeferred, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import * as projectionCurrentness from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import * as executionOriginSelection from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import * as translationRuntime from '@/sync/domains/plugins/ui/i18n';
import * as translationBytes from '@/sync/domains/plugins/availability/translationResourceBytes';
import {
    selectCurrentAppShellPluginUiCurrentness,
    isAppShellPluginClientExecutableAvailable,
    settleAppShellPluginRuntimeUpdate,
    resolveAppShellPluginProjectionTargets,
    useAppShellPluginUiProjection,
    useAppShellPluginUiDeclarationProjection,
    useProjectedPluginLocalizedTextResolver,
    AppShellPluginUiProjectionValueProvider,
    type AppShellPluginUiProjectionValue,
} from './AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION, createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { getCurrentAppShellVoiceProviderActivation, publishCommittedAppShellPluginUiProjection, readCurrentAppShellPluginUiProjection,
    subscribeCommittedAppShellPluginUiProjection } from './committedPluginUiProjection';
import { createAppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';
import { selectPluginSurfacePlacementsForBinding } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { resolveAdmittedPluginSettingsPage } from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';
import { resolvePluginAppPages, selectPluginAppPagePlacements } from './pluginAppPages';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionUnion';
import {
    getQualifiedConnectedServiceRegistryEntry,
    getConnectedServiceRegistrySnapshot,
    installConnectedAccountDescriptorProjection,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import type {
    VoiceConversationProviderContribution,
} from '@/voice/registry/externalVoiceProviderActivation';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    readPluginAccountAvailability,
} from '@/sync/domains/plugins/availability/projection';
import type {
    PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';
import {
    captureActiveServerAccountScopeLifetime,
    retireActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { storage as persistentStorage } from '@/sync/domains/state/storageStore';
import { normalizeAccountSettingsForLocalStorage } from '@/sync/domains/settings/accountSettingsNormalization';
import { clearPluginMachineExecutionOriginPreference, setPluginMachineExecutionOriginPreference } from '@/sync/domains/machines/administration/selectionPreferences';
import { usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import { useMountedTargetedContributions } from '@/components/plugins/surfaces/mountedTargetedContributions';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiPageHeaderActionProjection, PluginUiPhysicalSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    getServerProfileById,
    resetServerProfilesRuntimeForTests,
    setActiveServerId,
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    derivePluginReactNativeBundleCacheKey,
    getInstalledPluginReactNativeBundleCache,
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
import { publishMachineContributionRegistryProjectionReconnect } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';

describe('app-shell projection bootstrap targets', () => {
    it('restores retained presentation targets before live machine inventory arrives', () => {
        expect(resolveAppShellPluginProjectionTargets({
            activeServerId: 'home-1',
            onlineMachineIds: [],
            retainedMachineIds: ['machine-1'],
        })).toEqual([{ machineId: 'machine-1', serverId: 'home-1' }]);
        expect(resolveAppShellPluginProjectionTargets({
            activeServerId: 'home-1', onlineMachineIds: [], retainedMachineIds: [],
        })).toEqual([]);
    });
});

describe('AppShell declaration subscriptions', () => {
    it('retains one translation runtime across same-Account layout reconnections and unrelated renders', async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Account fixture must establish a lifetime');
        const create = vi.spyOn(translationRuntime, 'createPluginUiTranslationRuntime');
        onTestFinished(() => create.mockRestore());
        const createReader = vi.spyOn(translationBytes, 'createPluginUiTranslationResourceByteReader');
        onTestFinished(() => createReader.mockRestore());
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: lifetime, connectedAccountProjectionRevision: 1,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        let suspended = false;
        let pending = createDeferred<void>();
        function RetainedDestination() {
            if (suspended) throw pending.promise;
            return null;
        }
        const element = (revision: number) => <React.Suspense fallback={null}>
            <AppShellPluginUiProjectionValueProvider value={{ ...value, connectedAccountProjectionRevision: revision }}>
                <RetainedDestination />
            </AppShellPluginUiProjectionValueProvider>
        </React.Suspense>;
        const screen = await renderScreen(element(1));
        onTestFinished(() => screen.unmount());
        expect(create).toHaveBeenCalledTimes(1);
        const readersAfterMount = createReader.mock.calls.length;
        expect(readersAfterMount).toBeGreaterThan(0);
        for (let revision = 2; revision <= 21; revision++) {
            suspended = true;
            pending = createDeferred<void>();
            await screen.update(element(revision));
            suspended = false;
            await act(async () => pending.resolve());
            await screen.update(element(revision));
        }
        // Layout reconnection is presentation, not a new translation source.
        expect(create).toHaveBeenCalledTimes(1);
        expect(createReader).toHaveBeenCalledTimes(readersAfterMount);
    });

    it('does not relabel a retained declaration with the newly active Account lifetime', async () => {
        const accountA = captureActiveServerAccountScopeLifetime();
        if (!accountA) throw new Error('Account fixture must establish a lifetime');
        const projectionA = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 917 };
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: projectionA, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: accountA,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{null}</AppShellPluginUiProjectionValueProvider>);
        onTestFinished(() => screen.unmount());
        expect(readCurrentAppShellPluginUiProjection()).toBe(projectionA);
        await act(async () => { installActiveAccountScope('account-publication-b'); });
        const accountB = captureActiveServerAccountScopeLifetime();
        expect(accountA.isCurrent()).toBe(false);
        expect(accountB?.scope.accountId).toBe('account-publication-b');
        // A retained props value is still A's value even after another render
        // captures B. The committed boundary cannot re-admit it under B.
        await screen.update(<AppShellPluginUiProjectionValueProvider value={{ ...value,
            connectedAccountProjectionRevision: 2 }}>{null}</AppShellPluginUiProjectionValueProvider>);
        expect(readCurrentAppShellPluginUiProjection()).toBeNull();
        expect(readCurrentAppShellPluginUiProjection({ scope: accountB!.scope, declarationsOnly: true })).toBeNull();
    });

    it('updates declared plugin text when the ready locale changes without a new projection', async () => {
        const previousLanguage = getPreferredLanguage();
        onTestFinished(() => commitPreferredLanguage(previousLanguage));
        commitPreferredLanguage('en');
        const projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            translationsByPluginId: {
                'acme.review': {
                    id: 'translations:acme.review', pluginId: 'acme.review', contributionKind: 'translations' as const,
                    locales: ['en', 'fr'], bundles: { en: { title: 'Review' }, fr: { title: 'Revue' } },
                },
            },
        };
        let title = '';
        function Probe() {
            title = useProjectedPluginLocalizedTextResolver()('acme.review', { key: 'title', fallback: 'Fallback' });
            return null;
        }
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: projection, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 1,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}><Probe /></AppShellPluginUiProjectionValueProvider>);
        onTestFinished(() => screen.unmount());
        expect(title).toBe('Review');
        await act(async () => commitPreferredLanguage('fr'));
        expect(title).toBe('Revue');
    });

    it('keeps declaration-only consumers renderless across executable diagnostics and publishes changed declarations', async () => {
        let renders = 0;
        let executableRevision: AppShellPluginUiProjectionValue['connectedAccountProjectionRevision'] = 0;
        let seen: AppShellPluginUiProjectionValue['pluginUiProjection'] = null;
        const Probe = React.memo(function DeclarationProbe() {
            renders += 1;
            seen = useAppShellPluginUiDeclarationProjection();
            return null;
        });
        function ExecutableProbe() {
            executableRevision = useAppShellPluginUiProjection().connectedAccountProjectionRevision;
            return null;
        }
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
            platform: 'web', accountLifetime: null, connectedAccountProjectionRevision: 1,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        const render = (next: AppShellPluginUiProjectionValue) => (
            <AppShellPluginUiProjectionValueProvider value={next}><Probe /><ExecutableProbe /></AppShellPluginUiProjectionValueProvider>
        );
        const screen = await renderScreen(render(value));
        onTestFinished(() => screen.unmount());
        expect(seen).toBe(value.pluginUiProjection);
        const settledRenders = renders;
        await screen.update(render({ ...value, connectedAccountProjectionRevision: 2,
            clientExecutableActivation: { status: 'establishing' } }));
        expect(executableRevision).toBe(2);
        expect(renders).toBe(settledRenders);
        const nextProjection = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            'acme.changed': { id: 'translations:acme.changed', pluginId: 'acme.changed', contributionKind: 'translations' as const,
                locales: ['en'], bundles: { en: { title: 'Changed declaration' } } },
        } };
        await screen.update(render({ ...value, pluginUiProjection: nextProjection }));
        expect(seen).toBe(nextProjection);
        expect(renders).toBeGreaterThan(settledRenders);
    });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MachineContributionRegistryProjectionModule = typeof import(
    '@/sync/ops/machineContributionRegistryProjection'
);
type SupportedMachineContributionRegistryProjectionDescribeResult = Extract<
    Awaited<ReturnType<MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']>>,
    Readonly<{ supported: true }>
>;

const projectionDescribeSpy = vi.hoisted(() => vi.fn<
    MachineContributionRegistryProjectionModule['machineContributionRegistryProjectionDescribe']
>());
const artifactByteRead = vi.hoisted(() => vi.fn<(
    params: ServerScopedMachineRpcParams<unknown>,
) => Promise<DaemonPluginUiArtifactBytesReadResponse>>());
const targetedProjectionRead = vi.hoisted(() => vi.fn<(
    params: ServerScopedMachineRpcParams<unknown>,
) => Promise<unknown>>());
const pluginExecutableHostState = vi.hoisted(() => ({
    override: null as PluginUiExecutableModuleHost | null,
}));
const appShellClientExecutableRuntimeState = vi.hoisted(() => ({
    loaderBackend: null as PluginReactNativeLoaderBackend | null,
}));
type InventoryMachine = Pick<Machine, 'id' | 'active' | 'activeAt'> & Partial<Omit<Machine, 'metadata'>> & {
    metadata?: Machine['metadata'] | Readonly<{ host: string }>;
};
const storageState = {
    get machines(): Machine[] {
        return Object.values(persistentStorage.getState().machines);
    },
    set machines(inputs: readonly InventoryMachine[]) {
        const machines = inputs.map((input): Machine => {
            const machine = createLiveMachine(input.id);
            if (!machine.metadata) throw new Error('Live Machine fixture must have opened metadata');
            return { ...machine, ...input, metadata: input.metadata === null
                ? null : { ...machine.metadata, ...input.metadata } };
        });
        const serverId = this.activeServer.serverId;
        persistentStorage.setState((state) => ({
            machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
            machineListByServerId: { ...state.machineListByServerId, [serverId]: machines },
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [serverId]: 'idle' },
        }));
    },
    get voiceExecutionMachine() {
        return persistentStorage.getState().settings.voice.executionMachine;
    },
    set voiceExecutionMachine(value: { mode: 'auto' | 'fixed'; machineId: string | null }) {
        persistentStorage.setState((state) => ({
            settings: { ...state.settings, voice: { ...state.settings.voice, executionMachine: value } },
        }));
    },
    activeServer: { serverId: 'srv_app_shell_fixture', serverUrl: 'https://app-shell-fixture.example.test', generation: 1 },
    set machineTargets(targets: Record<string, { daemonStateVersion: number; isOnline: boolean }>) {
        this.machines = this.machines.map((machine) => ({
            ...machine,
            ...(targets[machine.id] ? {
                daemonStateVersion: targets[machine.id].daemonStateVersion,
                active: targets[machine.id].isOnline,
            } : {}),
        }));
    },
};
const localServicePreviewPlatformState = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android' | 'desktop',
}));
const projectionRefreshState = { publish: publishMachineContributionRegistryProjectionReconnect };


import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
// Only the network boundary is replaced. Revision publication and every
// projection/currentness owner beneath it remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { answerMachineProjectionDescribeAtRpcBoundary } = await import('@/dev/testkit/mocks/machineProjectionRpc');
    const describe = answerMachineProjectionDescribeAtRpcBoundary(
        (machineId, options) => projectionDescribeSpy(machineId, options),
    );
    return {
        machineRpcWithServerScope: (params: ServerScopedMachineRpcParams<unknown>) => (
            params.method === RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ
                ? artifactByteRead(params)
                : params.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ
                    ? targetedProjectionRead(params)
                : describe(params)
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


vi.mock('@/sync/domains/local/services/preview/platform', () => ({
    resolveLocalServicePreviewPlatform: () => localServicePreviewPlatformState.platform,
}));


const initialPersistentStorageState = persistentStorage.getState();

beforeEach(async () => {
    resetServerProfilesRuntimeForTests();
    // Routed credential hooks normalize through the real configured-Home owner,
    // not the scheduling fixture's presentation-only profile list.
    await upsertServerProfile({ serverUrl: storageState.activeServer.serverUrl, name: 'Test Home', source: 'manual' });
    const profile = await setServerProfileIdentityForUrl(storageState.activeServer.serverUrl, storageState.activeServer.serverId);
    expect(profile?.serverIdentityId).toBe(storageState.activeServer.serverId);
    await setActiveServerId(storageState.activeServer.serverId);
    storageState.activeServer = getActiveServerSnapshot();
    persistentStorage.setState({ endpointStatus: 'online' });
    // Secure storage is the credential boundary; routed admission and lifetime
    // creation remain real and read the Account currently installed by the fixture.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => ({
        token: `header.${Buffer.from(JSON.stringify({ sub: persistentStorage.getState().profileScope?.accountId ?? 'account-fixture' })).toString('base64url')}.signature`,
    }));
    installActiveAccountScope(APP_SCOPE_FIXTURE.accountId);
    expect(await resolveServerCredentialAccountScope(storageState.activeServer.serverId)).toEqual({
        kind: 'bound', scope: { serverId: storageState.activeServer.serverId, accountId: APP_SCOPE_FIXTURE.accountId },
        credentialKey: expect.any(String),
    });
});

afterEach(async () => {
    vi.useRealTimers();
    standardCleanup();
    clearMachineRequestReachabilityForTest();
    const executableHost = pluginExecutableHostState.override;
    if (executableHost) {
        await getPluginUiClientExecutableComposition(executableHost).unload();
    }
    clearPluginAccountAvailabilityProjection();
    retireActiveServerAccountScopeLifetime();
    persistentStorage.setState(initialPersistentStorageState, true);
    projectionDescribeSpy.mockReset();
    artifactByteRead.mockReset();
    targetedProjectionRead.mockReset();
    pluginExecutableHostState.override = null;
    appShellClientExecutableRuntimeState.loaderBackend = null;
    storageState.machines = [];
    storageState.voiceExecutionMachine = {
        mode: 'auto',
        machineId: null,
    };
    storageState.activeServer = { serverId: 'srv_app_shell_fixture', serverUrl: 'https://app-shell-fixture.example.test', generation: 1 };
    storageState.machineTargets = {};
    localServicePreviewPlatformState.platform = 'web';
    // The one per-machine projection owner is module state shared by every
    // reader; a case that left a describe pending must not strand the next.
    clearDaemonMergedProjectionCacheForTests();
    // This suite runs the real transport: a case that left a describe pending
    // must not strand the next case's read on that dead in-flight request.
    resetMachineProjectionReadsForTests();
    installConnectedAccountDescriptorProjection(createConnectedAccountDescriptorProjectionLoadingState('test-cleanup'));
});

function projection(entriesById: Record<string, unknown>): PluginProjectionV2 {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 5,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {},


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
    serverId: 'srv_app_shell_fixture',
    serverIdentityId: 'srv_app_shell_fixture',
});
const APP_SCOPE_ARCHIVE_DIGEST = computePluginUiArtifactSha256DigestV1(
    new TextEncoder().encode('app-shell-fixture-release'),
);

type AppScopeArtifactFixture = Readonly<{
    contributionId: string;
    artifactId: string;
    tier: 'reactNative';
    platform: 'web';
    artifactDigest: `sha256:${string}`;
    hostUiApiRange: string;
}>;

function createLiveMachine(machineId: string): Machine {
    return createMachineFixture({ id: machineId, activeAt: Date.now() });
}

/**
 * Supplies the real Account Availability and Administration inputs for an
 * AppShell union. Visibility precedes execution selection. Tests needing
 * executable authority supply real Account scope, exact release materialization,
 * live inventory and the existing Administration preference.
 */
function installSelectedAppScopePluginFixture(input: Readonly<{
    machineId: string;
    pluginId: string;
    replicaMachineIds?: readonly string[];
    selectOrigin?: boolean;
    materializationEnabled?: boolean;
    artifacts?: readonly AppScopeArtifactFixture[];
    accountId?: string;
    contributes?: ReturnType<typeof PluginContributesV2Schema.parse>;
    releaseMetadataPending?: boolean;
}>): PluginMachineMaterializationExecutionOriginV1 {
    const artifacts = input.artifacts ?? [];
    const accountId = input.accountId ?? APP_SCOPE_FIXTURE.accountId;
    const serverId = storageState.activeServer.serverId;
    const origin: PluginMachineMaterializationExecutionOriginV1 = Object.freeze({
        serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
        materializationRef: Object.freeze({
            machineId: input.machineId,
            materializationId: `${input.machineId}:${input.pluginId}:install`,
            pluginId: input.pluginId,
        }),
    });
    const machine = createLiveMachine(input.machineId);
    const machines = [...storageState.machines.filter((candidate) => candidate.id !== machine.id), machine];
    const previous = persistentStorage.getState();
    persistentStorage.setState({
        isDataReady: true,
        profile: { ...previous.profile, id: accountId },
        profileScope: {
            serverId,
            accountId,
        },
        machines: Object.fromEntries(machines.map((candidate) => [candidate.id, candidate])),
        machineListByServerId: {
            ...(previous.machineListByServerId ?? {}),
            [serverId]: machines,
            [APP_SCOPE_FIXTURE.serverIdentityId]: machines,
        },
        machineListStatusByServerId: {
            ...(previous.machineListStatusByServerId ?? {}),
            [serverId]: 'idle',
            [APP_SCOPE_FIXTURE.serverIdentityId]: 'idle',
        },
        settings: {
            ...previous.settings,
            voice: { ...previous.settings.voice, executionMachine: storageState.voiceExecutionMachine },
            machineAdministrationTargetsLocalV1: input.selectOrigin === false
                ? clearPluginMachineExecutionOriginPreference(previous.settings.machineAdministrationTargetsLocalV1, input.pluginId)
                : setPluginMachineExecutionOriginPreference(previous.settings.machineAdministrationTargetsLocalV1, input.pluginId, origin),
        },
    });

    const materialization: PluginAccountAvailabilitySnapshot['materializations'][number] = {
        serverIdentityId: origin.serverIdentityId,
        machineId: origin.materializationRef.machineId,
        materializationId: origin.materializationRef.materializationId,
        pluginId: origin.materializationRef.pluginId,
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        archiveDigestSha256: APP_SCOPE_ARCHIVE_DIGEST,
        uiArtifacts: artifacts,
        enabled: input.materializationEnabled ?? true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const materializations = [materialization, ...(input.replicaMachineIds ?? []).map(machineId => ({
        ...materialization, machineId, materializationId: `${machineId}:${input.pluginId}:install`,
    }))];
    const snapshot: PluginAccountAvailabilitySnapshot = {
        availabilityCursor: 1,
        intentReads: [{
            pluginId: input.pluginId,
            response: {
                availabilityCursor: 1,
                packageAssets: [],
                hostingCapability: { enabled: false },
                intent: {
                    pluginId: input.pluginId,
                    desiredVersion: '1.0.0',
                    enabled: true,
                    offlineUiHosting: 'disabled',
                    writableCollections: [],
                    revision: 'fixture-1',
                },
                release: input.releaseMetadataPending ? null : {
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
                        contributes: input.contributes ?? PluginContributesV2Schema.parse({}),
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
        materializations,
        snapshots: materializations.map(candidate => ({
            serverIdentityId: candidate.serverIdentityId,
            machineId: candidate.machineId,
            materializations: [candidate],
        })),
    };
    // Retire the incumbent before publishing its successor's Availability;
    // the real mounted Account hook clears the incumbent projection on retire.
    installActiveAccountLifetime(accountId);
    replacePluginAccountAvailabilityProjection({
        scope: {
            serverId,
            accountId,
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
        profileScope: { serverId: storageState.activeServer.serverId, accountId },
    }, true);
    installActiveAccountLifetime(accountId);
}

async function activateFixtureHome(serverId: string, serverUrl: string): Promise<void> {
    const inventory = storageState.machines;
    await upsertServerProfile({ serverUrl, name: 'Test Home', source: 'manual' });
    const home = await setServerProfileIdentityForUrl(serverUrl, serverId);
    expect(home?.serverIdentityId).toBe(serverId);
    await setActiveServerId(serverId);
    storageState.activeServer = getActiveServerSnapshot();
    storageState.machines = inventory;
}

async function publishActiveAccountCredentials(): Promise<void> {
    const profile = getServerProfileById(storageState.activeServer.serverId);
    if (!profile) throw new Error('Account fixture has no Home profile');
    const accountId = persistentStorage.getState().profileScope?.accountId;
    if (!accountId) throw new Error('Account fixture has no Account');
    // Exercise the real Home credential-mutation fanout. Updating ambient
    // profileScope alone cannot retire an explicitly routed credential binding.
    expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, {
        serverId: storageState.activeServer.serverId,
    }, {
        token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    })).toBe(true);
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

function SourceExecutionProbe(props: Readonly<{ pluginId: string }>) {
    const { pluginUiProjection } = useAppShellPluginUiProjection();
    const execution = usePluginSurfaceExecutionOrigin({ pluginId: props.pluginId, projection: pluginUiProjection,
        entry: Object.values<PluginUiPhysicalSurfacePlacementProjection>(pluginUiProjection?.surfacePlacementsById ?? {})
            .find(entry => entry.pluginId === props.pluginId), enabled: true });
    return React.createElement('SourceExecutionProbe', { execution });
}

function PendingSourceExecutionProbe(props: Readonly<{ pluginId: string }>) {
    const { pluginUiProjection, accountLifetime } = useAppShellPluginUiProjection();
    const execution = usePluginSurfaceExecutionOrigin({ pluginId: props.pluginId, projection: pluginUiProjection,
        entry: Object.values(pluginUiProjection?.surfacePlacementsById ?? {})
            .find(entry => entry.pluginId === props.pluginId), enabled: true });
    // These are the real mount inputs from PluginSurfaceHost: withdrawing the
    // selected supplier retires the read even when its plugin did not reload.
    const targeted = useMountedTargetedContributions({ accountLifetime, machineId: execution.selectedSupply?.machineId,
        serverId: execution.selectedSupply?.serverId, pluginId: props.pluginId,
        mountedOccurrenceId: execution.selectedSupply?.occurrenceId,
        enabled: Boolean(execution.selectedSupply?.occurrenceId) });
    return React.createElement('PendingSourceExecutionProbe', { execution, targeted });
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

function accountLifetimeFixture(input: Readonly<{
    accountId: string;
    isCurrent?: () => boolean;
}>) {
    return {
        scope: { serverId: 'srv_app_shell_fixture', accountId: input.accountId },
        isCurrent: input.isCurrent ?? (() => true),
        onRetire: () => ({ dispose() {} }),
    } as const;
}

function installActiveAccountLifetime(accountId: string): ActiveServerAccountScopeLifetime {
    // Admit the fixture's restored Home through the real connection projection;
    // profileScope is already installed in the canonical storage boundary.
    publishAppliedActiveServerSnapshot(storageState.activeServer);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || lifetime.scope.accountId !== accountId) throw new Error('Account fixture was not admitted');
    return lifetime;
}

function unselectedAppScopeOrigin(input: Readonly<{
    machineId: string;
    pluginId: string;
}>): PluginMachineMaterializationExecutionOriginV1 {
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
    container?: 'rightSidebarTab' | 'appPage';
    title?: string;
}>): PluginProjectionV2 {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
        schemaVersion: 2, id: input.pluginId, version: '1.0.0', displayName: input.pluginId,
        runtime: { apiVersion: 1 }, contributes: appTabContributes(input),
    });
    const declarations = projectPluginPortableUiDeclarationsV1(manifest);
    const occurrenceId = (input.origin && 'materializationRef' in input.origin ? input.origin.materializationRef.materializationId : undefined)
        ?? `${input.pluginId}:${input.localId ?? 'panel'}:occurrence`;
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: input.generation,
        installedPackagesById: {},
        agentsById: {},
        actionsById: {},


        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: Object.fromEntries(Object.entries(declarations).map(([id, entry]) => [id, {
                    ...entry, occurrenceId,
                    ...(input.origin ? { executionOrigin: PluginMachineExecutionOriginV1Schema.parse(input.origin) } : {}),
                }])),
            },
        },
        diagnostics: [],
    });
}

function appTabContributes(input: Readonly<{
    localId?: string;
    container?: 'rightSidebarTab' | 'appPage';
    title?: string;
}> = {}): ReturnType<typeof PluginContributesV2Schema.parse> {
    return PluginContributesV2Schema.parse({ ui: {
        renderers: [{ id: 'inspector', kind: 'declarative', root: { kind: 'text', text: 'Panel' } }],
        views: [{ id: input.localId ?? 'panel', container: input.container ?? 'rightSidebarTab',
            target: { kind: 'app' }, title: input.title ?? 'Panel', renderer: 'inspector' }],
    } });
}

async function createAppShellClientActionFixture(input: Readonly<{
    pluginId: string;
    machineId: string;
    accountId?: string;
}>) {
    if (!getServerProfileById(APP_SCOPE_FIXTURE.serverIdentityId)) {
        await activateFixtureHome(APP_SCOPE_FIXTURE.serverIdentityId, 'https://app-shell-fixture.example.test');
    }
    storageState.activeServer = getActiveServerSnapshot();
    expect(storageState.activeServer.serverId).toBe(APP_SCOPE_FIXTURE.serverIdentityId);
    const { pluginId } = input;
    const actionId = 'open-client-action';
    const actionArtifactId = 'client-action-runtime';
    const generation = 5;
    const entryPath = 'react-native/client-action-runtime/entry.cjs.bundle';
    const bytes = new TextEncoder().encode('// synthetic AppShell client Action executable');
    const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
    const artifactGraph = PluginUiArtifactsManifestV2Schema.parse({
        version: 2,
        entries: [{
            artifactId: actionArtifactId,
            tier: 'reactNative',
            entry: entryPath,
            files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }],
            digest: artifactDigest,
            builtWith: { bundler: 'esbuild', version: '0.27.2' },
            executable: { exports: ['activate'] },
            hostUiApiRange: '^1.0.0',
        }],
    }).entries[0]!;
    const artifactBytesResponse = {
        ok: true,
        artifactFamily: 'reactNative',
        cacheIdentity: { artifactDigest },
        artifact: {
            artifactKind: 'reactNativeBundle', digest: artifactDigest,
            format: 'plainJs', byteSize: bytes.byteLength,
        },
        files: [{
            relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength,
            bytesBase64: Buffer.from(bytes).toString('base64'),
        }],
    } satisfies DaemonPluginUiArtifactBytesReadResponse;
    artifactByteRead.mockResolvedValue(artifactBytesResponse);
    const cacheIdentity = Object.freeze({
        pluginId,
        contributionId: actionId,
        artifactId: actionArtifactId,
        artifactDigest,
        platform: 'web' as const,
    });
    const origin = installSelectedAppScopePluginFixture({
        machineId: input.machineId,
        pluginId,
        accountId: input.accountId,
        artifacts: [{
            contributionId: actionId,
            artifactId: actionArtifactId,
            tier: 'reactNative',
            platform: 'web',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
    });
    expect(await resolveServerCredentialAccountScope(storageState.activeServer.serverId)).toEqual({
        kind: 'bound',
        scope: { serverId: storageState.activeServer.serverId, accountId: input.accountId ?? APP_SCOPE_FIXTURE.accountId },
        credentialKey: expect.any(String),
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
                        occurrenceId: origin.materializationRef.materializationId,
                        executionOrigin: PluginMachineExecutionOriginV1Schema.parse(origin),
                        contributionKind: 'reactNativeBundle',
                        contributionId: actionId,
                        generatedOwnerKind: 'clientContribution',
                        artifactGraph,
                        runtime: {
                            decision: { state: 'load' },
                            loadPolicy: { source: 'installedArtifact' },
                            cacheKey: derivePluginReactNativeBundleCacheKey(cacheIdentity),
                            cacheIdentity: { artifactDigest: cacheIdentity.artifactDigest },
                        },
                    },
                },
            },
        },
    });
    return { pluginId, actionId, actionArtifactId, bytes, entryPath, entryDigest, artifactDigest,
        artifactGraph, cacheIdentity, origin, baseClientAction, appProjection, artifactBytesResponse };
}

function pluginUiProjectionWithClientAction(input: Readonly<{
    generation: number;
    pluginId: string;
    origin: PluginMachineMaterializationExecutionOriginV1;
}>): PluginProjectionV2 {
    const localId = 'open-client-action';
    return PluginProjectionV2Schema.parse({
        ...pluginUiProjectionWithAppTab(input),
        // Client Action registration is version-bound. Account Availability
        // selects the exact origin, while the daemon projection supplies the
        // package version that the generic registration index must publish.
        installedPackagesById: {
            [input.pluginId]: {
                id: input.pluginId,
                displayName: input.pluginId,
                version: '1.0.0',
                enabled: true,
                source: { kind: 'registryPackage', locator: input.pluginId },
                executionOrigin: PluginMachineExecutionOriginV1Schema.parse(input.origin),
            },
        },
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
                        exportName: 'activate',
                    },
                    platforms: ['web'],
                },
                occurrenceId: input.origin.materializationRef.materializationId,
                executionOrigin: PluginMachineExecutionOriginV1Schema.parse(input.origin),
            },
        },
    });
}

describe('AppShellPluginUiProjectionProvider', () => {
    it('does not rerender retained origin consumers for unchanged parent inputs', async () => {
        // Publication factories call their pure algorithms within the owning
        // module, so exported-function spies would miss those actual calls.
        // Observe real source enumeration without replacing any implementation.
        const entries = vi.spyOn(Object, 'entries');
        const values = vi.spyOn(Object, 'values');
        const currentnessReads = vi.spyOn(projectionCurrentness, 'usePluginUiProjectionCurrentness');
        onTestFinished(() => { entries.mockRestore(); values.mockRestore(); currentnessReads.mockRestore(); });
        const sourceTraversals = () => {
            const sources = new Set<object>();
            for (const result of currentnessReads.mock.results) {
                if (result.type !== 'return' || !result.value.pluginUiProjection) continue;
                const model = result.value.pluginUiProjection;
                sources.add(model);
                for (const key of Reflect.ownKeys(model)) {
                    const value: unknown = Reflect.get(model, key);
                    if (value !== null && typeof value === 'object') sources.add(value);
                }
            }
            const isSource = (value: unknown) => value !== null && typeof value === 'object' && sources.has(value);
            return entries.mock.calls.filter(([value]) => isSource(value)).length
                + values.mock.calls.filter(([value]) => isSource(value)).length;
        };
        const pluginId = 'acme.retained-origin';
        const origin = installSelectedAppScopePluginFixture({ machineId: 'machine-retained', pluginId });
        projectionDescribeSpy.mockResolvedValue({ supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 3, pluginId, origin }) });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        // Observe the real hook without replacing Administration's decisions.
        const selection = vi.spyOn(executionOriginSelection, 'usePluginMachineExecutionOriginSelection');
        onTestFinished(() => selection.mockRestore());
        const screen = await renderScreen(<AppShellPluginUiProjectionProvider>{null}</AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 5 });
        const reads = () => selection.mock.calls.filter(([input]) => input.pluginId === pluginId).length;
        expect(reads()).toBeGreaterThan(0);
        const settled = reads();
        const settledTraversals = sourceTraversals();
        expect(settledTraversals).toBeGreaterThan(0);
        for (let index = 0; index < 3; index++) {
            await screen.update(<AppShellPluginUiProjectionProvider>{null}</AppShellPluginUiProjectionProvider>);
        }
        expect(reads()).toBe(settled);
        console.info('R-C AppShell unchanged parent renders', { renders: 3,
            sourceTraversals: sourceTraversals() - settledTraversals });
        expect(sourceTraversals()).toBe(settledTraversals);
        for (let index = 0; index < 3; index += 1) {
            await act(async () => {
                storageState.machines = storageState.machines.map(machine => ({ ...machine, activeAt: Date.now() + index }));
            });
            await flushHookEffects({ cycles: 3 });
        }
        console.info('R-C AppShell unchanged Machine publications', { publications: 3,
            sourceTraversals: sourceTraversals() - settledTraversals });
        expect(sourceTraversals()).toBe(settledTraversals);
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        const admission = readPluginAccountAvailability(scope).readMaterializations();
        expect(admission.kind).toBe('available');
        if (admission.kind !== 'available') throw new Error('Fixture Availability must be admitted');
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                availabilityCursor: admission.availabilityCursor + 1, intentReads: admission.intentReads,
                materializations: admission.materializations, snapshots: admission.snapshots,
            } });
        });
        await flushHookEffects({ cycles: 5 });
        const afterCursor = readPluginAccountAvailability(scope).readMaterializations();
        if (afterCursor.kind !== 'available') throw new Error('Fixture Availability must remain admitted');
        console.info('R-C AppShell cursor-only Availability publication', {
            sourceTraversals: sourceTraversals() - settledTraversals,
            materializationIdentity: afterCursor.materializations[0] === admission.materializations[0],
            manifestIdentity: afterCursor.materializations[0]?.declaredManifest === admission.materializations[0]?.declaredManifest,
            uiArtifactsIdentity: afterCursor.materializations[0]?.uiArtifacts === admission.materializations[0]?.uiArtifacts,
            declaredUiEntriesIdentity: afterCursor.materializations[0]?.declaredUiEntries === admission.materializations[0]?.declaredUiEntries,
        });
        expect(sourceTraversals()).toBe(settledTraversals);
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                availabilityCursor: admission.availabilityCursor + 2,
                intentReads: admission.intentReads,
                materializations: admission.materializations.map(materialization => ({
                    ...materialization, observedAt: materialization.observedAt + 1,
                })),
                snapshots: admission.snapshots,
            } });
        });
        await flushHookEffects({ cycles: 5 });
        console.info('R-C AppShell observation-only materialization publication', {
            sourceTraversals: sourceTraversals() - settledTraversals });
        expect(sourceTraversals()).toBe(settledTraversals);
        // A choice report changes the union's selected stamp, but not its
        // candidate supplies. It must settle without feeding a fresh facts
        // object back through the same selector on every parent publication.
        const beforeChoiceReads = reads();
        await act(async () => {
            persistentStorage.setState(state => ({ settings: { ...state.settings,
                machineAdministrationTargetsLocalV1: clearPluginMachineExecutionOriginPreference(
                    state.settings.machineAdministrationTargetsLocalV1, pluginId),
            } }));
        });
        await flushHookEffects({ cycles: 5 });
        const afterChoice = reads();
        expect(afterChoice - beforeChoiceReads).toBeLessThanOrEqual(2);
        const latest = selection.mock.calls.filter(([input]) => input.pluginId === pluginId).at(-1)![0];
        const beforeChoice = selection.mock.calls.filter(([input]) => input.pluginId === pluginId)[beforeChoiceReads - 1]![0];
        expect(latest.sourceCandidates).toBe(beforeChoice.sourceCandidates);
        expect(latest.machineRejections).toBe(beforeChoice.machineRejections);
        expect(latest.declaredDefaultOrigins).toBe(beforeChoice.declaredDefaultOrigins);
        // Memoization must not suppress the owning hook's actual inventory invalidation.
        await act(async () => { storageState.machines = []; });
        expect(reads()).toBeGreaterThan(afterChoice);
        const result = selection.mock.results.filter((_, index) => selection.mock.calls[index]?.[0].pluginId === pluginId).at(-1);
        expect(result?.value.canExecute).toBe(false);
        await screen.unmount();
    });

    it('withdraws the selected same-plugin origin on Account change and ignores late retired reports', async () => {
        installActiveAccountScope('origin-account-a');
        const accountA = captureActiveServerAccountScopeLifetime();
        if (!accountA) throw new Error('Account fixture must establish a lifetime');
        const owner = createAppShellPluginUiProjectionPublication();
        const pluginId = 'acme.same-account-origin';
        const machines = ['origin-machine-a', 'origin-machine-b'];
        const origins = machines.map(machineId => unselectedAppScopeOrigin({ machineId, pluginId }));
        const models = machines.map((machineId, index) => ({ ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                source: { kind: 'localPath' as const, locator: machineId }, occurrenceId: machineId, executionOrigin: origins[index]! } },
            translationsByPluginId: { [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations' as const,
                locales: ['en'], bundles: { en: { title: machineId } }, occurrenceId: machineId, executionOrigin: origins[index]! } },
        }));
        const sources = { availabilityInputs: null, hostBundledUiEnabled: false, activeServerId: accountA.scope.serverId,
            serverProfilesGeneration: 0, activeInventoryLoaded: true, onlineMachineIds: machines, selectableMachineIds: machines };
        const publishMachines = (lifetime: ActiveServerAccountScopeLifetime) => models.forEach((model, index) =>
            owner.publishMachineCurrentness(machines[index]!, lifetime, { pluginUiProjection: model, pluginBrowserProjection: null,
                phase: 'current', interactionEnabled: true, machineId: machines[index]!, serverId: sources.activeServerId,
                platform: 'web', accountLifetime: lifetime }));
        const declaration = () => owner.getSnapshot().pluginUiProjection?.translationsByPluginId[pluginId];
        let committedNotifications = 0;
        let detach = () => {};
        let stop = () => {};
        try {
            owner.publishSources({ ...sources, accountLifetime: accountA });
            publishMachines(accountA);
            owner.publishExecutionOrigin(pluginId, accountA, origins[0]!, origins, true);
            expect(readPluginUiContributionOrigin(declaration())?.machineId).toBe(machines[0]);
            detach = publishCommittedAppShellPluginUiProjection(() => owner.getSnapshot().pluginUiProjection,
                id => owner.getSnapshot().candidateFactsByPluginId.get(id) ?? null,
                listener => owner.subscribe(listener, 'committed'));
            stop = subscribeCommittedAppShellPluginUiProjection(() => { committedNotifications++; });
            installActiveAccountScope('origin-account-b');
            const accountB = captureActiveServerAccountScopeLifetime();
            if (!accountB) throw new Error('Replacement Account must establish a lifetime');
            expect(accountA.isCurrent()).toBe(false);
            expect(owner.getSnapshot().pluginUiProjection).toBeNull();
            expect(readCurrentAppShellPluginUiProjection()).toBeNull();
            await flushHookEffects();
            expect(committedNotifications).toBeGreaterThan(0);
            owner.publishSources({ ...sources, accountLifetime: accountB });
            publishMachines(accountB);
            owner.publishExecutionOrigin(pluginId, accountB, null, origins);
            expect(declaration()).toMatchObject({ hostCompatibility: 'conflict' });
            const beforeLateReport = owner.getSnapshot();
            owner.publishExecutionOrigin(pluginId, accountA, origins[0]!, origins, true);
            expect(owner.getSnapshot()).toBe(beforeLateReport);
            owner.publishExecutionOrigin(pluginId, accountB, origins[1]!, origins, true);
            expect(readPluginUiContributionOrigin(declaration())?.machineId).toBe(machines[1]);
            owner.publishExecutionOrigin(pluginId, accountB, null, origins);
            expect(declaration()).toMatchObject({ hostCompatibility: 'conflict' });
        } finally { stop(); detach(); owner.dispose(); }
    });

    it('withholds same-server currentness reports from the retired Account', () => {
        const accountA = accountLifetimeFixture({ accountId: 'account-a' });
        const accountB = accountLifetimeFixture({ accountId: 'account-b' });
        const currentnessA = {
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            interactionEnabled: true,
        } as never;
        const currentnessReports = new Map([[
            'machine-a',
            { accountLifetime: accountA, currentness: currentnessA },
        ]]);

        // Control: Account A can read its own Machine report.
        expect(selectCurrentAppShellPluginUiCurrentness({
            reports: currentnessReports,
            accountLifetime: accountA,
        })).toEqual(new Map([['machine-a', currentnessA]]));

        // Same server and same plugin id are deliberately insufficient. Before
        // the Account-B children publish, these old reports must be invisible
        // synchronously rather than surviving one render as a stale union.
        expect(selectCurrentAppShellPluginUiCurrentness({
            reports: currentnessReports,
            accountLifetime: accountB,
        })).toEqual(new Map());
    });

    it('contains activation rejections and cancellation from the React effect', async () => {
        await expect(settleAppShellPluginRuntimeUpdate({
            activate: async () => { throw new Error('activation failed'); },
            isCancelled: () => false,
        })).resolves.toEqual({ status: 'unavailable', failures: [] });

        const supersededActivation = vi.fn(async () => {});
        await expect(settleAppShellPluginRuntimeUpdate({
            activate: supersededActivation,
            isCancelled: () => true,
        })).resolves.toEqual({ status: 'cancelled' });
        expect(supersededActivation).not.toHaveBeenCalled();
    });

    it('preserves typed complete-set activation failures for AppShell availability', async () => {
        const settlement = await settleAppShellPluginRuntimeUpdate({
            activate: async () => [{
                activation: {
                    pluginId: 'acme.shared-runtime',
                    target: {
                        artifactId: 'shared-runtime',
                        exportName: 'activate',
                        platform: 'web',
                    },
                    executionOrigin: {
                        serverIdentityId: 'srv_shared_runtime',
                        materializationRef: {
                            pluginId: 'acme.shared-runtime',
                            machineId: 'machine-1',
                            materializationId: 'materialization-1',
                        },
                    },
                    occurrenceId: 'acme-shared-runtime-occurrence-12',
                },
                result: {
                    ok: false,
                    code: 'invalid_executable_export',
                    diagnostics: ['invalid_executable_export'],
                },
                reused: false,
            } as never],
            isCancelled: () => false,
        });
        expect(settlement).toEqual({
            status: 'unavailable',
            failures: [expect.objectContaining({
                pluginId: 'acme.shared-runtime',
                code: 'invalid_executable_export',
                target: expect.objectContaining({ artifactId: 'shared-runtime' }),
                executionOrigin: expect.objectContaining({ serverIdentityId: 'srv_shared_runtime' }),
                occurrenceId: 'acme-shared-runtime-occurrence-12',
            })],
        });
        if (settlement.status === 'cancelled') throw new Error('unexpected cancellation');
        expect(isAppShellPluginClientExecutableAvailable(settlement, 'acme.shared-runtime')).toBe(false);
        expect(isAppShellPluginClientExecutableAvailable(settlement, 'acme.healthy-runtime')).toBe(true);
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
            contributes: appTabContributes(),
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


    it('opens Browse from a recovered Session resolver through the mounted App page owner', async () => {
        storageState.machines = [{ id: 'machine-1', active: true, activeAt: Date.now(), metadata: { host: 'local' } }];
        const pluginId = 'acme.recovered-browse';
        const origin = installSelectedAppScopePluginFixture({ machineId: 'machine-1', pluginId,
            releaseMetadataPending: true,
            contributes: appTabContributes({ localId: 'triage', container: 'appPage' }) });
        const pending = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        projectionDescribeSpy.mockReturnValue(pending.promise);
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { usePluginSurfaceDestinationNavigationBinding, usePluginSurfaceDestinationNavigationBindingForScope } = await import(
            '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation'
        );
        const { router } = await import('expo-router');
        const push = vi.spyOn(router, 'push').mockImplementation(() => {});
        const session: { binding: ReturnType<typeof usePluginSurfaceDestinationNavigationBinding> } = { binding: null };
        function SessionResolver() {
            const enclosing = usePluginSurfaceDestinationNavigationBinding();
            const projection = useAppShellPluginUiProjection();
            session.binding = usePluginSurfaceDestinationNavigationBindingForScope({
                targetKind: 'session', placements: selectPluginAppPagePlacements(projection.pluginUiProjection),
                accountLifetime: captureActiveServerAccountScopeLifetime(),
                scopedLaunchFacts: { serverId: storageState.activeServer.serverId, machineId: 'machine-1', interactionEnabled: true },
                enclosingOpenSurface: enclosing?.openSurface,
            });
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider><AppShellPluginUiProjectionProvider>
            <SessionResolver />
        </AppShellPluginUiProjectionProvider></AppPaneProvider>);
        await flushHookEffects({ cycles: 2 });
        const retainedBinding = session.binding;
        expect(retainedBinding).not.toBeNull();
        await expect(retainedBinding!.openSurface({ destination: { pluginId, localId: 'triage' } })).resolves.toMatchObject({ ok: false });
        pending.resolve({ supported: true, projection: pluginUiProjectionWithAppTab({ generation: 3, pluginId, localId: 'triage', origin, container: 'appPage' }) });
        await flushHookEffects({ cycles: 5 });
        await act(async () => {
            await expect(retainedBinding!.openSurface({ destination: { pluginId, localId: 'triage' } })).resolves.toEqual({ ok: true });
        });
        expect(push).toHaveBeenCalledWith(`/plugins/${pluginId}/triage`);
        await screen.unmount();
    });

    it('opens native Browse through the mounted App page registration with automatically selected replicas', async () => {
        const pluginId = 'happier.triage';
        storageState.machines = ['machine-1', 'machine-2'].map(id => ({ id, active: true, activeAt: Date.now(), metadata: { host: id } }));
        const origin = installSelectedAppScopePluginFixture({ machineId: 'machine-1', pluginId,
            replicaMachineIds: ['machine-2'], selectOrigin: false,
            contributes: appTabContributes({ localId: 'triage', container: 'appPage' }) });
        projectionDescribeSpy.mockImplementation(async (machineId) => ({ supported: true,
            projection: pluginUiProjectionWithAppTab({ generation: 3, pluginId, localId: 'triage', container: 'appPage',
                origin: { serverIdentityId: origin.serverIdentityId,
                    materializationRef: { pluginId, machineId, materializationId: `${machineId}:${pluginId}:install` } } }),
        }));
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { usePluginSurfaceDestinationNavigationBinding, usePluginSurfaceDestinationNavigationBindingForScope } = await import(
            '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation'
        );
        const { createPluginSurfaceOpenSurfaceHandler } = await import('@/components/plugins/surfaces/openPluginSurface');
        const { router } = await import('expo-router');
        const push = vi.spyOn(router, 'push').mockImplementation(() => {});
        const session: { binding: ReturnType<typeof usePluginSurfaceDestinationNavigationBinding> } = { binding: null };
        let browsePlacements: ReturnType<typeof selectPluginAppPagePlacements> = [];
        function SessionResolver() {
            const enclosing = usePluginSurfaceDestinationNavigationBinding();
            const projection = useAppShellPluginUiProjection();
            browsePlacements = selectPluginAppPagePlacements(projection.pluginUiProjection);
            session.binding = usePluginSurfaceDestinationNavigationBindingForScope({
                targetKind: 'session', placements: browsePlacements,
                accountLifetime: captureActiveServerAccountScopeLifetime(), enclosingOpenSurface: enclosing?.openSurface,
            });
            return null;
        }
        const screen = await renderScreen(<AppPaneProvider><AppShellPluginUiProjectionProvider>
            <SessionResolver />
        </AppShellPluginUiProjectionProvider></AppPaneProvider>);
        await flushHookEffects({ cycles: 10 });
        expect(session.binding).not.toBeNull();
        expect(browsePlacements).toHaveLength(1);
        // No explicit pin is required: Administration auto-picks a qualified
        // supply on this Home (2026-10-16 owner ruling).
        expect(readPluginUiContributionOrigin(browsePlacements[0])).toMatchObject({
            machineId: 'machine-1', executionOrigin: origin, interactionEnabled: true,
        });
        const host = createPluginSurfaceOpenSurfaceHandler(session.binding!.openSurface);
        await act(async () => {
            await expect(host({ version: 1, requestId: 'native-browse', method: 'openSurface',
                surface: { pluginId, contributionId: 'session-entries', surfaceId: 'session-entries',
                    placement: 'rightSidebarSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
                payload: { destination: { pluginId, localId: 'triage' } },
            })).resolves.toBeNull();
        });
        expect(push).toHaveBeenCalledWith('/plugins/happier.triage/triage');
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
            scopeKey: 'srv_app_shell_fixture',
            status: 'loading',
            entries: expect.any(Array),
        });

        pending.resolve({ supported: false, reason: 'error' });
        await flushHookEffects({ cycles: 3 });
        await screen.unmount();
    });

    it('shares the sole machine snapshot with browser presentation when no app declarations exist', async () => {
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
                actionsById: {},


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
            serverId: 'srv_app_shell_fixture',
        }));
        // UI, browser and Connected Account descriptors consume the same
        // machine snapshot, rather than each opening a full describe request.
        expect(projectionDescribeSpy).toHaveBeenCalledTimes(1);
        // This snapshot has no app UI declarations. Browser presentation is
        // still available for the sole current machine; execution selection
        // never owns visibility of an otherwise-proven app declaration.
        expect(probe.props.value).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'srv_app_shell_fixture',
            pluginUiProjection: null,
            interactionEnabled: false,
            pluginBrowserProjection: expect.objectContaining({ generation: 5 }),
        }));
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
        };
        const { actionId, actionArtifactId, cacheIdentity, origin, baseClientAction, appProjection } = await createAppShellClientActionFixture({
            pluginId: 'acme.app-shell-action-without-voice', machineId: 'machine-a',
        });
        const pluginId = origin.materializationRef.pluginId;
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
            serverId: storageState.activeServer.serverId,
            occurrenceId: baseClientAction.occurrenceId,
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
        const executableCache = getInstalledPluginReactNativeBundleCache();
        let failActivation = true;
        const activate = vi.fn((api: PluginClientApi) => {
            if (failActivation) throw new Error('synthetic client executable activation failure');
            api.actions.register(actionId, async () => null);
        });
        const loaderBackend: PluginReactNativeLoaderBackend = Object.freeze({
            backendId: 'commonJs',
            available: true,
            loadInstalledBundle: vi.fn(async () => activate),
        });
        pluginExecutableHostState.override = executableHost;
        appShellClientExecutableRuntimeState.loaderBackend = loaderBackend;
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
                    actionsById: {},


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
            expect(artifactByteRead).toHaveBeenCalled();
        });
        await vi.waitFor(() => {
            expect(activate).toHaveBeenCalledTimes(1);
        });

        const registration = () => getPluginUiClientExecutableComposition(executableHost).read({
            family: 'actions',
            pluginId,
            occurrenceId: baseClientAction.occurrenceId,
            localId: actionId,
            target: {
                artifactId: actionArtifactId,
                exportName: 'activate',
                platform: 'web',
            },
            executionOrigin: origin,
        });
        const headerControl = () => screen.tree.findByProps({
            testID: 'plugin-app-page-header-action:run-client-action',
        });
        // A typed executable activation failure is fail-closed at the generic
        // registration index. The daemon projection remains current, but no
        // client Action can be presented or dispatched before its target
        // commits the exact registration.
        expect(registration()).toBeNull();
        expect(headerControl().props.disabled).toBe(true);
        expect(headerControl().props.onPress).toBeUndefined();
        expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
            expect.objectContaining({
                phase: 'current',
                interactionEnabled: true,
                clientExecutableActivation: expect.objectContaining({
                    status: 'unavailable',
                    failures: [expect.objectContaining({
                        pluginId,
                        code: 'activation_failed',
                    })],
                }),
                reloadClientExecutables: expect.any(Function),
            }),
        );

        // The AppShell owner exposes one explicit reload of the same complete
        // set. Recovery must not depend on a daemon projection change, a timer,
        // or a second executable index.
        failActivation = false;
        await act(async () => {
            screen.tree.findByType('ProjectionProbe' as never).props.value.reloadClientExecutables();
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
                platform: 'web',
            })).not.toBeNull();
            expect(screen.tree.findByType('ProjectionProbe' as never).props.value).toEqual(
                expect.objectContaining({
                    phase: 'current',
                    interactionEnabled: true,
                    clientExecutableActivation: { status: 'ready' },
                }),
            );
            expect(headerControl().props.disabled).toBe(false);
            expect(headerControl().props.onPress).toEqual(expect.any(Function));
        });
        const artifactReadsBeforeMalformed = artifactByteRead.mock.calls.length;
        const admittedBytes = executableCache.readInstalledArtifact(cacheIdentity);
        expect(admittedBytes).not.toBeNull();
        const currentRegistration = registration();
        storageState.machines = storageState.machines.map((machine) => ({
            ...machine, activeAt: Date.now() + 1_000,
        }));
        await screen.update(
            <AppShellPluginUiProjectionProvider>
                <ProjectionProbe />
                <ClientActionHeaderPresentationProbe
                    action={clientActionHeaderAction}
                    page={clientActionHeaderPage}
                    actionAuthority={clientActionHeaderAuthority}
                />
            </AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(registration()).toBe(currentRegistration);
        expect(activate).toHaveBeenCalledTimes(2);

        describedAppProjection = malformedActionProjection;
        await act(async () => {
            projectionRefreshState.publish();
        });
        await flushHookEffects({ cycles: 6 });

        await vi.waitFor(() => {
            expect(registration()).toBeNull();
            expect(executableCache.readInstalledArtifact(cacheIdentity)).toEqual(admittedBytes);
        });
        expect(activate).toHaveBeenCalledTimes(2);
        // A revision may refresh the valid byte source without granting the
        // malformed Action executable authority. The byte RPC is digest-only;
        // it must never use the rejected Action's ownership as a byte route.
        for (const [request] of artifactByteRead.mock.calls.slice(artifactReadsBeforeMalformed)) {
            expect(request).toEqual(expect.objectContaining({
                machineId: origin.materializationRef.machineId,
                serverId: APP_SCOPE_FIXTURE.serverId,
                operationTimeoutMs: null,
                payload: {
                    artifactFamily: 'reactNative',
                    machineId: origin.materializationRef.machineId,
                    cacheIdentity: { artifactDigest: cacheIdentity.artifactDigest },
                },
            }));
        }

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
            await publishActiveAccountCredentials();
        });
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        await vi.waitFor(() => {
            expect(registration()).toBeNull();
            expect(executableCache.readInstalledArtifact(cacheIdentity)).toBeNull();
        });
    });

    it('rejects late Artifact bytes admitted by the retired Account before evaluating its executable', async () => {
        storageState.machines = [createLiveMachine('machine-1')];
        const fixture = await createAppShellClientActionFixture({
            pluginId: 'acme.late-app-shell-artifact', machineId: 'machine-1', accountId: 'account-a',
        });
        projectionDescribeSpy.mockResolvedValue({ supported: true, projection: fixture.appProjection });
        const firstBytes = createDeferred<DaemonPluginUiArtifactBytesReadResponse>();
        artifactByteRead.mockReturnValueOnce(firstBytes.promise);
        const evaluatedAccounts: string[] = [];
        const activate = (api: PluginClientApi) => {
            evaluatedAccounts.push(captureActiveServerAccountScopeLifetime()!.scope.accountId);
            api.actions.register(fixture.actionId, async () => 'current');
        };
        const loadInstalledBundle = vi.fn(async () => activate);
        appShellClientExecutableRuntimeState.loaderBackend = {
            backendId: 'commonJs', available: true, loadInstalledBundle,
        };
        const executableHost = getInstalledPluginUiExecutableModuleHost();
        pluginExecutableHostState.override = executableHost;
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await vi.waitFor(() => expect(artifactByteRead).toHaveBeenCalledTimes(1));
        expect(loadInstalledBundle).not.toHaveBeenCalled();

        await act(async () => {
            await createAppShellClientActionFixture({
                pluginId: fixture.pluginId, machineId: 'machine-1', accountId: 'account-b',
            });
            await publishActiveAccountCredentials();
        });
        await screen.update(renderApp());
        firstBytes.resolve(fixture.artifactBytesResponse);
        await flushHookEffects({ cycles: 8 });
        await vi.waitFor(() => {
            expect(screen.tree.findByType('ProjectionProbe' as never).props.value
                .clientExecutableActivation).toEqual({ status: 'ready' });
            expect(evaluatedAccounts).toEqual(['account-b']);
        });
        expect(loadInstalledBundle).toHaveBeenCalledTimes(1);
        expect(artifactByteRead).toHaveBeenCalledTimes(2);
    });

    it.each(['Account switch', 'unmount/remount'] as const)(
        'rejects a late executable from the retired occurrence after %s while its successor remains usable',
        async (transition) => {
            storageState.machines = [createLiveMachine('machine-1')];
            const fixture = await createAppShellClientActionFixture({
                pluginId: 'acme.late-app-shell-executable', machineId: 'machine-1', accountId: 'account-a',
            });
            projectionDescribeSpy.mockResolvedValue({ supported: true, projection: fixture.appProjection });
            const discardedActivate = vi.fn((api: PluginClientApi) => {
                api.actions.register(fixture.actionId, async () => 'retired');
            });
            const successorActivate = vi.fn((api: PluginClientApi) => {
                api.actions.register(fixture.actionId, async () => 'current');
            });
            const firstLoad = createDeferred<typeof discardedActivate>();
            const loadInstalledBundle = vi.fn(async () => successorActivate)
                .mockImplementationOnce(async () => await firstLoad.promise);
            appShellClientExecutableRuntimeState.loaderBackend = {
                backendId: 'commonJs', available: true, loadInstalledBundle,
            };
            const executableHost = getInstalledPluginUiExecutableModuleHost();
            pluginExecutableHostState.override = executableHost;
            const registration = () => getPluginUiClientExecutableComposition(executableHost).read({
                family: 'actions', pluginId: fixture.pluginId,
                occurrenceId: fixture.baseClientAction.occurrenceId, localId: fixture.actionId,
                target: { artifactId: fixture.actionArtifactId, exportName: 'activate', platform: 'web' },
                executionOrigin: fixture.origin,
            });
            const accountA = captureActiveServerAccountScopeLifetime();
            const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
            const renderApp = () => (
                <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
            );
            const first = await renderScreen(renderApp());
            await vi.waitFor(() => expect(loadInstalledBundle).toHaveBeenCalledTimes(1));
            expect(registration()).toBeNull();
            expect(artifactByteRead).toHaveBeenCalled();

            let successor = first;
            if (transition === 'Account switch') {
                await act(async () => {
                    await createAppShellClientActionFixture({
                        pluginId: fixture.pluginId, machineId: 'machine-1', accountId: 'account-b',
                    });
                    await publishActiveAccountCredentials();
                });
                expect(accountA?.isCurrent()).toBe(false);
                await first.update(renderApp());
                // A same-server Account successor queues behind preparation, but
                // the stale executable must not run when that module finally loads.
                firstLoad.resolve(discardedActivate);
            } else {
                await first.unmount();
                successor = await renderScreen(renderApp());
                await vi.waitFor(() => expect(registration()).not.toBeNull());
                firstLoad.resolve(discardedActivate);
            }
            await flushHookEffects({ cycles: 8 });
            await vi.waitFor(() => {
                expect(successorActivate).toHaveBeenCalledTimes(1);
                expect(registration()).not.toBeNull();
                expect(successor.tree.findByType('ProjectionProbe' as never).props.value
                    .clientExecutableActivation).toEqual({ status: 'ready' });
            });
            expect(discardedActivate).not.toHaveBeenCalled();
            expect(registration()?.accountLifetime).toBe(captureActiveServerAccountScopeLifetime());

            await successor.unmount();
            expect(registration()).toBeNull();
            await vi.waitFor(() => {
                expect(getInstalledPluginReactNativeBundleCache().readInstalledArtifact(fixture.cacheIdentity)).toBeNull();
            });
        },
    );



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



    it('keeps last-known projection authority inert until reconnect re-description settles', async () => {
        await act(async () => persistentStorage.setState({ endpointStatus: 'online' }));
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
            contributes: appTabContributes(),
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
        const describesBeforeReconnect = projectionDescribeSpy.mock.calls.length;

        await act(async () => persistentStorage.setState({ endpointStatus: 'offline' }));
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginUiProjection: expect.objectContaining({ generation: 5 }),
            pluginBrowserProjection: null,
        }));

        const reDescription = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        projectionDescribeSpy.mockReturnValueOnce(reDescription.promise);
        // A socket reconnect advances every machine's projection revision
        // (`publishMachineContributionRegistryProjectionReconnect`), which is
        // what makes the one per-machine owner re-describe.
        await act(async () => {
            persistentStorage.setState({ endpointStatus: 'online' });
            projectionRefreshState.publish();
        });
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(projectionDescribeSpy.mock.calls.length).toBeGreaterThan(describesBeforeReconnect);

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
            pluginUiProjection: expect.objectContaining({ surfacePlacementsById: expect.objectContaining({
                [`surfacePlacement:${pluginId}:panel`]: expect.objectContaining({ display: expect.objectContaining({ title: 'Panel' }) }),
            }) }),
            pluginBrowserProjection: expect.objectContaining({ generation: 6 }),
        }));
    });

    it.each(['originless', 'development'] as const)('acquires the selected %s Voice provider from a cold shell, then unwinds it offline until fresh re-description', async (custody) => {
        const consoleErrors = vi.spyOn(console, 'error');
        onTestFinished(() => consoleErrors.mockRestore());
        // Two live machines deliberately disagree with the fixed Voice choice.
        // Only the evaluation boundary is synthetic; registration and retirement are real.
        await createAppShellClientActionFixture({ pluginId: 'acme.app-shell-currentness', machineId: 'machine-voice' });
        const voiceHostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(() => voiceHostLease.revoke());
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
                    exportName: 'activate',
                },
            }],
        }).voiceProviders[0]!);
        const pluginId = 'acme.app-shell-currentness';
        const providerId = `${pluginId}/${declaration.id}`;
        const generation = 12;
        const entryPath = 'react-native/voice-runtime-web/entry.cjs.bundle';
        const bytes = new TextEncoder().encode('// synthetic app-shell Voice executable');
        const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
        const artifactGraph = PluginUiArtifactsManifestV2Schema.parse({
            version: 2,
            entries: [{
                artifactId: declaration.client.artifactId,
                tier: 'reactNative',
                entry: entryPath,
                files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength }],
                digest,
                builtWith: { bundler: 'esbuild', version: '0.27.2' },
                executable: { exports: ['activate'] },
                hostUiApiRange: '^1.0.0',
            }],
        }).entries[0]!;
        const identity = Object.freeze({
            pluginId,
            contributionId: declaration.id,
            artifactId: declaration.client.artifactId,
            artifactDigest: digest,
            platform: 'web' as const,
        });
        const origin = installSelectedAppScopePluginFixture({
            machineId: 'machine-voice',
            pluginId,
            artifacts: [{
                contributionId: declaration.id,
                artifactId: declaration.client.artifactId,
                tier: 'reactNative',
                platform: 'web',
                artifactDigest: digest,
                hostUiApiRange: '^1.0.0',
            }],
        });
        const executionOrigin = custody === 'development' ? PluginMachineExecutionOriginV1Schema.parse({
            serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
            sourceRef: { machineId: 'machine-voice', pluginId,
                sourceCustody: { kind: 'development', registeredRootId: pluginId } },
        }) : null;
        const rawProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation,
            installedPackagesById: executionOrigin ? { [pluginId]: {
                id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                source: { kind: 'localPath', locator: pluginId }, executionOrigin,
                occurrenceId: origin.materializationRef.materializationId,
            } } : {},
            agentsById: {},
            actionsById: {},


            resourcesById: {},
            settingsById: {},
            familiesById: {
                voiceProviders: {
                    family: 'voiceProviders',
                    entriesById: {
                        [providerId]: {
                            id: providerId,
                            pluginId,
                            occurrenceId: origin.materializationRef.materializationId,
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
                            occurrenceId: origin.materializationRef.materializationId,
                            contributionKind: 'reactNativeBundle',
                            contributionId: declaration.id,
                            generatedOwnerKind: 'voiceProvider',
                            ...(executionOrigin ? { executionOrigin } : {}),
                            artifactGraph,
                            runtime: {
                                decision: { state: 'load' },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheKey: derivePluginReactNativeBundleCacheKey(identity),
                                cacheIdentity: { artifactDigest: identity.artifactDigest },
                            },
                        },
                    },
                },
            },
            diagnostics: [],
        });
        await act(async () => persistentStorage.setState({ endpointStatus: 'online' }));
        localServicePreviewPlatformState.platform = 'desktop';
        storageState.machines = [createLiveMachine('machine-newer'), createLiveMachine('machine-voice')];
        storageState.voiceExecutionMachine = { mode: 'fixed', machineId: 'machine-voice' };
        persistentStorage.setState(state => ({ settings: { ...state.settings,
            voiceSettingsV1: { ...state.settings.voiceSettingsV1, providerId: `${pluginId}/${declaration.id}` },
        } }));
        artifactByteRead.mockResolvedValue({
            ok: true,
            artifactFamily: 'reactNative',
            cacheIdentity: { artifactDigest: digest },
            artifact: { artifactKind: 'reactNativeBundle', digest, format: 'plainJs', byteSize: bytes.byteLength },
            files: [{ relativePath: entryPath, digest: entryDigest, byteSize: bytes.byteLength,
                bytesBase64: Buffer.from(bytes).toString('base64') }],
        });
        const activate = vi.fn((api: PluginClientApi) => {
            api.voiceProviders.register(declaration.id, {
                kind: 'conversation',
                protocol: {
                    async prepare() { return { kind: 'prepared' as const, session: { config: {}, safeMetadata: null } }; },
                    decodeControl: () => [], encodeTurnControl: () => null,
                },
                async createConnection() {
                    return {
                        kind: 'sdk_handle' as const,
                        async connect() {}, async sendControl() {},
                        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        async close() {}, state: () => 'closed' as const,
                        currentProviderSessionId: () => null, playbackCursorMs: () => null,
                        beginOutputInterruptionCandidate: () => 'unsupported' as const,
                        resolveOutputInterruptionCandidate() {},
                    };
                },
                encodeToolResults: () => [], encodeToolContinuation: () => null,
                encodeContextUpdate: () => [], encodeTextTurn: () => [],
                microphoneMode: 'provider_managed' as const, setInputMuted: () => {},
            });
        });
        const releaseActivation = createDeferred<void>();
        const activationEntered = createDeferred<void>();
        appShellClientExecutableRuntimeState.loaderBackend = {
            backendId: 'commonJs', available: true, loadInstalledBundle: vi.fn(async () => {
                activationEntered.resolve(undefined);
                await releaseActivation.promise;
                return activate;
            }),
        };
        const host = getInstalledPluginUiExecutableModuleHost();
        pluginExecutableHostState.override = host;
        // The live daemon leaves Voice declarations unstamped while stamping
        // the installed development package and its executable bundle.
        const registration = () => getPluginUiClientExecutableComposition(host).read({
            family: 'voiceProviders', pluginId, localId: declaration.id,
            occurrenceId: origin.materializationRef.materializationId,
            executionOrigin,
            target: { artifactId: declaration.client.artifactId, exportName: 'activate', platform: 'web' },
        });
        let reconnectDescription: ReturnType<typeof createDeferred<{
            supported: true;
            projection: typeof rawProjection;
        }>> | null = null;
        const initialDescription = createDeferred<{ supported: true; projection: typeof rawProjection }>();
        onTestFinished(() => {
            initialDescription.resolve({ supported: true, projection: rawProjection });
            releaseActivation.resolve();
        });
        projectionDescribeSpy.mockImplementation((machineId) => (
            machineId === 'machine-newer'
                ? Promise.resolve({ supported: true as const, projection: projection({}) })
                : reconnectDescription
                ? reconnectDescription.promise
                : initialDescription.promise
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 8 });
        const acquisition = getCurrentAppShellVoiceProviderActivation(providerId);
        expect(acquisition).not.toBeNull();
        let acquisitionSettled = false;
        void acquisition?.then(() => { acquisitionSettled = true; });
        await flushHookEffects({ cycles: 3 });
        // Public Start borrows this completion before reading adapter capabilities.
        // A catalog still being described has not finished provider activation.
        expect(acquisitionSettled).toBe(false);
        expect(screen.findByType('ProjectionProbe' as never).props.value.clientExecutableActivation.status).toBe('establishing');
        await act(async () => initialDescription.resolve({ supported: true, projection: rawProjection }));
        await activationEntered.promise;
        const completion = getCurrentAppShellVoiceProviderActivation(providerId);
        expect(completion).not.toBeNull();
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
        await act(async () => {
            releaseActivation.resolve(undefined);
            await completion;
            await acquisition;
        });
        await vi.waitFor(() => {
            expect(screen.findByType('ProjectionProbe' as never).props.value.clientExecutableActivation)
                .toEqual({ status: 'ready' });
            expect(registration()).not.toBeNull();
        });
        expect(activate).toHaveBeenCalledTimes(1);
        expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
        expect(projectionDescribeSpy.mock.calls.every(([machineId]) => machineId === 'machine-voice')).toBe(true);
        expect(screen.findByType('ProjectionProbe' as never).props.value.machineId).toBeNull();
        expect(registration()?.executionOrigin).toEqual(executionOrigin);
        expect(registration()?.authority).toEqual({
            serverId: APP_SCOPE_FIXTURE.serverId, machineId: 'machine-voice',
        });
        const incumbentRegistration = registration();
        let replacementVoiceHostLease!: ReturnType<typeof createBundledConversationRuntimeHostLease>;
        await act(async () => { replacementVoiceHostLease = createBundledConversationRuntimeHostLease(); });
        onTestFinished(() => replacementVoiceHostLease.revoke());
        await flushHookEffects({ cycles: 6 });
        await vi.waitFor(() => {
            expect(registration()).not.toBeNull();
            expect(registration()).not.toBe(incumbentRegistration);
            expect(incumbentRegistration?.lifecycle.signal.aborted).toBe(true);
            expect(activate).toHaveBeenCalledTimes(2);
            expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();
        });
        await act(async () => persistentStorage.setState({ endpointStatus: 'offline' }));
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        await vi.waitFor(() => expect(registration()).toBeNull());
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

        reconnectDescription = createDeferred();
        // A replaced daemon reconnects under fresh projection authority.
        await act(async () => {
            persistentStorage.setState({ endpointStatus: 'online' });
            publishMachineContributionRegistryProjectionInvalidation({
                machineId: 'machine-voice', serverId: APP_SCOPE_FIXTURE.serverId,
            });
        });
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 3 });
        expect(registration()).toBeNull();
        expect(activate).toHaveBeenCalledTimes(2);
        const reconnectActivation = getCurrentAppShellVoiceProviderActivation(providerId);
        expect(reconnectActivation).not.toBeNull();
        let reconnectSettled = false;
        void reconnectActivation?.then(() => { reconnectSettled = true; });
        await flushHookEffects({ cycles: 3 });
        expect(reconnectSettled).toBe(false);

        reconnectDescription.resolve({ supported: true, projection: rawProjection });
        await flushHookEffects({ cycles: 8 });
        await reconnectActivation;
        await vi.waitFor(() => expect(registration()).not.toBeNull());
        expect(activate).toHaveBeenCalledTimes(3);
        expect(getVoiceAdapterRegistry().get(providerId)).not.toBeNull();

        // Losing the fixed Voice machine cannot select the other online machine.
        await act(async () => { storageState.machines = [createLiveMachine('machine-newer')]; });
        await flushHookEffects({ cycles: 6 });
        await vi.waitFor(() => expect(registration()).toBeNull());
        expect(activate).toHaveBeenCalledTimes(3);
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();

        // Auto-target memory is device-local state. Changing it must withdraw
        // the former machine's Voice executable without an Account settings echo.
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected an active Account lifetime');
        const previousAutoTargets = useVoiceTargetStore.getState().autoTargetMachineByScope;
        onTestFinished(() => useVoiceTargetStore.setState({ autoTargetMachineByScope: previousAutoTargets }));
        await act(async () => {
            useVoiceTargetStore.getState().rememberAutoTargetMachine(lifetime.scope, 'machine-voice');
            storageState.machines = [createLiveMachine('machine-newer'), createLiveMachine('machine-voice')];
            persistentStorage.setState(state => ({
                settingsScope: lifetime.scope,
                settings: { ...state.settings, voice: {
                    ...state.settings.voice,
                    executionMachine: { mode: 'auto', machineId: null },
                } },
            }));
        });
        await flushHookEffects({ cycles: 8 });
        await vi.waitFor(() => expect(registration()).not.toBeNull());
        const settingsBeforeAutoTargetChange = persistentStorage.getState().settings;
        await act(async () => {
            useVoiceTargetStore.getState().rememberAutoTargetMachine(lifetime.scope, 'machine-newer');
        });
        await flushHookEffects({ cycles: 6 });
        await vi.waitFor(() => expect(registration()).toBeNull());
        expect(getVoiceAdapterRegistry().get(providerId)).toBeNull();
        expect(persistentStorage.getState().settings).toBe(settingsBeforeAutoTargetChange);
        expect(consoleErrors.mock.calls.filter(([message]) => (
            typeof message === 'string' && /getSnapshot|Maximum update depth exceeded/.test(message)
        ))).toEqual([]);
        await screen.unmount();
    });

    it('ignores a pre-disconnect describe result that settles after reconnect starts', async () => {
        await act(async () => persistentStorage.setState({ endpointStatus: 'online' }));
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
            contributes: appTabContributes(),
        });
        const beforeDisconnect = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        const afterReconnect = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        // Every reader of this machine shares the one per-machine owner, so
        // each projection revision issues exactly one describe.
        let currentnessRequestCount = 0;
        projectionDescribeSpy.mockImplementation(() => {
            currentnessRequestCount += 1;
            if (currentnessRequestCount === 1) return beforeDisconnect.promise;
            if (currentnessRequestCount === 2) return afterReconnect.promise;
            return Promise.resolve({
                supported: true,
                projection: pluginUiProjectionWithAppTab({ generation: 5, pluginId, origin }),
            });
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

        await act(async () => persistentStorage.setState({ endpointStatus: 'offline' }));
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 2 });
        expect(readProjection()).toEqual(expect.objectContaining({
            interactionEnabled: false,
            pluginBrowserProjection: null,
        }));

        // Match apiSocket's synchronous status/reconnect notification batch.
        await act(async () => {
            persistentStorage.setState({ endpointStatus: 'online' });
            projectionRefreshState.publish();
        });
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
            pluginUiProjection: expect.objectContaining({ surfacePlacementsById: expect.objectContaining({
                [`surfacePlacement:${pluginId}:panel`]: expect.objectContaining({ display: expect.objectContaining({ title: 'Panel' }) }),
            }) }),
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
            contributes: appTabContributes(),
        });
        let generation = 5;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({ generation, pluginId, origin }),
        }));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        const describesBeforeInvalidation = projectionDescribeSpy.mock.calls.length;

        generation = 6;
        await act(async () => projectionRefreshState.publish());
        await flushHookEffects({ cycles: 5 });

        expect(projectionDescribeSpy.mock.calls.length).toBeGreaterThan(describesBeforeInvalidation);
        expect(screen.findByType('ProjectionProbe' as never).props.value.pluginUiProjection.surfacePlacementsById[
            `surfacePlacement:${pluginId}:panel`
        ]?.display.title).toBe('Panel');
        expect(screen.findByType('ProjectionProbe' as never).props.value.pluginBrowserProjection.generation).toBe(6);
    });

    it('excludes unreachable retained and replaced machines from Connected Account conflicts', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
            { id: 'machine-c', active: true, activeAt: Date.now(), replacedByMachineId: 'machine-a', metadata: { host: 'c' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket', pluginId: 'acme.same', title: machineId === 'machine-a' ? 'Current account' : 'Old account',
            }),
        }));
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 5 });
        await act(async () => recordMachineRequestFailed({ serverId: storageState.activeServer.serverId,
            accountId: APP_SCOPE_FIXTURE.accountId, machineId: 'machine-b' }));
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry('acme.same')).toMatchObject({
            projectionStatus: 'ready', executable: true,
            projectedDescriptor: expect.objectContaining({ title: 'Current account' }),
            projectedDescriptorCandidates: [expect.objectContaining({ title: 'Current account' })],
        });
    });

    it('publishes partial Connected Account knowledge while another machine has not answered', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now(), metadata: { host: 'b' } },
        ];
        const pending = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        projectionDescribeSpy.mockImplementation(async (machineId: string) => machineId === 'machine-b' ? pending.promise : {
            supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.same' }),
        });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'stale', errorReason: 'partial_machine_failure' });
        expect(getProjectedEntry('acme.same')).toMatchObject({ executable: true, projectionStatus: 'ready',
            projectedDescriptor: expect.objectContaining({ pluginId: 'acme.same' }) });
        await act(async () => pending.resolve({ supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.same' }) }));
        await flushHookEffects({ cycles: 5 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
    });

    it('compares Connected Account details only from Administration-selectable plugin origins', async () => {
        storageState.machines = [createLiveMachine('machine-a'), createLiveMachine('machine-b')];
        installSelectedAppScopePluginFixture({ machineId: 'machine-a', pluginId: 'acme.same' });
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: projectionWithConnectedAccount({
                serviceId: 'bitbucket', pluginId: 'acme.same', title: machineId === 'machine-a' ? 'Admitted account' : 'Unadmitted account',
            }),
        }));
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 8 });
        expect(getProjectedEntry('acme.same')).toMatchObject({
            projectionStatus: 'ready', executable: true,
            projectedDescriptorCandidates: [expect.objectContaining({ title: 'Admitted account' })],
        });
    });

    it('retains static Connected Account identity while execution origin admission is withdrawn', async () => {
        const pluginId = 'happier.channel.email';
        storageState.machines = [createLiveMachine('machine-a')];
        installSelectedAppScopePluginFixture({ machineId: 'machine-a', pluginId, materializationEnabled: false });
        projectionDescribeSpy.mockResolvedValue({ supported: true, projection: projectionWithConnectedAccount({
            serviceId: 'email-imap-smtp', pluginId, title: 'Email IMAP + SMTP',
        }) });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 8 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry(pluginId)).toMatchObject({
            projectedTitle: 'Email IMAP + SMTP', projectionStatus: 'ready', executable: false, supportsToken: false,
            projectedDescriptor: expect.objectContaining({ title: 'Email IMAP + SMTP' }),
        });
    });

    it('admits a bundled Connected Account occurrence with no UI contributions or Account installation', async () => {
        const pluginId = 'acme.accounts-only';
        const occurrenceId = `${pluginId}:account:occurrence`;
        const sourceCustody = { kind: 'bundled_first_party' as const,
            packagedRuntime: { kind: 'cli_version_root' as const, versionRootId: 'accounts-fixture' } };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({
            serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
            sourceRef: { machineId: 'machine-a', pluginId, sourceCustody },
        });
        storageState.machines = [createLiveMachine('machine-a')];
        projectionDescribeSpy.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({
            ...projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId }),
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Accounts only', version: '1.0.0',
                enabled: true, source: { kind: 'bundled', locator: '@acme/accounts-only' }, sourceCustody, executionOrigin, occurrenceId } },
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                account: { ...projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId }).familiesById.connectedAccounts!.entriesById.account, occurrenceId },
            } } },
        }) });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 8 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry(pluginId)).toMatchObject({ projectionStatus: 'ready', executable: true });
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
        await act(async () => { projectionRefreshState.publish(); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({
            projectionStatus: 'ready',
            executable: true,
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

    it('keeps an Availability materialization on the union axis after its machine leaves live inventory', async () => {
        const pluginId = 'acme.orphaned-materialization';
        installSelectedAppScopePluginFixture({
            machineId: 'machine-orphan',
            pluginId,
        });
        storageState.machines = [];

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(screen.findByType('ProjectionProbe' as never).props.value).toMatchObject({
            machineId: 'machine-orphan',
            interactionEnabled: false,
        });
    });

    it('does not render unchanged machine owners when the app shell rerenders, but still refreshes invalidated projections', async () => {
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        let includeDescriptor = true;
        projectionDescribeSpy.mockImplementation(async () => ({
            supported: true,
            projection: {
                ...projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.plugin.a' }),
                ...(includeDescriptor ? {} : { familiesById: {} }),
            },
        }));
        // Observe the real hook executing in the real renderless machine component.
        // Replacing it would hide the subscription that must still refresh after memoization.
        const renders = vi.spyOn(projectionCurrentness, 'usePluginUiProjectionCurrentness');
        onTestFinished(() => renders.mockRestore());
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const element = () => <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>;
        const screen = await renderScreen(element());
        await flushHookEffects({ cycles: 5 });
        const initialProjection = screen.findByType('ProjectionProbe' as never).props.value.pluginUiProjection;
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });
        expect(renders.mock.calls.some(([input]) => input.machineId === 'machine-a' && input.enabled !== false)).toBe(true);
        renders.mockClear();

        for (let update = 0; update < 10; update += 1) await screen.update(element());
        expect(renders.mock.calls.filter(([input]) => input.machineId === 'machine-a' && input.enabled !== false)).toHaveLength(0);
        expect(screen.findByType('ProjectionProbe' as never).props.value.pluginUiProjection).toBe(initialProjection);

        includeDescriptor = false;
        await act(async () => projectionRefreshState.publish());
        await flushHookEffects({ cycles: 6 });
        expect(renders.mock.calls.some(([input]) => input.machineId === 'machine-a' && input.enabled !== false)).toBe(true);
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
    });

    it('does not republish AppShell or re-describe a current snapshot on unchanged presence', async () => {
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
        const projectionRenders = vi.fn();
        function MeasuredProjectionProbe() {
            const value = useAppShellPluginUiProjection();
            projectionRenders();
            return React.createElement('ProjectionProbe', { value });
        }
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><MeasuredProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(screen.findByType('ProjectionProbe' as never).props.value.clientExecutableActivation).toMatchObject({ status: 'ready' });
        const describesAfterMount = projectionDescribeSpy.mock.calls.length;
        const currentSnapshot = screen.findByType('ProjectionProbe' as never).props.value;
        // React may invoke a component before bailing out an equal state update.
        // Observe the real context consumer and snapshot publication instead.
        projectionRenders.mockClear();

        // Daemon keep-alive republishes the same machine with a fresh `activeAt`.
        // Nothing the union depends on changed, so no machine may be re-described.
        for (let heartbeat = 0; heartbeat < 2; heartbeat += 1) {
            await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
            await act(async () => {
                storageState.machines = [
                    { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
                ];
            });
            await flushHookEffects({ cycles: 4 });
        }
        expect(projectionDescribeSpy.mock.calls.length).toBe(describesAfterMount);
        expect(projectionRenders).not.toHaveBeenCalled();
        expect(screen.findByType('ProjectionProbe' as never).props.value).toBe(currentSnapshot);

        // Other surfaces' clock wakes do not invalidate AppShell membership.
        await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
        await flushHookEffects({ cycles: 4 });
        expect(projectionDescribeSpy.mock.calls.length).toBe(describesAfterMount);
        expect(projectionRenders).not.toHaveBeenCalled();
        expect(screen.findByType('ProjectionProbe' as never).props.value).toBe(currentSnapshot);

        await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
        expect(projectionRenders).toHaveBeenCalled();

        await act(async () => {
            const machine = persistentStorage.getState().machines['machine-a']!;
            persistentStorage.getState().applyMachines([{ ...machine, activeAt: Date.now() }], false, {
                sourceServerId: storageState.activeServer.serverId,
            });
        });
        await flushHookEffects({ cycles: 6 });
        expect(getProjectedEntry('acme.plugin.a')).toMatchObject({ supportsToken: true });
    });

    it('refreshes Connected Account descriptors through registry invalidation without waiting for the membership timer', async () => {
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
        await act(async () => { projectionRefreshState.publish(); });
        await flushHookEffects({ cycles: 4 });
        expect(getProjectedEntry('acme.plugin.a')).toBeNull();
    });

    it('retains admitted last-known-good through all-machine transport failure and refreshes on recovery', async () => {
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
        await act(async () => { projectionRefreshState.publish(); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry('acme.plugin.a')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.plugin.a' }));

        mode = 'ready';
        // The machine currentness owner retries a failed describe without a
        // separate Connected Account polling request.
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
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
        await act(async () => { projectionRefreshState.publish(); });
        await flushHookEffects({ cycles: 4 });
        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'ready', errorReason: null });
        expect(getProjectedEntry('acme.plugin.a')?.projectedDescriptor).toBeTruthy();

        mode = 'unsupported';
        await act(async () => { projectionRefreshState.publish(); });
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
            options?.serverId === 'srv_app_shell_fixture'
                ? { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.one' }) }
                : { supported: false, reason: 'error' }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });
        expect(getProjectedEntry('acme.server.one')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.one' }));

        await act(async () => {
            await activateFixtureHome('srv_app_shell_fixture_two', 'https://server-two.example.test');
            installActiveAccountScope(APP_SCOPE_FIXTURE.accountId);
            await publishActiveAccountCredentials();
        });
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 5 });

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'srv_app_shell_fixture_two', status: 'error' });
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
            options?.serverId === 'srv_app_shell_fixture'
                ? serverOne.promise
                : { supported: true, projection: projectionWithConnectedAccount({ serviceId: 'bitbucket', pluginId: 'acme.server.two' }) }
        ));

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        await act(async () => {
            await activateFixtureHome('srv_app_shell_fixture_two', 'https://server-two.example.test');
            installActiveAccountScope(APP_SCOPE_FIXTURE.accountId);
            await publishActiveAccountCredentials();
        });
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

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ scopeKey: 'srv_app_shell_fixture_two', status: 'ready' });
        expect(getProjectedEntry('acme.server.two')?.projectedDescriptor).toEqual(expect.objectContaining({ pluginId: 'acme.server.two' }));
    });

    it('synchronously removes same-server descriptors when the active Account changes', async () => {
        installActiveAccountScope('account-a');
        await publishActiveAccountCredentials();
        const lifetimeA = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.isCurrent()).toBe(true);
        let accountARetired = false;
        lifetimeA?.onRetire(() => { accountARetired = true; });
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const accountB = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        let descriptorDescribes = 0;
        projectionDescribeSpy.mockImplementation(() => {
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
        const readValue = () => screen.tree.findByType('ProjectionProbe' as never).props.value;
        const valueA = readValue();
        expect(valueA.accountLifetime).toBe(lifetimeA);
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        expect(captureActiveServerAccountScopeLifetime()).toBe(lifetimeA);
        expect(readValue()).toBe(valueA);
        expect(accountARetired).toBe(false);

        installActiveAccountScope('account-b');
        await act(publishActiveAccountCredentials);
        const lifetimeB = captureActiveServerAccountScopeLifetime();
        expect(lifetimeA?.isCurrent()).toBe(false);
        expect(accountARetired).toBe(true);
        expect(lifetimeB?.isCurrent()).toBe(true);
        expect(lifetimeB).not.toBe(lifetimeA);
        await screen.update(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );

        expect(getConnectedServiceRegistrySnapshot()).toMatchObject({
            scopeKey: 'srv_app_shell_fixture',
            status: 'loading',
            entries: [],
        });
        expect(getProjectedEntry('acme.account.a')).toBeNull();
        expect(readValue().accountLifetime).toBe(lifetimeB);
    });

    it('does not commit a late same-server descriptor from the retired Account', async () => {
        installActiveAccountScope('account-a');
        await publishActiveAccountCredentials();
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
        ];
        const accountA = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        const accountB = createDeferred<SupportedMachineContributionRegistryProjectionDescribeResult>();
        let descriptorDescribes = 0;
        projectionDescribeSpy.mockImplementation(() => {
            descriptorDescribes += 1;
            return descriptorDescribes === 1 ? accountA.promise : accountB.promise;
        });

        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 2 });

        installActiveAccountScope('account-b');
        await act(publishActiveAccountCredentials);
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
            scopeKey: 'srv_app_shell_fixture',
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

    it('retains proven app declarations before Availability execution admission loads', async () => {
        storageState.machines = [
            { id: 'machine-newer', active: true, activeAt: Date.now(), metadata: { host: 'newer-heartbeat' } },
            { id: 'machine-older', active: true, activeAt: Date.now() - 30_000, metadata: { host: 'older-heartbeat' } },
        ];
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: machineId === 'machine-older'
                // A real producer descriptor remains visible; execution
                // admission still belongs to Availability/Administration.
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
                    actionsById: {},


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
            </AppShellPluginUiProjectionProvider>,
        );
        await flushHookEffects({ cycles: 6 });

        // Both machines are described on their routed server, once each: every
        // reader of a machine shares the one per-machine projection owner.
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-older', { serverId: 'srv_app_shell_fixture' });
        expect(projectionDescribeSpy).toHaveBeenCalledWith('machine-newer', { serverId: 'srv_app_shell_fixture' });
        expect(projectionDescribeSpy.mock.calls.filter(([machineId]) => machineId === 'machine-older')).toHaveLength(1);

        const value = screen.tree.findByType('ProjectionProbe' as never).props.value;
        const placements = value.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(value.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements.map(placement => placement.pluginId)).toEqual(['acme.inspector']);
        // No single machine owns the app scope, and none is inferred from `activeAt`.
        expect(value.machineId).toBeNull();
    });

    it('binds the union of strict machine projections to app pages and Settings before selection across heartbeats', async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { PluginAppPageScreen } = await import('./PluginAppPageScreen');
        const { PluginSettingsPageScreen } = await import('@/components/settings/plugins/PluginSettingsPageScreen');
        const { PluginSettingsPageHost } = await import('@/components/plugins/surfaces');
        const renderApp = () => (
            <AppPaneProvider>
                <AppShellPluginUiProjectionProvider>
                    <ProjectionProbe />
                    <PluginAppPageScreen pluginId="acme.alpha" localId="panel" subPath="" />
                    <PluginAppPageScreen pluginId="acme.beta" localId="panel" subPath="" />
                    <PluginSettingsPageScreen pluginId="acme.alpha" pageId="preferences" />
                    <PluginSettingsPageScreen pluginId="acme.beta" pageId="preferences" />
                </AppShellPluginUiProjectionProvider>
            </AppPaneProvider>
        );
        storageState.machines = [
            { id: 'machine-a', active: true, activeAt: Date.now(), metadata: { host: 'a' } },
            { id: 'machine-b', active: true, activeAt: Date.now() - 20_000, metadata: { host: 'b' } },
        ];
        const machinePage = (input: Readonly<{
            generation: number; machineId: string; pluginId: string; title: string;
        }>) => {
            const settingsBinding = normalizePluginUiSettingsPageBindingV1({
                pluginId: input.pluginId, pageId: 'preferences', rendererId: 'settings-renderer',
            });
            if (!settingsBinding) throw new Error('The Registry must admit the settings fixture binding');
            const appPage = pluginUiProjectionWithAppTab({
                generation: input.generation, pluginId: input.pluginId, container: 'appPage',
                title: `${input.title} panel`,
                origin: unselectedAppScopeOrigin({ machineId: input.machineId, pluginId: input.pluginId }),
            });
            const projection = PluginProjectionV2Schema.parse({
                ...appPage,
                familiesById: { ...appPage.familiesById, pluginUi: {
                    family: 'pluginUi', entriesById: {
                        ...appPage.familiesById.pluginUi?.entriesById,
                        [`settingsPage:${input.pluginId}:preferences`]: {
                            id: `settingsPage:${input.pluginId}:preferences`, pluginId: input.pluginId,
                            occurrenceId: `${input.pluginId}:preferences:occurrence`,
                            contributionKind: 'settingsPage', descriptorId: 'preferences',
                            page: {
                                id: { pluginId: input.pluginId, localId: 'preferences' },
                                group: { kind: 'plugin', id: { pluginId: input.pluginId, localId: 'general' } },
                                title: `${input.title} preferences`,
                            },
                            binding: settingsBinding,
                            renderer: { kind: 'declarative', contributionId: 'settings-renderer' },
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                    },
                } },
            });
            return { projection, settingsBinding };
        };
        const alpha = machinePage({ generation: 3, machineId: 'machine-a', pluginId: 'acme.alpha', title: 'Alpha' });
        const beta = machinePage({ generation: 4, machineId: 'machine-b', pluginId: 'acme.beta', title: 'Beta' });
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: machineId === 'machine-a' ? alpha.projection : beta.projection,
        }));
        const screen = await renderScreen(renderApp());
        await flushHookEffects({ cycles: 6 });

        const assertScreenRoutes = () => {
            const appPageScreens = screen.tree.findAllByType(PluginAppPageScreen);
            expect(appPageScreens.map(page => page.findByType('StackScreen' as never).props.options.headerTitle))
                .toEqual(['Alpha panel', 'Beta panel']);
            for (const page of appPageScreens) {
                expect(page.findAllByProps({ testID: 'plugin-app-page-host' })).not.toHaveLength(0);
                expect(page.findAllByProps({ testID: 'plugin-app-page-unavailable' })).toHaveLength(0);
            }
            const settingsPageScreens = screen.tree.findAllByType(PluginSettingsPageScreen);
            expect(settingsPageScreens.map(page => page.findByType('StackScreen' as never).props.options.headerTitle))
                .toEqual(['Alpha preferences', 'Beta preferences']);
            expect(settingsPageScreens.map(page => page.findByType(PluginSettingsPageHost).props.page))
                .toEqual([
                    expect.objectContaining({ pluginId: 'acme.alpha', descriptorId: 'preferences', binding: alpha.settingsBinding }),
                    expect.objectContaining({ pluginId: 'acme.beta', descriptorId: 'preferences', binding: beta.settingsBinding }),
                ]);
            for (const page of settingsPageScreens) {
                expect(page.findAllByProps({ testID: 'plugin-settings-page-unavailable' })).toHaveLength(0);
            }
        };
        assertScreenRoutes();

        const readCatalogs = () => {
            const projection = screen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection;
            return {
                appPages: resolvePluginAppPages({ placements: selectPluginAppPagePlacements(projection) }),
                settingsPage: resolveAdmittedPluginSettingsPage({
                    projection, pluginId: 'acme.beta', pageId: 'preferences', locale: 'en',
                }),
            };
        };
        expect(readCatalogs().appPages.map(page => page.routePath)).toEqual([
            '/plugins/acme.alpha/panel', '/plugins/acme.beta/panel',
        ]);
        expect(readCatalogs().settingsPage?.title).toBe('Beta preferences');
        expect(readCatalogs().settingsPage?.page.binding).toEqual(beta.settingsBinding);
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
        expect(readCatalogs().settingsPage?.title).toBe('Beta preferences');
        assertScreenRoutes();
    });

    it('keeps divergent originless UI visible without inventing an execution conflict when the Administration machine changes', async () => {
        const machines = [createLiveMachine('machine-a'), createLiveMachine('machine-b')];
        storageState.machines = machines;
        const previous = persistentStorage.getState();
        persistentStorage.setState({
            isDataReady: true,
            profile: { ...previous.profile, id: APP_SCOPE_FIXTURE.accountId },
            profileScope: {
                serverId: storageState.activeServer.serverId,
                accountId: APP_SCOPE_FIXTURE.accountId,
            },
            machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
            machineListByServerId: {
                ...(previous.machineListByServerId ?? {}),
                [APP_SCOPE_FIXTURE.serverId]: machines,
            },
            machineListStatusByServerId: {
                ...(previous.machineListStatusByServerId ?? {}),
                [APP_SCOPE_FIXTURE.serverId]: 'idle',
            },
            settings: {
                ...previous.settings,
                machineAdministrationTargetsLocalV1: {
                    'plugins.home': {
                        serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
                        machineId: 'machine-a',
                    },
                },
            },
        });
        projectionDescribeSpy.mockImplementation(async (machineId: string) => ({
            supported: true,
            projection: pluginUiProjectionWithAppTab({
                generation: machineId === 'machine-a' ? 3 : 4,
                pluginId: 'happier.triage',
                localId: machineId === 'machine-a' ? 'panel-a' : 'panel-b',
            }),
        }));
        const renderApp = () => (
            <AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>
        );
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
        expect(readPlacements().map((placement) => placement.descriptorId)).toEqual(['panel-a', 'panel-b']);
        expect(readPlacements().every(placement => placement.hostCompatibility === 'compatible')).toBe(true);
        expect(readPluginUiContributionOrigin(readPlacements()[0])).toBeNull();

        await act(async () => {
            persistentStorage.setState((state) => ({
                settings: {
                    ...state.settings,
                    machineAdministrationTargetsLocalV1: {
                        ...state.settings.machineAdministrationTargetsLocalV1,
                        'plugins.home': {
                            serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
                            machineId: 'machine-b',
                        },
                    },
                },
            }));
        });
        await screen.update(renderApp());
        await flushHookEffects({ cycles: 6 });

        expect(readPlacements().map((placement) => placement.descriptorId)).toEqual(['panel-a', 'panel-b']);
        expect(readPluginUiContributionOrigin(readPlacements()[0])).toBeNull();

        await screen.unmount();
    });

    it.each(['opened', 'pending', 'hydrated-pending'] as const)('retains an admitted source read through a same-key %s daemon content publication', async (publication) => {
        const projectionOps = await import('@/sync/ops/machineContributionRegistryProjection');
        // Observe the caller signal without substituting the shared read owner.
        const readObserver = vi.spyOn(projectionOps, 'machinePluginUiTargetedContributionsRead');
        onTestFinished(() => readObserver.mockRestore());
        const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
        const { settlePluginSurfaceHostApiRequest } = await import('@/components/plugins/surfaces/createPluginSurfaceHostApi');
        const pluginId = 'acme.pending-source';
        const machineId = 'machine-pending-source';
        const occurrenceId = `${pluginId}:panel:occurrence`;
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'pending-source-root' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({
            serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId, sourceRef: { machineId, pluginId, sourceCustody },
        });
        const targetedResponse = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
            status: 'current', targetedContributions: {
                target: { pluginId, occurrenceId, sourceCustody }, points: [],
            }, targetedSurfaceMounts: [],
        });
        const daemonState = MachinePublishedDaemonStateV1Schema.parse({ status: 'running', pid: 17,
            runtimeId: 'pending-source-runtime', contributionRegistryProjectionRevision: 1 });
        const machine = createLiveMachine(machineId);
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const secret = new Uint8Array(32).fill(17);
        const encryption = publication === 'hydrated-pending' ? await Encryption.create(secret) : null;
        encryption?.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const dataKey = new Uint8Array(32).fill(23);
        const dataEncryptionKey = encryption
            ? encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64') : MACHINE_PLAIN_DATA_KEY_MARKER;
        if (encryption) await encryption.initializeMachines(new Map([[machineId, dataKey]]));
        persistentStorage.getState().applyMachines([{ ...machine, daemonState, daemonStateVersion: 2,
            storageMode: encryption ? 'e2ee' : 'plain', dataEncryptionKey,
            keyBasis: { dataEncryptionKey,
                metadataVersion: machine.metadataVersion, daemonStateVersion: 2 },
        }], true, { sourceServerId: storageState.activeServer.serverId });
        const raw = pluginUiProjectionWithAppTab({ generation: 7, pluginId, origin: executionOrigin });
        projectionDescribeSpy.mockResolvedValue({ supported: true, projection: PluginProjectionV2Schema.parse({ ...raw,
            actionsById: { [`${pluginId}/read-source`]: { id: 'read-source', pluginId, occurrenceId,
                title: 'Read source', scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe',
                execution: { target: 'daemon' }, available: true, executionOrigin } },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Pending source', version: '1.0.0',
                enabled: true, source: { kind: 'localPath', locator: 'pending-source-root' },
                sourceCustody, executionOrigin, occurrenceId, declaresContributionPoints: true } },
        }) });
        const pending = createDeferred<unknown>();
        const signals: AbortSignal[] = [];
        const cancellations: Array<Readonly<{ stack?: string }>> = [];
        // Only the external daemon RPC is deferred. Selection, committed
        // projection, mounted read sharing and cancellation remain real.
        targetedProjectionRead.mockImplementation(async request => {
            const signal = request.signal;
            if (!signal) throw new Error('Targeted RPC must carry the real cancellation signal');
            signals.push(signal);
            const cancel = () => {
                const error = Object.assign(new Error('Daemon read cancelled'), { code: 'MACHINE_RPC_ABORTED' });
                cancellations.push({ stack: error.stack });
                pending.reject(error);
            };
            signal.addEventListener('abort', cancel, { once: true });
            try { return await pending.promise; }
            finally { signal.removeEventListener('abort', cancel); }
        });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(<AppShellPluginUiProjectionProvider>
            <PendingSourceExecutionProbe pluginId={pluginId} />
        </AppShellPluginUiProjectionProvider>);
        const read = () => screen.tree.findByType('PendingSourceExecutionProbe' as never).props as {
            execution: ReturnType<typeof usePluginSurfaceExecutionOrigin>;
            targeted: ReturnType<typeof useMountedTargetedContributions>;
        };
        await vi.waitFor(() => {
            expect(read().execution.selectedSupply?.occurrenceId).toBe(occurrenceId);
            expect(signals).toHaveLength(1);
        });
        const callerSignal = readObserver.mock.calls[0]?.[1].signal;
        if (!callerSignal) throw new Error('The mounted read did not expose its original cancellation signal');
        let callerCancellationStack: string | undefined;
        const recordCallerCancellation = () => { callerCancellationStack = new Error('Mounted reader cancelled').stack; };
        callerSignal.addEventListener('abort', recordCallerCancellation, { once: true });
        onTestFinished(() => callerSignal.removeEventListener('abort', recordCallerCancellation));
        const admitted = read().execution.selectedSupply;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const revision = (await import('@/sync/ops/machineContributionRegistryProjectionRevision'))
            .getMachineContributionRegistryProjectionRevision({ machineId, serverId: storageState.activeServer.serverId });
        await act(async () => {
            const current = persistentStorage.getState().machines[machineId]!;
            if (!current.keyBasis) throw new Error('The admitted fixture lost its published basis');
            const { buildUpdatedMachineFromSocketUpdate, fetchAndApplyMachines } = await import('@/sync/engine/machines/syncMachines');
            const updated = publication !== 'opened' ? await buildUpdatedMachineFromSocketUpdate({
                existingMachine: current, machineUpdate: { machineId }, updateSeq: 2,
                updateCreatedAt: current.updatedAt + 1,
                keyBasis: { ...current.keyBasis, daemonStateVersion: 3 },
                getMachineEncryption: id => encryption?.getMachineEncryption(id) ?? null,
            }) : { ...current, keyBasis: { ...current.keyBasis, daemonStateVersion: 3 }, daemonStateVersion: 3 };
            if (!updated) throw new Error('The current socket publication was discarded');
            persistentStorage.getState().applyMachines([updated], false, { sourceServerId: storageState.activeServer.serverId });
            if (encryption) {
                const machineEncryption = encryption.getMachineEncryption(machineId)!;
                const row = { ...current,
                    metadata: await machineEncryption.encryptMetadata(current.metadata!),
                    daemonState: await machineEncryption.encryptDaemonState(daemonState),
                };
                await fetchAndApplyMachines({
                    credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: APP_SCOPE_FIXTURE.accountId })).toString('base64url')}.signature`,
                        secret: encodeBase64(secret, 'base64url') },
                    sourceServerId: storageState.activeServer.serverId, expectedAccountMode: 'e2ee',
                    encryption, machineDataKeys: new Map(), request: async () => Response.json([row]),
                    getExistingMachine: id => persistentStorage.getState().machines[id],
                    getMachineSnapshot: () => persistentStorage.getState().machines,
                    applyMachines: (machines, replace) => persistentStorage.getState().applyMachines(machines, replace,
                        { sourceServerId: storageState.activeServer.serverId }),
                    applyMachineDisplayEntries: (machines, options) => persistentStorage.getState().replaceMachineDisplays(machines,
                        { ...options, sourceServerId: storageState.activeServer.serverId }),
                });
            }
        });
        await flushHookEffects();
        // Fresh execution remains closed, but an un-opened same-key hint is
        // not proof that this exact plugin occurrence/custody was replaced.
        expect(captureActiveServerAccountScopeLifetime()).toBe(accountLifetime);
        expect((await import('@/sync/ops/machineContributionRegistryProjectionRevision'))
            .getMachineContributionRegistryProjectionRevision({ machineId, serverId: storageState.activeServer.serverId })).toBe(revision);
        expect(read().execution.selection.canExecute).toBe(publication === 'opened');
        if (publication !== 'opened') expect(read().execution.isExecutionOriginCurrent()).toBe(false);
        expect.soft(signals[0]!.aborted, JSON.stringify({ callerCancellationStack, cancellations,
            selection: read().execution.selection.state.kind, targetedPhase: read().targeted.phase })).toBe(false);
        expect.soft(read().execution.selectedSupply?.occurrenceId).toBe(admitted?.occurrenceId);
        // Consume the selected producer through the same bound-controller
        // front door: content pending must refuse execution, not erase caller
        // provenance and misclassify it as an unmounted caller.
        if (publication !== 'opened') {
            const supply = read().execution.selectedSupply;
            const mountedProjection = readCurrentAppShellPluginUiProjection();
            const controller = createBoundPluginSurfaceController({ facts: {
                pluginId, contributionId: 'panel', surfaceId: `surfacePlacement:${pluginId}:panel`,
                placement: 'rightSidebarSurface', platform: 'web', accountLifetime,
                machineId: supply?.machineId, serverId: supply?.serverId,
                occurrenceId: supply?.occurrenceId,
                executionOrigin: supply?.executionOrigin, interactionEnabled: true,
                daemonInteractionEnabled: read().execution.selection.canExecute,
                pluginUiProjection: mountedProjection,
                resolveContributedAction: createPluginUiProjectedActionResolver(mountedProjection?.actionsById),
            }, binding: { isExecutionOriginCurrent: () => read().execution.isExecutionOriginCurrent() } });
            try {
                const request = { version: 1 as const, requestId: 'pending-source-read', surface: controller.surfaceContext,
                    method: 'executeAction' as const, payload: { action: { pluginId, localId: 'read-source' }, input: {} } };
                const refusal = await settlePluginSurfaceHostApiRequest(request, () => controller.hostApi.handleRequest(request));
                expect(refusal, JSON.stringify(refusal)).toMatchObject({ kind: 'error', payload: { code: 'unavailable' } });
                expect.soft(refusal.kind === 'error' ? refusal.payload.diagnostics : [])
                    .not.toContain('plugin_mounted_caller_unavailable');
            } finally { controller.dispose(); }
            // Opening that same publication does not replace the origin or
            // occurrence. Its original read must survive the whole transition.
            await act(async () => {
                const current = persistentStorage.getState().machines[machineId]!;
                persistentStorage.getState().applyMachines([{ ...current, daemonStateVersion: 3 }], false,
                    { sourceServerId: storageState.activeServer.serverId });
            });
            await flushHookEffects();
            expect(read().execution.selection.canExecute).toBe(true);
            expect.soft(read().execution.selectedSupply?.occurrenceId).toBe(admitted?.occurrenceId);
            expect.soft(callerSignal.aborted).toBe(false);
            expect.soft(signals).toHaveLength(1);
            expect.soft(signals[0]!.aborted).toBe(false);
        }
        await act(async () => { pending.resolve(targetedResponse); });
        await flushHookEffects();
        expect.soft(read().targeted.phase).toBe('ready');
        callerSignal.removeEventListener('abort', recordCallerCancellation);
        readObserver.mockRestore();
        await screen.unmount();
    });

    it('keeps Account source pins inert while local Machine memory controls current development selection', async () => {
        const pluginId = 'acme.source-page';
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Source fixture must have an applied Account lifetime');
        storageState.machines = [createLiveMachine('machine-a'), createLiveMachine('machine-b')];
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'source-page-root' };
        const retainedSettings = {
            machineAdministrationSelectionsV1: { v: 1, targetsByKey: {}, pluginExecutionOriginsByPluginId: { [pluginId]: {
                serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
                sourceRef: { machineId: 'machine-b', pluginId, sourceCustody },
            } } },
        };
        const selectedSource = PluginMachineExecutionOriginV1Schema.parse(
            retainedSettings.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId[pluginId],
        );
        await act(async () => { persistentStorage.setState(state => ({ settingsScope: accountLifetime.scope, settings: { ...state.settings,
            machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} },
            machineAdministrationTargetsLocalV1: clearPluginMachineExecutionOriginPreference(state.settings.machineAdministrationTargetsLocalV1, pluginId),
        } })); });
        projectionDescribeSpy.mockImplementation(async (machineId: string) => {
            const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({
                serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId, sourceRef: { machineId, pluginId, sourceCustody },
            });
            const projection = pluginUiProjectionWithAppTab({ generation: machineId === 'machine-a' ? 3 : 4, pluginId, origin: executionOrigin });
            return { supported: true, projection: PluginProjectionV2Schema.parse({ ...projection,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Source page', version: machineId === 'machine-a' ? '1.0.0' : '2.0.0',
                    enabled: true, source: { kind: 'localPath', locator: 'source-page-root' }, sourceCustody, executionOrigin,
                    occurrenceId: `${pluginId}:panel:occurrence` } },
            }) };
        });
        const { AppShellPluginUiProjectionProvider } = await import('./AppShellPluginUiProjection');
        const screen = await renderScreen(<AppShellPluginUiProjectionProvider><ProjectionProbe /></AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 8 });
        const readPlacements = () => selectPluginSurfacePlacementsForBinding(
            screen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection,
            { container: 'rightSidebarTab', targetKind: 'app' },
        );
        const automaticOrigin = readPluginUiContributionOrigin(readPlacements()[0]);
        expect(automaticOrigin).toMatchObject({ machineId: 'machine-a', executionOrigin: {
            serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId,
            sourceRef: { machineId: 'machine-a', pluginId, sourceCustody },
        } });
        await act(async () => { persistentStorage.setState({ settings: normalizeAccountSettingsForLocalStorage({
            raw: retainedSettings, mode: 'plain', settingsSecretsKey: null,
            localSettings: persistentStorage.getState().settings,
        }) }); });
        await flushHookEffects({ cycles: 8 });
        // Retired Account source pins are inert. The answering device's local
        // choice selects the current admitted development source instead.
        expect(readPluginUiContributionOrigin(readPlacements()[0])).toEqual(automaticOrigin);
        await act(async () => { persistentStorage.setState(state => ({ settings: { ...state.settings,
            machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference(state.settings.machineAdministrationTargetsLocalV1, pluginId, selectedSource),
        } })); });
        await flushHookEffects({ cycles: 8 });
        expect(readPluginUiContributionOrigin(readPlacements()[0])?.machineId).toBe('machine-b');
        expect(readPlacements()[0]?.hostCompatibility).toBe('compatible');
        expect(readPlacements()[0]?.pluginVersion).toBe('2.0.0');
        expect(readPlacements()[0]?.occurrenceId).toBe(`${pluginId}:panel:occurrence`);
        expect(persistentStorage.getState().settings.machineAdministrationTargetsLocalV1[`plugin.runOn:${pluginId}`])
            .toEqual({ serverIdentityId: APP_SCOPE_FIXTURE.serverIdentityId, machineId: 'machine-b' });
        await screen.unmount();
        await act(async () => { storageState.machines = [createLiveMachine('machine-a')]; });
        const coldScreen = await renderScreen(<AppShellPluginUiProjectionProvider>
            <ProjectionProbe /><SourceExecutionProbe pluginId={pluginId} />
        </AppShellPluginUiProjectionProvider>);
        await flushHookEffects({ cycles: 8 });
        const readColdPlacement = () => selectPluginSurfacePlacementsForBinding(
            coldScreen.tree.findByType('ProjectionProbe' as never).props.value.pluginUiProjection,
            { container: 'rightSidebarTab', targetKind: 'app' },
        )[0];
        // D1 keeps the admitted UI declaration visible independently of the
        // Run-on preference. That declaration is not permission to execute on
        // its supplier when the deliberately chosen Machine is absent.
        expect(readColdPlacement()).toBeDefined();
        expect(readPluginUiContributionOrigin(readColdPlacement())).toBeNull();
        expect(readPluginUiContributionSupplies(readColdPlacement())).toMatchObject([
            { machineId: 'machine-a', phase: 'current' },
        ]);
        const readExecution = () => coldScreen.tree.findByType('SourceExecutionProbe' as never).props.execution as ReturnType<typeof usePluginSurfaceExecutionOrigin>;
        expect(readExecution().selection.canExecute).toBe(false);
        expect(readExecution().selection.resolveExecutionOrigin()).toBeNull();
        expect(readExecution().isExecutionOriginCurrent()).toBe(false);
        expect(persistentStorage.getState().settings.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId[pluginId])
            .toEqual(retainedSettings.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId[pluginId]);
        await act(async () => { persistentStorage.setState(state => ({ settings: { ...state.settings,
            machineAdministrationTargetsLocalV1: clearPluginMachineExecutionOriginPreference(state.settings.machineAdministrationTargetsLocalV1, pluginId),
        } })); });
        await flushHookEffects({ cycles: 8 });
        expect(readPluginUiContributionOrigin(readColdPlacement())?.machineId).toBe('machine-a');
        expect(readExecution().selection.canExecute).toBe(true);
        await act(async () => { persistentStorage.setState({ settings: normalizeAccountSettingsForLocalStorage({
            raw: retainedSettings, mode: 'plain', settingsSecretsKey: null,
            localSettings: persistentStorage.getState().settings,
        }) }); });
        await flushHookEffects({ cycles: 8 });
        expect(readPluginUiContributionOrigin(readColdPlacement())?.machineId).toBe('machine-a');
        await act(async () => { persistentStorage.setState(state => ({ settings: { ...state.settings,
            machineAdministrationTargetsLocalV1: setPluginMachineExecutionOriginPreference(state.settings.machineAdministrationTargetsLocalV1, pluginId, selectedSource),
        } })); });
        await flushHookEffects({ cycles: 8 });
        expect(readColdPlacement()).toBeDefined();
        expect(readPluginUiContributionOrigin(readColdPlacement())).toBeNull();
        expect(readPluginUiContributionSupplies(readColdPlacement())).toMatchObject([
            { machineId: 'machine-a', phase: 'current' },
        ]);
        expect(readExecution().selection.canExecute).toBe(false);
        expect(readExecution().selection.resolveExecutionOrigin()).toBeNull();
        await act(async () => { storageState.machines = [createLiveMachine('machine-a'), createLiveMachine('machine-b')]; });
        await flushHookEffects({ cycles: 8 });
        expect(readPluginUiContributionOrigin(readColdPlacement())?.executionOrigin)
            .toEqual(retainedSettings.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId[pluginId]);
        expect(readColdPlacement()?.hostCompatibility).toBe('compatible');
        expect(readColdPlacement()?.pluginVersion).toBe('2.0.0');
        expect(readExecution().selection.canExecute).toBe(true);
        expect(readExecution().selection.resolveExecutionOrigin()?.origin)
            .toEqual(retainedSettings.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId[pluginId]);
        expect(readExecution().isExecutionOriginCurrent()).toBe(true);
        await coldScreen.unmount();
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
