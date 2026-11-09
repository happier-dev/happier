import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol/account/profile';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { createMachineFixture, createRootLayoutFeaturesResponse, pressTestInstanceAsync, renderScreen as renderUiScreen, standardCleanup } from '@/dev/testkit';
import type { IModal } from '@/modal';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerTeamCredentialDiscoveryForTests, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { teamSummaryFixture, teamCapabilitiesFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { TeamsPageV1Schema, TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceEntitledPageV1Schema,
    TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1 } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { ServerIdentityCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { PluginSourceCustodyV1Schema, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn((..._args: Parameters<IModal['alert']>) => undefined));
const modalShowSpy = vi.hoisted(() => vi.fn((_config: Parameters<IModal['show']>[0]) => 'screen-default-modal'));
const modalHideSpy = vi.hoisted(() => vi.fn((_id: string) => {}));

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (options?: Readonly<{ default?: unknown }>) => (options && 'default' in options ? options.default : undefined),
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const profileState = vi.hoisted(() => ({
    activeAccountScope: null as null | { serverId: string; accountId: string },
    connectedAccountsV4: [] as AccountProfile['connectedAccountsV4'],
    teamCredentialCatalog: {
        resources: [] as Array<Record<string, unknown>>,
        teamNameById: {} as Record<string, string>,
        homeNameByTeamId: {} as Record<string, string>,
        resourceStatusByKey: new Map(),
        current: true,
        condition: null,
    },
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        },
    ] as Array<Record<string, unknown>>,
}));
const connectedServiceRegistryState = vi.hoisted(() => ({
    status: 'ready' as 'loading' | 'ready' | 'stale' | 'error' | 'conflict',
    errorReason: null as string | null,
    entries: [{
        serviceId: 'openai-codex',
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        legacyServiceId: 'openai-codex',
        connectCommand: 'happier connect codex',
        supportsOauth: true,
        executable: true,
    }] as Array<Record<string, unknown>>,
}));
const serverFeaturesState = vi.hoisted(() => ({
    qualifiedAccounts: undefined as { protocolVersion: 4 } | undefined,
}));
const daemonAgentProjectionState = vi.hoisted(() => ({
    mergedProviderProjectionById: {} as Record<string, Record<string, unknown>>,
}));

const projectionReloadSpy = vi.hoisted(() => vi.fn());

const machineState = vi.hoisted(() => ({
    machines: [] as Array<{ id: string; active: boolean; activeAt?: number; presenceProtocolVersion?: 1; metadata?: { displayName?: string } }>,
}));

// One settings fixture behind both settings readers, so a narrowed `useSettingsSelector` read and a
// whole-object `useSettings` read never disagree.
const SETTINGS_FIXTURE = vi.hoisted(() => ({
    connectedServicesDefaultProfileByServiceId: {},
    connectedServicesProfileLabelByKey: {},
    connectedServicesProviderStateSharingSettingsV1: {},
    connectedServicesDefaultAuthByAgentIdV1: {},
}));

const account = createProviderSettingsAccountHarness();
const homes = account.home;
await loadSyncSingletonForTests();
const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
const { Item } = await import('@/components/ui/lists/Item');
const { ConnectedServicesConnectMore } = await import('./setup/ConnectedServicesConnectMore');
const { ConnectedServiceSetupPanel } = await import('./setup/ConnectedServiceSetupPanel');
const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { getConnectedServiceRegistrySnapshot } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
const profiles = await import('@/sync/domains/server/serverProfiles');
// Consume the daemon's pure producer without exposing CLI-private aliases to the UI compiler.
const originProducerPath = '../../../../../cli/src/plugins/runtime/resolvePluginMachineExecutionOrigin';
const { resolvePluginMachineExecutionOrigin } = await vi.importActual<{
    resolvePluginMachineExecutionOrigin(input: Readonly<{
        pluginId: string;
        context: Readonly<{ serverIdentityId: string; machineId: string }>;
        sourceCustody: PluginSourceCustodyV1;
    }>): PluginMachineExecutionOriginV1 | null;
}>(originProducerPath);
const homeIdentity = ServerIdentityCapabilitiesSchema.parse({ serverIdentityId: 'srv_connected_services_fixture' }).serverIdentityId;
if (!homeIdentity) throw new Error('Expected the Home issuer fixture to advertise a portable identity');
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let prepared = false;
let daemonReadFails = false;
let daemonReadUnsupported = false;
let accountRegistryReadFailure: 'materializations' | 'intents' | null = null;
let preparedScope = '';
let purposeBoundary: ReturnType<typeof createConnectedPurposeCatalogHttpBoundary> | undefined;
const machineRpcRequests = installSessionActionRpcBoundary(request => {
    if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) {
        projectionReloadSpy();
        if (daemonReadUnsupported) return { error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        if (daemonReadFails) throw new Error(connectedServiceRegistryState.errorReason ?? 'Daemon projection unavailable');
        return createDaemonProjectionResponse();
    }
    return { error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
});

/** Cold daemon declarations; the app's registry/catalog/currentness owners interpret them. */
function createDaemonProjectionResponse() {
    const descriptors = connectedServiceRegistryState.entries.map(entry => {
        const service = entry.service;
        if (!service || typeof service !== 'object' || !('pluginId' in service) || !('localId' in service)
            || typeof service.pluginId !== 'string' || typeof service.localId !== 'string') throw new Error('Expected qualified daemon service');
        return ConnectedAccountUiProjectionEntryV1Schema.parse({
            id: service.localId, pluginId: service.pluginId, serviceId: entry.serviceId,
            occurrenceId: `occurrence:${service.pluginId}`, provenance: 'external', sourceKind: 'development',
            title: entry.projectedTitle ?? entry.serviceId,
            authentication: { defaultModeId: 'sign-in', modes: entry.supportsOauth
                ? [{ id: 'sign-in', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }]
                : [{ id: 'sign-in', kind: 'manual', fields: [], outcomeReconciliation: 'none' }] },
            capabilities: [], availability: { reason: 'ready', ...(typeof entry.availability === 'object' && entry.availability !== null
                ? entry.availability : { state: 'available' }) },
            diagnostics: entry.diagnostics ?? [],
        });
    });
    const pluginIds = [...new Set(descriptors.map(descriptor => descriptor.pluginId!))];
    return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        v: 2, generation: 1,
        installedPackagesById: Object.fromEntries(pluginIds.map(pluginId => {
            // The daemon's installed-package/filesystem leaf owns these source facts.
            const sourceCustody = PluginSourceCustodyV1Schema.parse({ kind: 'development', registeredRootId: `fixture:${pluginId}` });
            const profile = profiles.getServerProfileById(profiles.resolveServerProfileScopeIdForIdentifier(account.serverId));
            const machine = storage.getState().machines['machine-a'];
            if (!profile?.serverIdentityId || !machine) throw new Error('Expected the restored Home and its published Machine');
            const executionOrigin = resolvePluginMachineExecutionOrigin({ pluginId, sourceCustody,
                context: { serverIdentityId: profile.serverIdentityId, machineId: machine.id } });
            if (!executionOrigin) throw new Error('Expected the daemon producer to admit its exact Home/Machine source');
            return [pluginId, { id: pluginId, displayName: pluginId, version: '1.0.0', enabled: true,
                occurrenceId: `occurrence:${pluginId}`, sourceCustody, executionOrigin,
                source: { kind: 'development', locator: `/plugins/${pluginId}` } }];
        })),
        agentsById: Object.fromEntries(Object.entries(daemonAgentProjectionState.mergedProviderProjectionById).map(([id, agent]) => [id, {
            id, identity: agent.identity, title: agent.title, isBuiltIn: agent.isBuiltIn, acpRegistryIds: [],
            catalogAgentId: agent.catalogAgentId, connectedAccounts: agent.connectedAccounts,
        }])),
        familiesById: { connectedAccounts: { family: 'connectedAccounts',
            entriesById: Object.fromEntries(descriptors.map(descriptor => [`${descriptor.pluginId}/${descriptor.id}`, descriptor])) } },
    } });
}

async function prepareAccountFixture() {
    const scope = profileState.activeAccountScope ?? { serverId: 'server-1', accountId: 'account-1' };
    const scopeKey = `${scope.serverId}:${scope.accountId}`;
    if (prepared && preparedScope !== scopeKey) { await account.reset(); prepared = false; }
    if (!prepared) {
        const teamsEnabled = profileState.teamCredentialCatalog.resources.length > 0;
        const features = createRootLayoutFeaturesResponse({ homePresentation: { v: 1, displayName: 'Home A' },
            capabilities: { serverIdentity: { serverIdentityId: homeIdentity }, connectedServices: { credentialDelete: { revisionGuard: false },
                ...(serverFeaturesState.qualifiedAccounts ? { qualifiedAccounts: serverFeaturesState.qualifiedAccounts } : {}) } },
            features: { providers: { enabled: false }, connectedServices: { quotas: { enabled: false }, accountGroups: { enabled: false } },
                teams: { enabled: teamsEnabled, credentialResources: { enabled: teamsEnabled, externalApi: { enabled: false } } } } });
        const machines = machineState.machines.map(row => createMachineFixture({ ...row,
            metadata: { ...createMachineFixture().metadata!, ...row.metadata }, activeAt: row.activeAt ?? (row.active ? Date.now() : 0) }));
        await account.restore({ accountId: scope.accountId ?? undefined, serverIdentityId: homeIdentity ?? undefined, features,
            settings: SETTINGS_FIXTURE, machines,
            // A failed Machine read is partial coverage once Account discovery answered.
            // These notice cases need the real failed Account discovery boundary.
            httpAnswers: accountRegistryReadFailure ? {
                [accountRegistryReadFailure === 'materializations'
                    ? PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']
                    : PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']]: {
                    status: 503, body: { error: connectedServiceRegistryState.errorReason },
                },
            } : undefined });
        const purposes = createConnectedPurposeCatalogHttpBoundary();
        purposeBoundary = purposes;
        homes.answer(account.serverId, purposes.path, { select: async (_input, request) => {
            const response = await purposes.handle(request.url, request.init);
            if (!response) throw new Error('Missing purpose catalog response');
            return { status: response.status, body: await response.json() };
        } });
        if (teamsEnabled) {
            const catalog = profileState.teamCredentialCatalog;
            const list = bindHomeDomainActionHttpRequestV1('teams.list', { v: 1, scope: 'member', archived: 'active', limit: TEAM_DIRECTORY_PAGE_LIMIT_DEFAULT_V1, cursor: null });
            homes.answer(account.serverId, `${list.method} ${list.path}`, { body: TeamsPageV1Schema.parse({
                items: Object.entries(catalog.teamNameById).map(([id, name]) => teamSummaryFixture({ id, name,
                    capabilities: teamCapabilitiesFixture({ viewTeam: true }) })), nextCursor: null,
            }) });
            answerTeamCredentialDiscoveryForTests(homes, account.serverId, input => ({
                resources: catalog.resources.filter(resource => input.teamIds.includes(String(resource.teamId)))
                    .map(resource => TeamCredentialResourceCatalogEntryV1Schema.parse(resource)),
                nextCursor: null, failures: [],
            }));
        }
        prepared = true;
        preparedScope = scopeKey;
    }
    const profile = AccountProfileSchema.parse({ ...storage.getState().profile, id: scope.accountId,
        connectedServicesV2: profileState.connectedServicesV2, connectedAccountsV4: profileState.connectedAccountsV4 });
    homes.answer(account.serverId, '/v1/account/profile', { body: profile });
    await sync.refreshProfile();
}

function ConnectedServicesTestProviders({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={sync.getCredentials()}>
        <AppShellPluginUiProjectionProvider>{children}</AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>;
}

async function renderScreen(element: React.ReactElement) {
    await prepareAccountFixture();
    const wantsStale = connectedServiceRegistryState.status === 'stale';
    daemonReadFails = connectedServiceRegistryState.status === 'error';
    // Validate the daemon fixture against its real consumer schema before a
    // malformed response can be classified as an unavailable registry read.
    if (!daemonReadFails && machineState.machines.some(machine => machine.active)) createDaemonProjectionResponse();
    const screen = await renderUiScreen(element, { wrapper: ConnectedServicesTestProviders });
    const hasOnlineMachine = machineState.machines.some(machine => machine.active);
    await waitForHomeGovernance(() => expect(getConnectedServiceRegistrySnapshot().status).toBe(
        wantsStale && !accountRegistryReadFailure ? 'ready' : connectedServiceRegistryState.status));
    if (wantsStale && hasOnlineMachine && !accountRegistryReadFailure) {
        // Transient transport failure intentionally retains admitted current
        // declarations. An explicit unsupported reply withdraws that authority.
        daemonReadUnsupported = true;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId: account.serverId, machineId: 'machine-a' }, 'authority'));
        await waitForHomeGovernance(() => expect(getConnectedServiceRegistrySnapshot().status).toBe('stale'));
    }
    if (profileState.teamCredentialCatalog.resources.length > 0) {
        const { getTeamCredentialResourceCatalogSnapshot } = await import('@/sync/store/teams/teamsSnapshots');
        await waitForHomeGovernance(() => {
            const scope = storage.getState().profileScope;
            for (const teamId of Object.keys(profileState.teamCredentialCatalog.teamNameById)) {
                expect(getTeamCredentialResourceCatalogSnapshot(scope, { serverId: scope!.serverId, teamId })?.status).toBe('ready');
            }
        });
    }
    return { ...screen, update: async (next: React.ReactElement) => { await prepareAccountFixture(); await screen.update(next); } };
}

describe('ConnectedServicesSettingsView', () => {
    beforeEach(async () => {
        daemonReadUnsupported = false;
        accountRegistryReadFailure = null;
        browser = await installBrowserRuntimeForTests({ url: 'https://connected-services.test/' });
        await account.reset();
        prepared = false;
        preparedScope = '';
        purposeBoundary = undefined;
        daemonReadFails = false;
        clearDaemonMergedProjectionCacheForTests();
        const { Modal } = await import('@/modal');
        const text = await import('@/text');
        vi.spyOn(Modal, 'alert').mockImplementation(modalAlertSpy);
        vi.spyOn(Modal, 'show').mockImplementation(modalShowSpy);
        vi.spyOn(Modal, 'hide').mockImplementation(modalHideSpy);
        vi.spyOn(text, 't').mockImplementation((key: string, params?: unknown) => (
            params && typeof params === 'object' ? `${key} ${Object.values(params).join(' ')}` : key
        ));
        modalShowSpy.mockClear();
        modalHideSpy.mockClear();
        profileState.connectedAccountsV4 = [];
        profileState.activeAccountScope = null;
        profileState.teamCredentialCatalog = {
            resources: [], teamNameById: {}, homeNameByTeamId: {}, resourceStatusByKey: new Map(), current: true, condition: null,
        };
        daemonAgentProjectionState.mergedProviderProjectionById = {
            codex: {
                agentId: 'codex',
                title: 'Codex',
                qualifiedId: 'happier.agent.codex/codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                catalogAgentId: 'codex',
                isBuiltIn: true,
                connectedAccounts: [{
                    purpose: 'primary',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    required: false,
                }],
            },
        };
        serverFeaturesState.qualifiedAccounts = undefined;
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.errorReason = null;
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect codex',
            supportsOauth: true,
            executable: true,
        }];
        modalAlertSpy.mockClear();
        machineState.machines = [{ id: 'machine-a', active: true, activeAt: Date.now() }];
        // P8 / O-COLUMNS-R3: the phone index is the collection; these cases exercise its All services overview.
        connectedServicesModuleState.searchParams = { view: 'all' };
        connectedServicesModuleState.routerPushSpy.mockClear();
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
            },
        ];
    });

    afterEach(async () => {
        await standardCleanup();
        try { await account.reset(); } finally { browser?.restore(); }
    });

    it('muse.experience.pc14 keeps settled Credentials idle for 60 seconds without timers or requests', async () => {
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        // Current Homes push presence transitions; an unmarked row deliberately uses the legacy expiry clock.
        machineState.machines = [{ id: 'machine-a', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 }];
        await prepareAccountFixture();
        vi.useFakeTimers();
        const census = installTimerCensus();
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            screen = await renderScreen(<ConnectedServicesSettingsView />);
            await flushHookEffects({ cycles: 3, turns: 3, advanceTimersMs: 20 });
            expect(screen.findByTestId('connected-services-account:happier.agent.codex/openai-codex:work')).not.toBeNull();
            const fires = census.readFires();
            const requests = { http: homes.requests.length, machine: machineRpcRequests.length };
            await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
            expect(census.readFires()).toEqual(fires);
            expect({ http: homes.requests.length, machine: machineRpcRequests.length }).toEqual(requests);
        } finally {
            await screen?.unmount();
            census.stop();
            vi.useRealTimers();
        }
    });

    it('opens a Team-shared Connected Service resource on its exact Home route', async () => {
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'account-1' };
        profileState.teamCredentialCatalog = {
            resources: [{
                id: 'resource-1', teamId: 'team-1', displayName: 'Shared GitHub', resourceRevision: 3,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current',
                sessionUsePolicy: 'personal_allowed', providerModels: [],
                sourcePresentation: {
                    kind: 'connected_service', service: BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.github.service,
                },
            }],
            teamNameById: { 'team-1': 'Acme' }, homeNameByTeamId: { 'team-1': 'Home A' },
            resourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]), current: true, condition: null,
        };
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        const scope = storage.getState().profileScope;
        expect(scope).toEqual({ serverId: homeIdentity, accountId: 'account-1' });
        await screen.pressByTestIdAsync('team-credential-catalog-resource:team-1:resource-1');
        expect(connectedServicesModuleState.routerPushSpy)
            .toHaveBeenCalledWith(`/settings/teams/${scope!.serverId}/team-1/credentials/resource-1`);
    });

    it('keeps boundary diagnostics out of the primary row and exposes only bounded product-safe support detail', async () => {
        // This case exercises the List row; Cards became the device default under owner R7 (2026-11-09).
        storage.getState().applyLocalSettings({ connectedServicesIndexViewV1: 'list' });
        const longDiagnostic = `unexpected-${'x'.repeat(512)}`;
        connectedServiceRegistryState.entries = [{
            serviceId: 'bitbucket', connectCommand: 'happier connect bitbucket', supportsOauth: false, supportsToken: false,
            service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' },
            legacyServiceId: 'bitbucket',
            executable: false, projectedDescriptor: { id: 'account' }, projectedTitle: 'Bitbucket Cloud',
            projectionStatus: 'ready', availability: { state: 'blocked', reason: '/private/plugin/error' },
            diagnostics: ['missing_runtime', '/unexpected/path-shaped-diagnostic', 'token=never-render-this-primary', longDiagnostic],
        }];
        profileState.connectedServicesV2 = [];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        // The service's own state row in its section (Credentials list): its fact line says the one cause.
        const row = screen.tree.root.findByProps({
            testID: 'connected-services-index:happier.scm.forge.bitbucket/bitbucket-account:support-details',
        } as never);

        expect(row.props.title).toBe('Bitbucket Cloud');
        // One message per service: the highest-priority fact; the rest live on the plugin's own page.
        // The service-specific reason leads (no bare "Blocked"), as product copy only.
        expect(row.props.subtitle).toContain('connectedServicesSettings.runtimeNotLoaded');
        expect(row.props.subtitle).not.toContain('missing_runtime');
        expect(row.props.subtitle).not.toContain('/private/plugin/error');
        expect(row.props.subtitle).not.toContain('/unexpected/path-shaped-diagnostic');
        expect(row.props.subtitle).not.toContain('token=never-render-this-primary');
        expect(row.props.subtitle).not.toContain(longDiagnostic);

        const details = screen.tree.root.findByProps({
            testID: 'connected-services-index:happier.scm.forge.bitbucket/bitbucket-account:support-details',
        } as never);
        modalAlertSpy.mockClear();
        connectedServicesModuleState.routerPushSpy.mockClear();
        await pressTestInstanceAsync(details);
        // Details opens the owning plugin's page, where its diagnostics are read in full; never an OK-only alert.
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/plugins/[pluginId]', params: { pluginId: 'happier.scm.forge.bitbucket' },
        });
    });

    it('keeps projection failure detail product-safe in the failure banner, and retries the read', async () => {
        accountRegistryReadFailure = 'materializations';
        connectedServiceRegistryState.status = 'error';
        connectedServiceRegistryState.errorReason = '/private/plugin/registry?token=never-render-this';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        projectionReloadSpy.mockClear();

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const banner = screen.tree.root.findByProps({
            testID: 'connected-services-projection-error',
        } as never);

        // The quiet line shows the presented diagnostic, never the raw reason, anywhere on the page.
        expect(String(banner.props.reason)).toBe('connectedServicesSettings.projectionErrorDescription');
        const leaked = screen.tree.root.findAll((node) => Object.values(node.props ?? {}).some((value) => (
            typeof value === 'string' && (value.includes('/private/plugin/registry') || value.includes('token=never-render-this'))
        )));
        expect(leaked).toHaveLength(0);

        projectionReloadSpy.mockClear();
        await pressTestInstanceAsync(screen.tree.root.findByProps({
            testID: 'connected-services-projection-retry',
        } as never));
        await waitForHomeGovernance(() => expect(projectionReloadSpy).toHaveBeenCalledTimes(1));
    });

    it('says in the rail\'s "+" menu when Account discovery failed, keeps saved accounts choosable, and retries that read once', async () => {
        accountRegistryReadFailure = 'materializations';
        connectedServiceRegistryState.status = 'error';
        connectedServiceRegistryState.errorReason = 'transport';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }] }];
        const { ConnectedServicesRail } = await import('./collection/ConnectedServicesRail');
        const { HappierCollectionAddMenu } = await import('@happier-dev/plugin-ui/presentation');
        const screen = await renderScreen(<ConnectedServicesRail />);

        // The rail's own "+" (the closed menu: its notice and choices are already composed).
        const menu = screen.findAllByType(HappierCollectionAddMenu).find((node) => node.props.testID === 'connected-services-add-menu');
        expect(menu).toBeTruthy();
        const notice = menu!.props.notice;
        // The menu says plainly that its list is incomplete, with the page's same Retry; the page line keeps the reason.
        expect(notice).toMatchObject({ text: 'connectedServicesSettings.addMenuIncomplete', action: { label: 'common.retry' } });
        expect(menu!.props.items.map((item: { id: string }) => item.id)).toContain('account:happier.agent.codex/openai-codex');

        projectionReloadSpy.mockClear();
        await act(async () => { notice.action.onPress(); });
        await waitForHomeGovernance(() => expect(projectionReloadSpy).toHaveBeenCalledTimes(1));
        await act(async () => { await Promise.resolve(); });
        expect(projectionReloadSpy).toHaveBeenCalledTimes(1);
    });

    it('shows a stale registry read failure once while retaining accounts and service-specific causes', async () => {
        // The Machine inventory answers before Account declaration discovery fails.
        accountRegistryReadFailure = 'intents';
        storage.getState().applyLocalSettings({ connectedServicesIndexViewV1: 'list' });
        connectedServiceRegistryState.status = 'stale';
        connectedServiceRegistryState.errorReason = 'transport';
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            legacyServiceId: 'openai-codex', connectCommand: 'happier connect codex', supportsOauth: false, executable: false,
            projectedDescriptor: { id: 'openai-codex' }, projectedTitle: 'ChatGPT', projectionStatus: 'stale',
            availability: { state: 'available' }, diagnostics: [],
        }, {
            serviceId: 'bitbucket', service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' },
            legacyServiceId: 'bitbucket', connectCommand: 'happier connect bitbucket', supportsOauth: false, executable: false,
            projectedDescriptor: { id: 'bitbucket-account' }, projectedTitle: 'Bitbucket Cloud', projectionStatus: 'stale',
            availability: { state: 'blocked', reason: 'connected_account_configuration_required' }, diagnostics: ['missing_runtime'],
        }];
        profileState.connectedServicesV2 = [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }] }];
        projectionReloadSpy.mockClear();
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        const notices = screen.findAllByType(SurfaceStateCard).filter((node) => node.props.testID === 'connected-services-projection-error');
        expect(notices).toHaveLength(1);
        expect(notices[0]?.props.reason).toBe('connectedServicesSettings.projectionErrorDescription');
        expect(screen.findByTestId('connected-services-account:happier.agent.codex/openai-codex:work')).not.toBeNull();
        // A stale read never says the readable service is unavailable; the blocked one says its own cause once.
        expect(screen.findByTestId('connected-services-index:happier.agent.codex/openai-codex:support-details')).toBeNull();
        expect(screen.findByTestId('connected-services-index:happier.agent.codex/openai-codex:state')).toBeNull();
        expect(screen.findByTestId('connected-services-service:happier.agent.codex/openai-codex:add-account')).toBeNull();
        expect(screen.tree.root.findByProps({ testID: 'connected-services-index:happier.scm.forge.bitbucket/bitbucket-account:support-details' } as never)
            .props.subtitle).toContain('connectedServicesSettings.runtimeNotLoaded');
        projectionReloadSpy.mockClear();
        await pressTestInstanceAsync(screen.tree.root.findByProps({ testID: 'connected-services-projection-retry' } as never));
        await waitForHomeGovernance(() => expect(projectionReloadSpy).toHaveBeenCalledOnce());
    });

    it.each([true, false])('offers bundled Account-direct setup with no daemon services and machine online=%s', async online => {
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'account-1' };
        connectedServiceRegistryState.status = 'ready';
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const machine = createMachineFixture({ id: 'machine-a', active: online, activeAt: online ? Date.now() : 0 });
        machineState.machines = [{ id: machine.id, active: machine.active, activeAt: machine.activeAt,
            metadata: { displayName: 'lima-happier-fresh' } }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);

        // The bundled Gemini declaration's accountDirectSave mode is Account
        // authoring authority even when no Machine publishes a service. A
        // Machine prerequisite here would hide a usable sign-in path.
        const connect = 'connected-service-setup:connect:happier.agent.gemini/gemini-account';
        await vi.waitFor(() => expect(screen.findHostByTestId(connect), screen.getTextContent()).not.toBeNull());
        expect(screen.findHostByTestId('connected-services-empty')).toBeNull();
        await screen.pressByTestIdAsync(connect);
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-account-manual:token'), screen.getTextContent()).not.toBeNull());
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });

    it('renders first-run setup blocks when agents have services to connect', async () => {
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const screen = await renderScreen(React.createElement(ConnectedServicesSettingsView));
        const tree = screen.tree;

        expect(tree.root.findAllByProps({ testID: 'connected-services-empty' } as never)).toHaveLength(0);
        const setup = tree.root.findByType(ConnectedServicesConnectMore);
        expect(setup.props.layout).toBe('firstRun');
        expect(setup.props.model.connectable.map((service: { serviceKey: string }) => service.serviceKey))
            .toContain('happier.agent.codex/openai-codex');
        // Nothing navigated away: the setup is where the person asked.
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });

    it.each([
        [{ connect: '1' }, {}],
        [{ connect: '1', service: 'happier.agent.codex/openai-codex' }, {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        }],
    ])('opens the shared sheet from the collection deep link without navigating', async (params, request) => {
        connectedServicesModuleState.searchParams = params;
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { tree } = await renderScreen(<ConnectedServicesSettingsView />);
        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining(request),
        }) }));
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        await act(async () => modalShowSpy.mock.calls.at(-1)?.[0].onRequestClose?.());
        expect(tree.root.findByType(ConnectedServicesConnectMore).props.request).toBeUndefined();
    });

    it('shows the destination purpose default on Agent sign-in with the retired Settings root absent', async () => {
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'destination-account' };
        serverFeaturesState.qualifiedAccounts = { protocolVersion: 4 };
        profileState.connectedAccountsV4 = [{
            revisionSemantics: 'legacy_unfenced',
            credentialRevision: null, scopes: [],
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
            status: 'connected', authenticationModeId: null, configurationReady: true, configurationRevision: null,
            kind: 'oauth', expiresAt: null, lastUsedAt: null, providerIdentity: {}, displayName: 'work',
        }];
        const purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } },
        }] };
        await prepareAccountFixture();
        const scope = storage.getState().profileScope;
        if (!scope) throw new Error('Expected the restored destination Account scope');
        if (!purposeBoundary) throw new Error('Expected the destination purpose HTTP boundary');
        purposeBoundary.replace(purposeBindings);
        await purposeBoundary.hydrate(scope);
        const { tree, update } = await renderScreen(<ConnectedServicesAgentSignInView />);
        await vi.waitFor(() => expect(tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex')?.props.disabled).toBe(false));
        const row = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        expect(row).toBeTruthy();
        const selectedDetail = row?.props.detail;
        await act(async () => row?.props.onPress());
        // The native Modal boundary supplies the dynamically selected React component and props.
        const config = modalShowSpy.mock.calls[0]?.[0] as Readonly<{
            component: React.ComponentType<Record<string, unknown>>;
            props: Record<string, unknown>;
        }> | undefined;
        if (!config) throw new Error('Expected the default-auth picker');
        const Content = config.component;
        const picker = (await renderUiScreen(<Content {...config.props} onClose={() => {}} />, {
            wrapper: ConnectedServicesTestProviders,
        })).tree;
        expect(picker.root.findByProps({ testID: 'new-session.connected-services.selection-list' }).props.selectedOptionId)
            .toBe('connected-service:happier.agent.codex%2Fopenai-codex:profile:work');
        await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'partial', authority: 'active', revision: 4,
            record: { key: 'purposes', value: purposeBindings },
            diagnostics: [{ path: 'bindings[1]', reason: 'invalid-stored-content' }],
        }, true));
        const safeRow = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        expect(safeRow?.props.detail).toBe(selectedDetail);
        expect(safeRow?.props.disabled).toBe(true);
        await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'partial', authority: 'inactive', revision: 'absent',
            record: { key: 'purposes', value: { v: 1, bindings: [] } },
            diagnostics: [{ path: 'bindings[0]', reason: 'invalid-stored-content' }],
        }, true));
        const { t } = await import('@/text');
        const unreadRow = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        expect(unreadRow?.props.detail).toBe(t('common.unavailable'));
        expect(unreadRow?.props.disabled).toBe(true);
        await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'unavailable', reason: 'account-mode-mismatch',
        }, true));
        const unavailableRow = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        expect(unavailableRow?.props.detail).toBe(t('common.unavailable'));
        expect(unavailableRow?.props.disabled).toBe(true);
        expect(modalHideSpy).toHaveBeenCalledWith('screen-default-modal');
        await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'ready', revision: 5, record: { key: 'purposes', value: purposeBindings },
        }, true));
        const restoredRow = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        await act(async () => restoredRow?.props.onPress());
        modalHideSpy.mockClear();
        profileState.activeAccountScope = { serverId: 'server-2', accountId: 'other-account' };
        profileState.connectedAccountsV4 = [];
        await update(<ConnectedServicesAgentSignInView key="other-home" />);
        // The destination's freshly loaded empty catalog is writable; only the
        // retiring Account's selection and pending modal must be withdrawn.
        await vi.waitFor(() => expect(tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex')?.props.disabled).toBe(false));
        const otherHomeRow = tree.findAllByType(Item)
            .find(candidate => candidate.props.testID === 'settings-connected-services-default-auth-codex');
        expect(otherHomeRow?.props.detail).not.toBe(selectedDetail);
        expect(modalHideSpy).toHaveBeenCalledWith('screen-default-modal');
    });

    it('marks the destination Account default in the collection with the retired Settings root absent', async () => {
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'collection-destination-account' };
        serverFeaturesState.qualifiedAccounts = { protocolVersion: 4 };
        profileState.connectedAccountsV4 = [{
            revisionSemantics: 'legacy_unfenced',
            credentialRevision: null, scopes: [],
            ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
            status: 'connected', authenticationModeId: null, configurationReady: true, configurationRevision: null,
            kind: 'oauth', expiresAt: null, lastUsedAt: null, providerIdentity: {}, displayName: 'work',
        }];
        await prepareAccountFixture();
        const scope = storage.getState().profileScope;
        if (!scope) throw new Error('Expected the restored destination Account scope');
        if (!purposeBoundary) throw new Error('Expected the destination purpose HTTP boundary');
        purposeBoundary.replace({ v: 1, bindings: [{
                purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
                target: { kind: 'account', account: profileState.connectedAccountsV4[0]!.ref },
            }] });
        await purposeBoundary.hydrate(scope);
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        // The default menu is on cards (and the account); a list row keeps one trailing thing (crHome A).
        await screen.pressByTestIdAsync('connected-services-index.view:grid');
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work:star')?.props.accessibilityLabel)
            .toBe(t('connectedServicesPool.defaultFor', { agent: 'Codex' })));
        await act(async () => applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
            status: 'unavailable', reason: 'account-mode-mismatch',
        }, true));
        const unavailableControl = screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work:star');
        expect(unavailableControl?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(unavailableControl?.props.accessibilityLabel).toBe('connectedServicesPool.makeDefaultA11y');
        expect(unavailableControl?.props.accessibilityHint).toBe('common.unavailable');
        // The view is a device preference: put List back for the cases after this one.
        storage.getState().applyLocalSettings({ connectedServicesIndexViewV1: 'list' });
    });

    it('renders default-auth rows from the live qualified external Agent projection', async () => {
        daemonAgentProjectionState.mergedProviderProjectionById['acme.agent/native'] = {
            agentId: 'acme.agent/native',
            qualifiedId: 'acme.agent/native',
            identity: { pluginId: 'acme.agent', localId: 'native' },
            title: 'Acme Native',
            isBuiltIn: false,
            connectedAccounts: [{
                purpose: 'primary',
                service: { pluginId: 'acme.agent', localId: 'account' },
                required: false,
            }],
        };
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const row = tree.findAllByType(ConnectedServicesDefaultAuthRow)
            .find((candidate) => candidate.props.agentId === 'acme.agent/native');

        expect(row?.props.agentTitle).toBe('Acme Native');
        expect(row?.props.connectedAccountServiceKeys).toEqual(['acme.agent/account']);
    });

    it('threads the current Team resource catalog into the sole default-auth row', async () => {
        const resource = {
            id: 'resource-1',
            teamId: 'team-1',
            displayName: 'Shared Codex',
            resourceRevision: 3,
            readiness: { kind: 'available' },
            recoveryAction: null,
            mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
            sessionUsePolicy: 'personal_allowed', providerModels: [],
            connectedServiceSelections: [{
                source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered',
            }],
            sourcePresentation: {
                kind: 'connected_service',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            },
        };
        profileState.activeAccountScope = { serverId: 'server-1', accountId: 'account-1' };
        profileState.teamCredentialCatalog = {
            resources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            homeNameByTeamId: { 'team-1': 'Home A' },
            resourceStatusByKey: new Map([['team-1:resource-1', { kind: 'current' as const }]]),
            current: true,
            condition: null,
        };
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const row = tree.findAllByType(ConnectedServicesDefaultAuthRow)
            .find((candidate) => candidate.props.agentId === 'codex');

        expect(row?.props).toMatchObject({
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
        });
        expect(row?.props.teamCredentialResourceStatusByKey).toEqual(new Map([['team-1:resource-1', { kind: 'current' as const }]]));
    });

    it('lets search reach the per-agent default sign-in rows through the first of them', async () => {
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const { CONNECTED_SERVICES_SETTINGS } = await import('./connectedServicesSettings');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const rows = tree.findAllByType(ConnectedServicesDefaultAuthRow);

        expect(rows[0]?.props.setting?.anchor).toBe(CONNECTED_SERVICES_SETTINGS.settings.agentDefaults.anchor);
        expect(rows.slice(1).every((row) => row.props.setting === undefined)).toBe(true);
    });

    it('preserves the released bundled Agent routing id as the default-auth settings key', async () => {
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');

        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;
        const agentIds = tree.findAllByType(ConnectedServicesDefaultAuthRow)
            .map((candidate) => candidate.props.agentId);

        expect(agentIds).toContain('codex');
        expect(agentIds).not.toContain('happier.agent.codex/codex');
    });

    it('does not route a default-auth connect action without an executable projected service owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        await tree
            .findAllByType(ConnectedServicesDefaultAuthRow)[0]
            .props.onOpenConnectedServicesSettings('not-a-released-service');

        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'errors.daemonUnavailableTitle',
            'errors.daemonUnavailableBody',
        );
    });

    it('opens default-auth Connect through its exact projected qualified owner', async () => {
        connectedServiceRegistryState.entries = [{
            serviceId: 'openai-codex',
            service: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
            },
            legacyServiceId: 'openai-codex',
            connectCommand: 'happier connect openai-codex',
            supportsOauth: true,
            executable: true,
        }];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        const opening = tree.findAllByType(ConnectedServicesDefaultAuthRow)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }),
        }) }));
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        await act(async () => modalShowSpy.mock.calls.at(-1)?.[0].onRequestClose?.());
        await opening;
    });

    it.each(['rail', 'agent', 'pool'] as const)('settles a successful %s Connect in Credentials and dismisses without changing defaults or membership', async surface => {
        const { ConnectedServicesRail, ConnectedServicesRailView } = await import('./collection/ConnectedServicesRail');
        const { QualifiedPoolDetail } = await import('./pools/QualifiedPoolDetail');
        const { QualifiedPoolDetailView } = await import('./pools/QualifiedPoolDetailView');
        const { ConnectedAccountSettled } = await import('./setup/ConnectedAccountSettled');
        const { ConnectedServiceAuthGroupPolicyV2Schema } = await import('@happier-dev/protocol/connect/connected-service-schemas');
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const connected = { service, accountId: 'new-account-before-inventory' };
        const mutations = { mutating: false, patch: vi.fn(), patchMember: vi.fn(), addMember: vi.fn(),
            removeMember: vi.fn(), setActiveAccount: vi.fn(), delete: vi.fn() };
        const screen = await renderScreen(surface === 'rail' ? <ConnectedServicesRail />
            : surface === 'agent' ? <ConnectedServicesAgentSignInView />
            : <><ConnectedServicesAgentSignInView /><QualifiedPoolDetail serviceLabel="Codex" accounts={[]} mutations={mutations} group={{
                ref: { service, groupId: 'primary' }, displayName: 'Work pool',
                policy: ConnectedServiceAuthGroupPolicyV2Schema.parse({}), activeAccountId: null,
                revision: { protocol: 'v4', incarnation: 'pool-fixture', generation: 1, runtimeStateRevision: 1 },
                state: { status: 'ready' }, members: [],
            }} /></>);
        expect(screen.tree.findAllByType(ConnectedAccountSettled)).toHaveLength(0);
        const open = () => surface === 'rail'
            ? screen.tree.findByType(ConnectedServicesRailView).props.onAddAccount(screen.tree.findByType(ConnectedServicesRailView).props.model.sheets[0])
            : surface === 'agent'
                ? screen.tree.findAllByType(ConnectedServicesDefaultAuthRow)[0].props.onOpenConnectedServicesSettings('openai-codex')
                : screen.tree.findByType(QualifiedPoolDetailView).props.onConnectAccount();
        let pending: unknown;
        await act(async () => { pending = open(); });
        await act(async () => { modalShowSpy.mock.calls.at(-1)![0].onRequestClose?.(); });
        await pending;
        expect(screen.tree.findAllByType(ConnectedAccountSettled)).toHaveLength(0);
        await act(async () => { pending = open(); });
        const before = purposeBoundary?.writes.length ?? 0;
        await act(async () => { modalShowSpy.mock.calls.at(-1)![0].props?.onResult({ kind: 'connected', account: connected, includesApiKey: true }); });
        await pending;
        const settlement = screen.tree.findAllByType(ConnectedAccountSettled);
        expect(settlement).toHaveLength(1);
        expect(settlement[0].props.account).toEqual(connected);
        expect(screen.findHostByTestId('connected-services-settle:included-api-key')).not.toBeNull();
        await act(async () => { settlement[0].props.onDismiss(); });
        expect(screen.tree.findAllByType(ConnectedAccountSettled)).toHaveLength(0);
        expect(mutations.addMember).not.toHaveBeenCalled();
        expect(purposeBoundary?.writes.length ?? 0).toBe(before);
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    });

    it('opens released legacy Connect through its generated exact identity', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [];
        const { ConnectedServicesAgentSignInView } = await import('./collection/ConnectedServicesAgentSignInView');
        const tree = (await renderScreen(<ConnectedServicesAgentSignInView />)).tree;

        const opening = tree.findAllByType(ConnectedServicesDefaultAuthRow)[0]
            .props.onOpenConnectedServicesSettings('openai-codex');
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(modalShowSpy).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            request: expect.objectContaining({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }),
        }) }));
        expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
        await act(async () => modalShowSpy.mock.calls.at(-1)?.[0].onRequestClose?.());
        await opening;
    });

    it('renders a released V2 profile through the generated adapter without making a scalar row owner', async () => {
        connectedServiceRegistryState.entries = [];
        profileState.connectedServicesV2 = [{
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
        }];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;
        const rows = tree.root.findAll((node) => node.props.facts && node.props.accountId);
        expect(rows.map((row) => row.props.accountId)).toEqual(['work']);
        await tree.pressByTestIdAsync('connected-services-account:happier.agent.codex/openai-codex:work');
        expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'work',
            },
        });
    });

    it('keeps built-in and projected Connected Accounts available when the retired master feature is disabled', async () => {
        // A novel descriptor has no scalar compatibility authority. It is
        // visible once the server advertises the qualified V4 contract, while
        // the built-in row remains available through its generated adapter.
        serverFeaturesState.qualifiedAccounts = { protocolVersion: 4 };
        profileState.connectedServicesV2 = [];
        connectedServiceRegistryState.entries = [
            {
                serviceId: 'openai-codex',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                legacyServiceId: 'openai-codex',
                connectCommand: 'happier connect codex',
                supportsOauth: true,
                executable: true,
                displayNameKey: 'connectedServices.names.openaiCodex',
            },
            {
                serviceId: 'vault',
                service: { pluginId: 'acme.connected-accounts-conformance', localId: 'vault' },
                connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
                supportsOauth: true,
                executable: true,
                projectedDescriptor: { id: 'vault' },
                projectedTitle: 'Acme Vault',
            },
        ];

        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
        const screen = await renderScreen(<ConnectedServicesSettingsView />);
        const panel = screen.tree.root.findByType(ConnectedServicesConnectMore);

        // Both the built-in service and the novel qualified descriptor can be added from the catalog,
        // each by its exact qualified identity (never a scalar id).
        expect(ConnectedServiceIdSchema.safeParse('vault').success).toBe(false);
        expect(panel.props.model.connectable.map((entry: { serviceKey: string }) => entry.serviceKey))
            .toEqual(expect.arrayContaining([
                'acme.connected-accounts-conformance/vault',
                'happier.agent.codex/openai-codex',
            ]));
    });

    it('lists every account of a released legacy service, the one needing a new sign-in first', async () => {
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [
                    { profileId: 'connected', status: 'connected', kind: 'oauth' },
                    { profileId: 'retryable', status: 'refresh_failed_retryable', kind: 'oauth' },
                    { profileId: 'reauth', status: 'needs_reauth', kind: 'oauth' },
                ],
            },
        ];
        const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

        const tree = (await renderScreen(React.createElement(ConnectedServicesSettingsView))).tree;

        const rows = tree.root.findAll((node) => node.props.facts && node.props.accountId);
        // Needs you leads; the remaining accounts use the model's stable identity order.
        expect(rows.map((row) => row.props.accountId)).toEqual(['reauth', 'connected', 'retryable']);
        // The fix sits on the account that needs it, not in the service's header.
        expect(rows.map((row) => row.props.signedOut !== null)).toEqual([true, false, false]);
    });
});
