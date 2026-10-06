import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, createRootLayoutFeaturesResponse, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { FeaturesResponseSchema, PluginProjectionV2Schema, QualifiedConnectedAccountProfileV4Schema, type MachineAgentInventoryItem } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storage } from '@/sync/domains/state/storageStore';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerId, removeServerProfile, resolveServerProfileScopeIdForIdentifier, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { machineAgentInventoryStore, EMPTY_MACHINE_AGENTS } from '@/agents/machineAgents/machineAgentInventoryStore';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { profileParse, type Profile } from '@/sync/domains/profiles/profile';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    profile: {} as Partial<Profile>,
    loginState: 'logged_in' as 'logged_in' | 'logged_out',
    push: null as ((route: unknown) => void) | null,
    pluginCapabilities: null as unknown,
    unavailableServerIds: [] as string[],
    retried: [] as string[],
    serverId: '',
    homeUrl: '',
}));
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc);
});

const SERVICE = { pluginId: 'happier.example', localId: 'subscription' } as const;
const SERVICE_ENTRY = {
    serviceId: 'example-subscription',
    service: SERVICE,
    connectCommand: 'happier connect example-subscription',
    supportsOauth: true,
    projectedTitle: 'Example subscription',
} as unknown as ConnectedServiceRegistryEntry;

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

// Plugin-contributed service descriptors arrive through the app-shell projection.
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => {
    const registry = { status: 'ready', entries: [SERVICE_ENTRY] };
    const localize = (_pluginId: string, value: unknown) => (typeof value === 'string' ? value : null);
    return { useProjectedConnectedServicesRegistry: () => registry, useProjectedPluginLocalizedTextResolver: () => localize };
});

vi.mock('@/agents/presentation/AgentCatalogIdentityIcon', () => ({
    AgentCatalogIdentityIcon: () => null,
}));

// The getting-started model owner decides which selected Homes are not answering (tested at its owner).
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => ({ kind: 'create_session', unavailableServerIds: state.unavailableServerIds }),
}));
// The other Home's refresh (its transport boundary).
vi.mock('@/sync/domains/session/listing/sessionListQueryRuntime', () => ({
    refreshOrdinarySessionList: async (serverId: string) => { state.retried.push(serverId); },
}));

function pluginsAnswer(pendingChanges: unknown[]) {
    return { protocolVersion: 1, results: { 'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [], pendingChanges } } } };
}

const initialStorageState = storage.getState();
const initialServerId = getActiveServerId();
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
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT && state.pluginCapabilities) return state.pluginCapabilities;
        throw new Error(`Unexpected Home attention RPC: ${request.method}`);
    });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await setActiveServerId(initialServerId);
    if (state.serverId) await removeServerProfile(state.serverId);
    if (studioId) await removeServerProfile(studioId);
    studioId = undefined;
    clearDaemonMergedProjectionCacheForTests();
    state.unavailableServerIds = [];
    state.retried = [];
    state.pluginCapabilities = null;
    state.push = null;
    storage.setState(initialStorageState, true);
});

function account(accountId: string, status: 'connected' | 'needs_reauth') {
    return QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: SERVICE, accountId }, status,
        authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
        configurationRevision: null, configurationReady: true, scopes: [] });
}

async function renderSection() {
    await upsertServerProfile({ serverUrl: state.homeUrl });
    const home = await setServerProfileIdentityForUrl(state.homeUrl, `srv_attention_${caseNumber}`);
    if (!home) throw new Error('The attention fixture Home must exist');
    state.serverId = home.id;
    const artifact = createHomeHubArtifactHttpBoundary('attention-account');
    const baseFeatures = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...baseFeatures,
        capabilities: { ...baseFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } });
    connection = await restoreServerAccountForTest({ serverUrl: state.homeUrl, accountId: 'attention-account', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        return path === '/v1/features' || path === '/v1/features/authenticated' ? Promise.resolve(Response.json(features)) : artifact.request(url, init);
    } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home.id), accountId: 'attention-account' };
    const machine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now(), daemonStateVersion: 3,
        metadata: { ...createMachineFixture().metadata!, displayName: 'MacBook Pro' } });
    const target = { serverIdentityId: home.serverIdentityId!, machineId: machine.id };
    storage.setState({ isDataReady: true, profile: profileParse({ ...initialStorageState.profile, ...state.profile, id: scope.accountId }), profileScope: scope, settingsScope: scope,
        settings: { ...initialStorageState.settings, machineAdministrationTargetsLocalV1: {
            [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents]: target, [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins]: target } },
        machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
    const push = vi.fn();
    state.push = push;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('The attention fixture Account must be restored');
    await loadDaemonMergedProjectionInputs({ machineId: machine.id, serverId: home.id, accountLifetime: lifetime });
    rpc.mockClear();
    const { HubAttentionSection } = await import('./HubAttentionSection');
    const screen = await renderScreen(<HubAttentionSection />);
    await flushHookEffects({ cycles: 3 });
    const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
    // Home summarizes the inventory's cached answer; it must not launch a CLI sign-in probe.
    // Publish the prior machine observation through its real owner once credential binding settles.
    await vi.waitFor(() => expect(machineAgentInventoryStore.read(key)).not.toBe(EMPTY_MACHINE_AGENTS));
    const item: MachineAgentInventoryItem = { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1',
        update: { supported: false, command: null }, signIn: { status: state.loginState === 'logged_out' ? 'signedOut' : 'signedIn', loginSupport: 'status_only' },
        platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
    await act(async () => { machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 1 }); });
    // Reading Home's attention is cache-only: neither the catalog nor the inventory may probe.
    expect(rpc).not.toHaveBeenCalled();
    const actions = screen.findAll((node) => typeof node.props?.testID === 'string'
        && node.props.testID.endsWith('.action')
        && typeof node.props.onPress === 'function');
    return { screen, push, actions };
}

describe('HubAttentionSection', () => {
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
        expect(push).toHaveBeenNthCalledWith(1, '/(app)/settings/agents/claude');
        expect(push).toHaveBeenNthCalledWith(2, expect.objectContaining({
            params: expect.objectContaining({ pluginId: SERVICE.pluginId, localId: SERVICE.localId, accountId: 'acct-1' }),
        }));
    });

    it('is absent when nothing needs the person', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [account('acct-ok', 'connected')] };
        const { screen } = await renderSection();

        expect(screen.getTextContent()).toBe('');
    });

    it('asks for a review when the Plugins machine last reported changes awaiting a decision', async () => {
        const { createPluginInstallationReviewFixture } = await import('@happier-dev/protocol/testing/pluginInstallationReviewFixture');
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [] };
        state.pluginCapabilities = pluginsAnswer([
            { kind: 'reviewRequired', reviewKind: 'installation', reason: 'firstInstall', currentVersion: null, authorityExpansion: [], pendingChangeId: 'p-1', review: createPluginInstallationReviewFixture() },
            { kind: 'applying', pendingChangeId: 'p-2' },
        ]);
        // The Plugins page asked after a transport reconnect (its second freshness generation).
        const { prefetchMachineCapabilities } = await import('@/hooks/server/useMachineCapabilitiesCache');
        await prefetchMachineCapabilities({
            machineId: 'machine-1', serverId: (await upsertServerProfile({ serverUrl: state.homeUrl })).id, cacheKeySalt: '3:1',
            request: { requests: [{ id: 'tool.plugins' }] } as never, timeoutMs: 1000,
        });
        const { push, actions } = await renderSection();

        const review = actions.find((node) => node.props.testID === 'settings-overview-attention.plugins:awaitingReview.action');
        expect(review).toBeTruthy();
        review!.props.onPress();
        expect(push).toHaveBeenCalledWith('/settings/plugins');
        state.pluginCapabilities = null;
    });

    it('says which other Home is not answering, with Retry, instead of the home waiting on it', async () => {
        state.loginState = 'logged_in';
        state.profile = { connectedServicesV2: [], connectedAccountsV4: [] };
        const studio = await upsertServerProfile({ serverUrl: 'https://studio.example', name: 'Studio' });
        studioId = studio.id;
        state.unavailableServerIds = [studio.id];
        const { screen, actions } = await renderSection();

        expect(screen.getTextContent()).toContain('Studio');
        const retry = actions.find((node) => node.props.testID === `settings-overview-attention.home:${studio.id}.action`);
        expect(retry).toBeTruthy();
        await retry!.props.onPress();
        expect(state.retried).toEqual([studio.id]);
    });
});
