import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createSessionFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { act } from 'react-test-renderer';
import { FeaturesResponseSchema, PluginProjectionV2Schema, QualifiedConnectedAccountProfileV4Schema, type MachineAgentInventoryItem } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { advanceConnectedAccountDescriptorProjectionState, createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { storage } from '@/sync/domains/state/storageStore';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerId, removeServerProfile, resolveServerProfileScopeIdForIdentifier, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { buildMachineAgentsDetectRequest } from '@happier-dev/protocol/capabilities';
import { profileParse, type Profile } from '@/sync/domains/profiles/profile';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { loadEffectiveHomeViewState, updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import * as sessionListQueryRuntime from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    profile: {} as Partial<Profile>,
    loginState: 'logged_in' as 'logged_in' | 'logged_out',
    push: null as ((route: unknown) => void) | null,
    pluginCapabilities: null as ReturnType<typeof pluginsAnswer> | null,
    unavailableServerIds: [] as string[],
    serverId: '',
    homeUrl: '',
}));
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc);
});

const SERVICE = { pluginId: 'happier.example', localId: 'subscription' } as const;
const SERVICE_DESCRIPTOR = ConnectedAccountUiProjectionEntryV1Schema.parse({
    id: SERVICE.localId, pluginId: SERVICE.pluginId, serviceId: 'example-subscription',
    provenance: 'external', sourceKind: 'plugin', title: 'Example subscription',
    authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }] },
    capabilities: [], availability: { state: 'available', reason: 'enabled' }, diagnostics: [],
});

// Collect the real UI closure before a case starts its observable interaction deadline.
const { HubAttentionSection, SettingsAttentionSection } = await import('./HubAttentionSection');

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: (route: unknown) => state.push?.(route) } }).module;
});

// Device credential storage is a genuine boundary; Account binding and feature decisions are real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: async () => ({ token: 'e30.eyJzdWIiOiJhdHRlbnRpb24tYWNjb3VudCJ9.signature' }),
    } });
});

function pluginsAnswer(pendingChanges: unknown[]) {
    return { protocolVersion: 1, results: { 'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [], pendingChanges } } } };
}

function agentFacts(): MachineAgentInventoryItem {
    return { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1',
        update: { supported: false, command: null }, signIn: { status: state.loginState === 'logged_out' ? 'signedOut' : 'signedIn', loginSupport: 'status_only' },
        platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
}

const initialStorageState = storage.getState();
const initialServerId = getActiveServerId();
const initialHomeView = loadEffectiveHomeViewState();
let caseNumber = 0;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let studioId: string | undefined;
beforeEach(async () => {
    // Match app-entry bootstrap before the real Home connection performs synchronous hydration.
    await loadSyncSingletonForTests();
    state.homeUrl = `https://attention-${++caseNumber}.example.test`;
    rpc.mockReset();
    rpc.mockImplementation(async (request: { method: string }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { claude: { id: 'claude', title: 'Claude',
                providerOwnedEnvironmentKeys: [], capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } }) };
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'cli.claude': { ok: true, checkedAt: Date.now(), data: agentFacts() },
            ...state.pluginCapabilities?.results,
        } };
        throw new Error(`Unexpected Home attention RPC: ${request.method}`);
    });
});
afterEach(async () => {
    standardCleanup();
    clearMachineRequestReachabilityForTest();
    await connection?.dispose();
    connection = undefined;
    if (initialServerId) await setActiveServerId(initialServerId);
    if (state.serverId) await removeServerProfile(state.serverId);
    if (studioId) await removeServerProfile(studioId);
    studioId = undefined;
    clearDaemonMergedProjectionCacheForTests();
    state.unavailableServerIds = [];
    state.pluginCapabilities = null;
    state.push = null;
    if (initialHomeView) await updateEffectiveHomeViewState(() => initialHomeView, { scope: 'device' });
    storage.setState(initialStorageState, true);
    vi.restoreAllMocks();
});

function account(accountId: string, status: 'connected' | 'needs_reauth' | 'refresh_failed_retryable' | 'refreshing') {
    return QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: SERVICE, accountId }, status,
        authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationRevision: null, configurationReady: true, scopes: [] });
}

async function renderSection(Section: React.ComponentType = HubAttentionSection) {
    await upsertServerProfile({ serverUrl: state.homeUrl });
    const declaredHome = await setServerProfileIdentityForUrl(state.homeUrl, `srv_attention_${caseNumber}`);
    if (!declaredHome) throw new Error('The attention fixture Home must exist');
    const profile = profileParse({ ...initialStorageState.profile, ...state.profile, id: 'attention-account' });
    const artifact = createHomeHubArtifactHttpBoundary('attention-account', profile);
    const baseFeatures = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...baseFeatures,
        capabilities: { ...baseFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } });
    connection = await restoreServerAccountForTest({ serverUrl: state.homeUrl, serverIdentityId: declaredHome.serverIdentityId!, accountId: 'attention-account', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        return path === '/v1/features' || path === '/v1/features/authenticated' ? Promise.resolve(Response.json(features)) : artifact.request(url, init);
    } });
    const home = connection.home;
    state.serverId = home.id;
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'attention-account' };
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now(), daemonStateVersion: 3,
        metadata: { ...createMachineFixture().metadata!, displayName: 'MacBook Pro' } });
    const target = { serverIdentityId: home.serverIdentityId!, machineId: machine.id };
    const seedAttentionState = () => storage.setState({ isDataReady: true, profile, profileScope: scope, settingsScope: scope,
        settings: { ...initialStorageState.settings, machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents]: target, [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins]: target } },
        machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
    seedAttentionState();
    if (state.unavailableServerIds.length > 0) {
        storage.setState({ machineListStatusByServerId: {
            ...storage.getState().machineListStatusByServerId,
            ...Object.fromEntries(state.unavailableServerIds.map(serverId => [serverId, 'error' as const])),
        } });
        await updateEffectiveHomeViewState(current => ({ ...current,
            groups: [{ id: 'attention-homes', name: 'Selected Homes', serverIds: [home.id, ...state.unavailableServerIds] }],
            activeTargetKind: 'group', activeTargetId: 'attention-homes',
        }), { scope: 'device' });
    }
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
    const push = vi.fn();
    state.push = push;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('The attention fixture Account must be restored');
    installConnectedAccountDescriptorProjection(advanceConnectedAccountDescriptorProjectionState(
        createConnectedAccountDescriptorProjectionLoadingState(JSON.stringify([scope.serverId, scope.accountId])),
        { kind: 'ready', descriptors: [SERVICE_DESCRIPTOR], conflicts: [] },
    ), lifetime);
    await loadDaemonMergedProjectionInputs({ machineId: machine.id, serverId: home.id, accountLifetime: lifetime });
    const revision = getMachineContributionRegistryProjectionRevision({ machineId: machine.id, serverId: home.id });
    // These are the prior Agents/Plugins page observations beneath their real codec/cache owners.
    await prefetchMachineCapabilities({ machineId: machine.id, serverId: lifetime.scope.serverId, accountLifetime: lifetime,
        cacheKeySalt: serverAccountScopedResourceKey(lifetime.scope, 'machine-agents-capabilities', String(revision)),
        request: buildMachineAgentsDetectRequest({ agents: [{ agentId: 'claude', title: 'Claude' }] }),
    });
    if (state.pluginCapabilities) await prefetchMachineCapabilities({ machineId: machine.id, serverId: home.id,
        cacheKeySalt: '3:1', request: { requests: [{ id: 'tool.plugins' }] },
    });
    // Connection bootstrap is asynchronous; install the case's current projection after its reads.
    seedAttentionState();
    if (state.unavailableServerIds.length > 0) storage.setState({ machineListStatusByServerId: {
        ...storage.getState().machineListStatusByServerId,
        ...Object.fromEntries(state.unavailableServerIds.map(serverId => [serverId, 'error' as const])),
    } });
    expect(lifetime.scope).toEqual(scope);
    expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope: lifetime.scope }))
        .toMatchObject({ machine: { id: machine.id }, serverId: home.id });
    rpc.mockClear();
    const screen = await renderScreen(<Section />);
    await flushHookEffects({ cycles: 3 });
    if (state.loginState === 'logged_out') await vi.waitFor(() =>
        expect(screen.findByTestId('settings-overview-attention.agent:claude.action')).not.toBeNull());
    // Reading Home's attention is cache-only: neither the catalog nor the inventory may probe.
    expect(rpc).not.toHaveBeenCalled();
    const actions = screen.findAll((node) => typeof node.props?.testID === 'string'
        && node.props.testID.endsWith('.action')
        && typeof node.props.onPress === 'function');
    return { screen, push, actions };
}

describe('HubAttentionSection', () => {
    it('does not serialize sign-in facts on health arrivals and still shows a new sign-in need', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-ok', 'connected')] };
        const { screen } = await renderSection();
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            for (const status of ['refresh_failed_retryable', 'connected', 'refreshing'] as const) {
                await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile,
                    connectedAccountsV4: [account('acct-ok', status)] }); });
            }
            const signInSerializations = stringify.mock.calls.filter(([value]) => value && typeof value === 'object'
                && Object.keys(value).length === 2 && 'connectedAccountsV4' in value && 'connectedServicesV2' in value);
            expect(signInSerializations).toHaveLength(0);
            expect(screen.getTextContent()).toBe('');
            await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile,
                connectedAccountsV4: [account('acct-ok', 'needs_reauth')] }); });
            expect(screen.findByTestId('settings-overview-attention.service:happier.example/subscription/acct-ok.action')).not.toBeNull();
        } finally { stringify.mockRestore(); await screen.unmount(); }
    });
    it.each([['Home', HubAttentionSection], ['Settings', SettingsAttentionSection]] as const)('keeps %s reconnect in place when its selected Agents machine has unknown presence', async (_name, Section) => {
        state.loginState = 'logged_out';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-1', 'needs_reauth')] };
        const { screen, push } = await renderSection(Section);
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('The attention fixture Account must be restored');

        await act(async () => { withdrawMachinePresenceForScope(scope); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAll(node => node.props?.testID === 'settings-overview-attention.agent:claude.action'))
            .toHaveLength(0);
        const serviceAction = screen.findByTestId('settings-overview-attention.service:happier.example/subscription/acct-1.action');
        expect(serviceAction).not.toBeNull();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        const trigger = { getBoundingClientRect: () => ({ x: 10, y: 20, width: 120, height: 40 }) };
        await act(async () => { serviceAction!.props.onPress({ currentTarget: trigger }); });
        expect(Modal.show).toHaveBeenCalledTimes(1);
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'connect-sheet' }),
            props: expect.objectContaining({ request: expect.objectContaining({
                intent: 'reconnect', service: SERVICE, account: { service: SERVICE, accountId: 'acct-1' },
                anchor: expect.objectContaining({ kind: 'view', ref: { current: trigger } }),
            }) }),
        }));
        expect(push).not.toHaveBeenCalled();

        await act(async () => { captureMachinePresenceObservation(scope)(['machine-1']); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('settings-overview-attention.agent:claude.action')).not.toBeNull();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('offers the same pending Sessions as the Home count and opens their Inbox', async () => {
        state.loginState = 'logged_in';
        state.profile = {};
        const { screen, push } = await renderSection();
        const now = Date.now();
        const session = createSessionFixture({ id: 'pending-session', serverId: state.serverId,
            viewer: undefined, active: true, presence: 'online', activeAt: now, updatedAt: now,
            agentState: { requests: { approval: { tool: 'Bash', arguments: {}, createdAt: now } }, completedRequests: {} },
        });
        await act(async () => {
            storage.setState({ sessions: { [session.id]: session },
                sessionListRowsByServerId: { [state.serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
                ordinarySessionListMembershipByServerId: { [state.serverId]: [session.id] } });
        });
        await flushHookEffects({ cycles: 2 });
        const action = screen.findAll((node) => node.props?.testID === 'settings-overview-attention.sessions.action'
            && typeof node.props.onPress === 'function')[0];
        expect(action).toBeDefined();
        action!.props.onPress();
        expect(push).toHaveBeenCalledWith('/inbox');
        await act(async () => { storage.setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} }); });
        expect(screen.findAll((node) => node.props?.testID === 'settings-overview-attention.sessions.action')).toHaveLength(0);
    });
    it('lists a signed-out agent and an expired account, each with the action that fixes it', async () => {
        state.loginState = 'logged_out';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-ok', 'connected'), account('acct-1', 'needs_reauth')] };
        const { screen, push, actions } = await renderSection();

        expect(screen.getTextContent()).toContain('MacBook Pro');
        expect(screen.getTextContent()).toContain('Example subscription');
        const testIDs = [...new Set(actions.map((node) => node.props.testID as string))];
        expect(testIDs).toEqual([
            'settings-overview-attention.agent:claude.action',
            'settings-overview-attention.service:happier.example/subscription/acct-1.action',
        ]);

        actions.find((node) => node.props.testID === testIDs[0])!.props.onPress();
        actions.find((node) => node.props.testID === testIDs[1])!.props.onPress();
        expect(push).toHaveBeenCalledExactlyOnceWith('/(app)/settings/agents/claude');
    });

    it('names the expired account a row is about', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [
            { ...account('acct-1', 'needs_reauth'), displayName: 'Work' },
            { ...account('acct-2', 'needs_reauth'), displayName: 'Side project' },
        ] };
        const { screen } = await renderSection();
        expect(screen.getTextContent()).toContain('Work');
        expect(screen.getTextContent()).toContain('Side project');
    });

    it('in Settings keeps what Settings repairs and leaves Sessions to Home and the Inbox', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-1', 'needs_reauth')] };
        const { screen } = await renderSection(SettingsAttentionSection);
        const now = Date.now();
        const session = createSessionFixture({ id: 'pending-session', serverId: state.serverId,
            viewer: undefined, active: true, presence: 'online', activeAt: now, updatedAt: now,
            agentState: { requests: { approval: { tool: 'Bash', arguments: {}, createdAt: now } }, completedRequests: {} },
        });
        await act(async () => {
            storage.setState({ sessions: { [session.id]: session },
                sessionListRowsByServerId: { [state.serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
                ordinarySessionListMembershipByServerId: { [state.serverId]: [session.id] } });
        });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findAll((node) => node.props?.testID === 'settings-overview-attention.sessions.action')).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.testID === 'settings-overview-attention.machines.action')).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.testID === 'settings-overview-attention.service:happier.example/subscription/acct-1.action').length).toBeGreaterThan(0);
    });

    it('is absent when nothing needs the person', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-ok', 'connected')] };
        const { screen } = await renderSection();

        expect(screen.getTextContent()).toBe('');
    });

    it('leaves plugin trust reviews with the canonical approval Inbox instead of duplicating daemon review facts', async () => {
        const { createPluginInstallationReviewFixture } = await import('@happier-dev/protocol/testing/pluginInstallationReviewFixture');
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [] };
        state.pluginCapabilities = pluginsAnswer([
            { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'p-1', review: createPluginInstallationReviewFixture() },
            { kind: 'applying', pendingChangeId: 'p-2' },
        ]);
        const { screen, actions } = await renderSection();
        expect(screen.findByTestId('settings-overview-attention.plugins:awaitingReview.action')).toBeNull();
        expect(actions).toEqual([]);
        state.pluginCapabilities = null;
    });

    it('says which other Home is not answering, with Retry, instead of the home waiting on it', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [] };
        const studio = await upsertServerProfile({ serverUrl: 'https://studio.example', name: 'Studio' });
        studioId = studio.id;
        state.unavailableServerIds = [studio.id];
        // Observe the real refresh owner; its behavior and return value are unchanged.
        const refreshed = vi.spyOn(sessionListQueryRuntime, 'refreshOrdinarySessionList');
        const { screen, actions } = await renderSection();

        expect(screen.getTextContent()).toContain('Studio');
        const retry = actions.find((node) => node.props.testID === `settings-overview-attention.home:${studio.id}.action`);
        expect(retry).toBeTruthy();
        await retry!.props.onPress();
        expect(refreshed).toHaveBeenCalledWith(studio.id);
    });
});
