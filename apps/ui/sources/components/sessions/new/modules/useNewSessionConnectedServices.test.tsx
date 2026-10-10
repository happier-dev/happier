import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { projectMachineAgentConnectedServices } from '@/agents/machineAgents/machineAgentConnectedServices';
import { isMachineAgentReady } from '@/agents/machineAgents/resolveMachineAgentState';
import { AgentSessionStartBlocker } from '@/components/machines/agents/AgentSessionStartBlocker';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { storage } from '@/sync/domains/state/storage';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import type { NewSessionConnectedServicesSelectionContentProps } from '../components/NewSessionConnectedServicesSelectionContent';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createConnectedAccountDescriptorProjectionLoadingState,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import {
    installConnectedAccountDescriptorProjection,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { installNewSessionModulesCommonModuleMocks } from './newSessionModulesTestHelpers';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';

vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

// Canonical qualified Connected Account service keys used across this suite.
const CLAUDE_SERVICE_KEY = 'happier.agent.claude/anthropic';
const CODEX_SERVICE_KEY = 'happier.agent.codex/openai-codex';
// Novel external plugin service: no bundled enum member and no generated
// legacy mapping.
const NOVEL_SERVICE_KEY = 'acme.review/reviewer-service';

const modalShowMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => 'modal-1'));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => false));
const newSessionConnectedAccountProjection = {
    scopeKey: 'new-session-test',
    status: 'ready',
    descriptors: [{
        id: 'openai-codex',
        serviceId: 'openai-codex',
        pluginId: 'happier.agent.codex',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Codex',
        authentication: {
            defaultModeId: 'oauth',
            modes: [{
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                scopes: ['openid', 'profile', 'email', 'offline_access'],
                pkce: 'required',
                outcomeReconciliation: 'none',
            }],
        },
        capabilities: [],
        availability: { state: 'available', reason: 'resolved' },
        diagnostics: [],
    }, {
        id: 'anthropic',
        serviceId: 'anthropic',
        pluginId: 'happier.agent.claude',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Anthropic API key',
        authentication: {
            defaultModeId: 'api-key',
            modes: [{
                id: 'api-key',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                    id: 'token',
                    title: 'Anthropic API key',
                    schema: { type: 'string', minLength: 1 },
                    secret: true,
                }],
            }],
        },
        capabilities: [],
        availability: { state: 'available', reason: 'resolved' },
        diagnostics: [],
    }, {
        id: 'reviewer-service',
        serviceId: 'reviewer-service',
        pluginId: 'acme.review',
        provenance: 'first_party',
        sourceKind: 'bundled',
        title: 'Acme Reviewer Auth',
        authentication: {
            defaultModeId: 'api-key',
            modes: [{
                id: 'api-key',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                    id: 'token',
                    title: 'Acme token',
                    schema: { type: 'string', minLength: 1 },
                    secret: true,
                }],
            }],
        },
        capabilities: [],
        availability: { state: 'available', reason: 'resolved' },
        diagnostics: [],
    }],
    conflicts: [],
    errorReason: null,
} satisfies ConnectedAccountDescriptorProjectionState;

type TestAccountProfile = {
    connectedAccountsV4: Array<Record<string, unknown>>;
    connectedAccountGroupsV4: Array<Record<string, unknown>>;
    connectedServiceCredentialRevisionsV1?: Array<Record<string, unknown>>;
};

function v4Account(params: Readonly<{
    pluginId: string;
    localId: string;
    accountId: string;
    email?: string;
    displayName?: string;
    kind?: 'oauth' | 'token';
    status?: string;
}>): Record<string, unknown> {
    return {
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        ref: {
            service: { pluginId: params.pluginId, localId: params.localId },
            accountId: params.accountId,
        },
        status: params.status ?? 'connected',
        authenticationModeId: null,
        configurationReady: true,
        configurationRevision: null,
        kind: params.kind ?? null,
        expiresAt: null,
        lastUsedAt: null,
        providerIdentity: params.email ? { email: params.email } : {},
        ...(params.displayName ? { displayName: params.displayName } : {}),
    };
}

const profileState = {
    set current(profile: TestAccountProfile) {
        storage.setState({ profile: AccountProfileSchema.parse({ ...profileDefaults, id: storage.getState().profile?.id ?? profileDefaults.id, ...profile }) });
    },
};
const initialStorageState = storage.getState();
let activeHomeId = '';
let targetHomeId = '';
let activeGroupsEnabled = true;
let legacyConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let legacyBridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | null = null;
let legacyHttp: ReturnType<typeof createHomeHubArtifactHttpBoundary> | null = null;
let legacyPurposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };

function publishLegacyTestPurposeBindings(value: QualifiedConnectedAccountPurposeBindingsV1): void {
    legacyPurposeBindings = value;
    applyConnectedAccountCatalogSnapshot({ serverId: activeHomeId, accountId: 'legacy-controls' }, 'purposes',
        { status: 'ready', revision: 1, record: { key: 'purposes', value } }, true);
}

async function arrangeAccountGroupFeatures(preload = true) {
    const { resetServerFeaturesClientForTests, getServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();
    const request: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === '/v1/account/entity-rows/connected-accounts/purposes') return Response.json({
            status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: legacyPurposeBindings } },
        });
        if (url.pathname !== '/v1/features') return legacyHttp?.request(input, init) ?? new Response('{}', { status: 404 });
        const response = buildServerFeaturesResponse();
        response.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        response.features.connectedServices.accountGroups.enabled = url.hostname === 'target-connected-services.test' || activeGroupsEnabled;
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    setRuntimeFetch(request);
    vi.stubGlobal('fetch', request);
    if (preload) {
        await Promise.all([activeHomeId, targetHomeId].map((serverId) => getServerFeaturesSnapshot({ serverId, force: true })));
    }
    return request;
}

function seedClaudeProfile(): void {
    profileState.current = {
        connectedAccountsV4: [
            v4Account({
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
                accountId: 'work',
                email: 'work@example.com',
                kind: 'token',
                displayName: 'Work',
            }),
        ],
        connectedAccountGroupsV4: [],
        connectedServiceCredentialRevisionsV1: [],
    };
}

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNewSessionModulesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowMock,
                confirm: modalConfirmMock,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: 'Pressable',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        const { en } = await import('@/text/translations/en');
        return createTextModuleMock({
            translate: (key: string, params) => key === 'connectedServices.authChip.runsThrough' && typeof params?.source === 'string'
                ? en.connectedServices.authChip.runsThrough({ source: params.source }) : key,
        });
    },
});

// Load real owners during collection, after native boundary factories are set.
const { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
const { getResolvedBackendCatalogEntries } = await import('@/agents/backendCatalog/getResolvedBackendCatalogEntries');
const { resolveNewSessionConnectedServicesAgent, useNewSessionConnectedServicesAgentOptions } = await import('../hooks/screenModel/useNewSessionConnectedServicesAgentOptions');
const { useAgentInputSelectionOverlayController } = await import('@/components/sessions/agentInput/selection/useAgentInputSelectionOverlayController');

function requireCollapsedContentPopover(chip: AgentInputExtraActionChip | null) {
    const popover = chip?.collapsedContentPopover;
    if (!popover) {
        throw new Error('Expected connected services collapsed content popover');
    }
    return popover;
}

type ConnectedAccountsParam = ReadonlyArray<Readonly<{
    purpose: string;
    service: { pluginId: string; localId: string };
}>>;

const CLAUDE_CONNECTED_ACCOUNTS: ConnectedAccountsParam = [
    { purpose: 'primary', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } },
];
const NOVEL_CONNECTED_ACCOUNTS: ConnectedAccountsParam = [
    { purpose: 'primary', service: { pluginId: 'acme.review', localId: 'reviewer-service' } },
];

afterEach(async () => {
    await standardCleanup();
    await legacyConnection?.dispose();
    legacyConnection = null;
    legacyBridge?.dispose();
    legacyBridge = null;
    legacyHttp = null;
    resetRuntimeFetch();
    vi.unstubAllGlobals();
    storage.setState(initialStorageState, true);
    installConnectedAccountDescriptorProjection(
        createConnectedAccountDescriptorProjectionLoadingState('new-session-test-cleanup'),
    );
});

describe('new Session Connected Accounts from the machine catalog', () => {
    it('keeps both Claude subscription choices and the open overlay through offline recovery and background projection refresh', async () => {
        const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
        const serviceKey = 'happier.agent.claude/claude-subscription';
        // This is the daemon's public declaration, not the bundled scalar catalog.
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 7,
            agentsById: {
                claude: {
                    id: 'claude',
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                    isBuiltIn: true,
                    connectedAccounts: [{
                        purpose: 'model_upstream', service, required: false,
                        materializationKinds: ['environment', 'files', 'httpHeaders'],
                        credentialKinds: ['oauth', 'token'],
                    }],
                    providerOwnedEnvironmentKeys: [],
                },
            },
        });
        const inputs = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        const catalog = {
            enabledAgentIds: ['claude'],
        };
        const entries = getResolvedBackendCatalogEntries({ ...catalog, ...inputs });
        const entry = entries.find((candidate) => candidate.builtInAgentId === 'claude');
        expect(entry).toBeDefined();
        if (!entry) throw new Error('Expected projected Claude target');
        profileState.current = {
            connectedAccountsV4: ['personal', 'work'].map((accountId) => v4Account({
                ...service, accountId, displayName: accountId,
            })),
            connectedAccountGroupsV4: [],
        };
        const hook = await renderHook((phase: DaemonMergedProjectionInputsState['phase']) => {
            const [optionStateByTarget, setOptionStateByTarget] = React.useState<Record<string, Record<string, unknown>>>({});
            const accountAgent = resolveNewSessionConnectedServicesAgent({
                projection: { phase, inputs }, selectedBackendTargetKey: entry.backendTargetKey, catalog,
            });
            const connected = useNewSessionConnectedServicesAgentOptions({
                staticAgentId: entry.catalogAgentId,
                runtimeCarrierAgentId: entry.agentId,
                selectedMachineId: 'machine-claude',
                targetServerId: null,
                selectedBackendTargetKey: entry.backendTargetKey,
                connectedAccounts: accountAgent?.connectedAccounts,
                agentIdentity: accountAgent?.identity,
                setBackendNewSessionOptionStateByTargetKey: setOptionStateByTarget,
                agentOptionState: optionStateByTarget[entry.backendTargetKey] ?? null,
                settings: { connectedServicesDefaultProfileByServiceId: {} },
                router: { push: vi.fn() },
            });
            const overlay = useAgentInputSelectionOverlayController({
                extraActionChips: connected.connectedServicesAuthChip ? [connected.connectedServicesAuthChip] : [],
                shouldRenderSessionModeChip: false, canChangePermission: false, hasMachinePopover: false,
                hasPathPopover: false, hasResumePopover: false, hasProfilePopover: false,
                hasEnvVarsPopover: false, hasAgentPickerOptions: false,
            });
            return { ...connected, overlay };
        }, { initialProps: 'ready' });
        const popover = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip);
        if (typeof popover.renderContent !== 'function') throw new Error('Expected account picker content renderer');
        const content = popover.renderContent({ maxHeight: 560, requestClose: vi.fn() }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
        expect(content.props.supportedServiceIds).toEqual([serviceKey]);
        expect(content.props.profileOptionsByServiceId[serviceKey]?.map((profile) => profile.profileId)).toEqual(['personal', 'work']);
        expect(content.props.groupOptionsByServiceId).toEqual({});
        await act(async () => {
            hook.getCurrent().overlay.openSelectionOverlay('collapsedExtra', 'chip', 'new-session-connected-services-auth');
        });
        // The projection owner retains the same scope's metadata while offline,
        // after a transport failure and during the reconnect/refresh read.
        for (const phase of ['idle', 'error', 'loading', 'ready'] as const) {
            await hook.rerender(phase);
            const current = hook.getCurrent();
            expect(current.connectedServicesAuthChip, phase).not.toBeNull();
            expect(current.overlay.activeSelectionOverlay, phase).toMatchObject({
                id: 'collapsedExtra', chipKey: 'new-session-connected-services-auth',
            });
            const currentPopover = requireCollapsedContentPopover(current.overlay.activeExtraCollapsedPopoverChip);
            if (typeof currentPopover.renderContent !== 'function') throw new Error('Expected picker renderer');
            const currentContent = currentPopover.renderContent({ maxHeight: 560, requestClose: vi.fn() }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
            expect(currentContent.props.profileOptionsByServiceId[serviceKey]?.map((profile) => profile.profileId), phase)
                .toEqual(['personal', 'work']);
        }
        await act(async () => {
            await content.props.setBindingForService(serviceKey, { source: 'connected', selection: 'profile', profileId: 'work' });
        });
        expect(hook.getCurrent().agentNewSessionOptions).toMatchObject({
            connectedServices: { v: 2, bindingsByServiceId: {
                [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work' },
            } },
        });
        // Bundled Agent declarations remain available without a Machine
        // projection; credential admission still belongs to the scoped owner.
        const withdrawnAgent = resolveNewSessionConnectedServicesAgent({
            projection: { phase: 'loading', inputs: null },
            selectedBackendTargetKey: entry.backendTargetKey,
            catalog,
        });
        expect(withdrawnAgent?.identity).toEqual(entry.agentCatalogEntry.identity);
        expect(withdrawnAgent?.connectedAccounts).toContainEqual(expect.objectContaining({ service }));
    });
});

async function arrangeLegacyConnectedServicesHomes() {
        storage.setState(initialStorageState, true);
        activeGroupsEnabled = true;
        legacyHttp = createHomeHubArtifactHttpBoundary('legacy-controls');
        legacyBridge = await loadSyncSingletonForTests();
        const boundaryRequest = await arrangeAccountGroupFeatures(false);
        legacyConnection = await restoreServerAccountForTest({ serverUrl: 'https://active-connected-services.test',
            accountId: 'legacy-controls', request: boundaryRequest });
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const target = await upsertServerProfileOnly({ serverUrl: 'https://target-connected-services.test', name: 'Target' });
        activeHomeId = legacyConnection.home.id;
        targetHomeId = target.id;
        storage.setState({ profileScope: { serverId: activeHomeId, accountId: 'legacy-controls' },
            profile: AccountProfileSchema.parse({ id: 'legacy-controls' }) });
        publishLegacyTestPurposeBindings({ v: 1, bindings: [] });
        await arrangeAccountGroupFeatures();
        installConnectedAccountDescriptorProjection(newSessionConnectedAccountProjection);
        modalShowMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(false);
        seedClaudeProfile();
}

describe('New Session purpose catalog authority', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        installConnectedAccountDescriptorProjection(newSessionConnectedAccountProjection);
    });

    it.each([
        { native: 'signedOut' as const, connected: true, selected: 'native', ready: false },
        { native: 'signedIn' as const, connected: true, selected: 'native', ready: true },
        { native: 'signedOut' as const, connected: true, selected: 'connected', ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'native', ready: false },
    ])('launch readiness follows the selected credential and offers a one-tap binding recovery: %j', async (scenario) => {
        const bridge = await loadSyncSingletonForTests();
        const accountId = 'selected-launch-credential';
        const http = createHomeHubArtifactHttpBoundary(accountId);
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const value = { v: 1 as const, bindings: [] };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://selected-launch-credential.test', accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                    status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value } },
                }));
                return http.request(input, init);
            } });
        const scope = { serverId: connection.home.id, accountId };
        const profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: scenario.connected
            ? [{ ...v4Account({ ...CLAUDE_CONNECTED_ACCOUNTS[0]!.service, accountId: 'work', displayName: 'Work', kind: 'token' }),
                revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`, authenticationModeId: 'api-key' }] : [] });
        storage.setState({ profileScope: scope, profile });
        installConnectedAccountDescriptorProjection(newSessionConnectedAccountProjection);
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1, record: { key: 'purposes', value } }, true);
        const connectedServices = projectMachineAgentConnectedServices({ agents: [{ agentId: 'claude', connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS }],
            profile, accountTransport: 'advertised-v4', entries: getConnectedServiceRegistrySnapshot().entries, now: Date.now() }).claude;
        const machineAgent = projectMachineAgent({ agentId: 'claude', title: 'Claude', checking: false, stale: false, job: null, connectedServices,
            facts: { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1', update: null,
                signIn: { status: scenario.native, loginSupport: 'login_terminal' }, platform: { supported: true },
                install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] } });
        const hook = await renderHook(() => {
            const [options, setOptions] = React.useState<Record<string, Record<string, unknown>>>(scenario.selected === 'connected' ? {
                'agent:happier.agent.claude/claude': { connectedServicesBindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                } },
            } : {});
            return useNewSessionConnectedServicesAgentOptions({ staticAgentId: 'claude', runtimeCarrierAgentId: 'claude', selectedMachineId: 'devbox',
                targetServerId: connection.home.id, selectedBackendTargetKey: 'agent:happier.agent.claude/claude',
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS, agentIdentity: { pluginId: 'happier.agent.claude', localId: 'claude' }, machineAgent,
                settings: { connectedServicesDefaultProfileByServiceId: {} }, agentOptionState: options['agent:happier.agent.claude/claude'] ?? null,
                setBackendNewSessionOptionStateByTargetKey: setOptions, router: { push() {} } });
        });
        try {
            expect(isMachineAgentReady(hook.getCurrent().selectedCredentialMachineAgent)).toBe(scenario.ready);
            // Aggregate Machine/Agent rows retain their "any usable credential" contract.
            expect(isMachineAgentReady(machineAgent)).toBe(scenario.connected || scenario.native === 'signedIn');
            const screen = await renderScreen(<AgentSessionStartBlocker agent={hook.getCurrent().selectedCredentialMachineAgent}
                machineName="Devbox" onSetUp={() => {}} connectedServicesRecoveryAction={hook.getCurrent().connectedServicesRecoveryAction} />);
            try {
                expect(Boolean(screen.findHostByTestId('new-session-agent-blocker'))).toBe(!scenario.ready);
                const canRecover = scenario.native === 'signedOut' && scenario.connected && scenario.selected === 'native';
                expect(Boolean(screen.findByTestId('new-session-agent-blocker.connected'))).toBe(canRecover);
                if (canRecover) {
                    expect(screen.findByTestId('new-session-agent-blocker.action')).not.toBeNull();
                    await screen.pressByTestIdAsync('new-session-agent-blocker.connected');
                    expect(isMachineAgentReady(hook.getCurrent().selectedCredentialMachineAgent)).toBe(true);
                    expect(hook.getCurrent().agentNewSessionOptions).toMatchObject({ connectedServices: { bindingsByServiceId: {
                        [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                    } } });
                    const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
                    expect(getConnectedAccountCatalogValue(scope, 'purposes').value).toEqual(value);
                }
            } finally { await screen.unmount(); }
        } finally { await hook.unmount(); await connection.dispose(); bridge.dispose(); }
    });

    it.each([false, true])('inherits the credential-bound target Home purpose row while another Home is focused (empty: %s)', async (empty) => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const bridge = await loadSyncSingletonForTests();
        const focusedAccountId = `borrowed-purpose-focus-${empty}`;
        const targetAccountId = `borrowed-purpose-target-${empty}`;
        const focusedUrl = `https://borrowed-purpose-focus-${empty}.test`;
        const targetUrl = `https://borrowed-purpose-target-${empty}.test`;
        const focusedHttp = createHomeHubArtifactHttpBoundary(focusedAccountId);
        const targetHttp = createHomeHubArtifactHttpBoundary(targetAccountId);
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const service = CLAUDE_CONNECTED_ACCOUNTS[0]!.service;
        const value: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: empty ? [] : [{
            purpose: { consumer, purpose: 'primary' },
            target: { kind: 'account', account: { service, accountId: 'target-work' } },
        }] };
        const targetCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: targetAccountId })).toString('base64url')}.signature` };
        const targetReadTokens: Array<string | null> = [];
        const request: typeof fetch = async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(features);
            if (url.origin === targetUrl && url.pathname === '/v1/account/entity-rows/connected-accounts/purposes') {
                targetReadTokens.push(new Headers(init?.headers).get('authorization'));
                return Response.json({ status: 'present', revision: 5,
                    content: { t: 'plain', v: { key: 'purposes', value } } });
            }
            return (url.origin === targetUrl ? targetHttp : focusedHttp).request(input, init);
        };
        const connection = await restoreServerAccountForTest({ serverUrl: focusedUrl, accountId: focusedAccountId, request });
        const target = await upsertServerProfileOnly({ serverUrl: targetUrl, name: 'Target Home' });
        let targetSignedIn = true;
        // Device credential storage is the external boundary; credential resolution and retirement remain real.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) =>
            url === targetUrl ? targetSignedIn ? targetCredentials : null : url === focusedUrl ? connection.credentials : null);
        setRuntimeFetch(request);
        const focusedScope = { serverId: connection.home.id, accountId: focusedAccountId };
        storage.setState({ profileScope: focusedScope, profile: AccountProfileSchema.parse({ id: focusedAccountId }) });
        const hook = await renderHook(() => ({
            targetBinding: useServerCredentialAccountScopeBinding(target.id),
            defaults: useNewSessionConnectedServices({
                agentCore: null, defaultAuthAgentId: 'claude', defaultAuthConsumer: consumer,
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS, agentOptionState: null,
                settings: { connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
                        claude: { [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'retired-legacy' } },
                    } } },
                targetServerId: target.id, sourceMachineId: 'target-machine',
                router: { push() {} }, setAgentOptionStateForCurrentAgent() {},
            }),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().targetBinding.resolution).toEqual({
                kind: 'bound', scope: { serverId: target.id, accountId: targetAccountId },
            }));
            expect(getActiveServerAccountScope()).toEqual(focusedScope);
            await vi.waitFor(() => expect(hook.getCurrent().defaults.connectedAccountDefaultsStatus).toBe('ready'));
            expect(targetReadTokens).toContain(`Bearer ${targetCredentials.token}`);
            if (empty) expect(hook.getCurrent().defaults.connectedServicesBindingsPayload).toBeNull();
            else expect(hook.getCurrent().defaults.connectedServicesBindingsPayload).toMatchObject({ bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'target-work' },
            } });
            const admitted = hook.getCurrent().defaults.requireConnectedAccountDefaultsReady;
            expect(() => admitted()).not.toThrow();
            await act(async () => {
                targetSignedIn = false;
                expect(await TokenStorage.removeCredentialsForServerUrl(targetUrl, { serverId: target.id })).toBe(true);
            });
            expect(() => admitted()).toThrow();
            await vi.waitFor(() => expect(hook.getCurrent().targetBinding.resolution.kind).toBe('signed_out'));
            expect(hook.getCurrent().defaults.connectedAccountDefaultsStatus).not.toBe('ready');
            expect(hook.getCurrent().defaults.connectedServicesBindingsPayload).toBeNull();
            expect(getActiveServerAccountScope()).toEqual(focusedScope);
        } finally { await hook.unmount(); credentialRead.mockRestore(); await connection.dispose(); bridge.dispose(); }
    });

    it('retires an optimistic authored authentication choice when its mounted Account scope changes before controlled echo', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const bridge = await loadSyncSingletonForTests();
        const http = createHomeHubArtifactHttpBoundary('optimistic-account-a');
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://optimistic-account-scope.test', accountId: 'optimistic-account-a', request: (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Promise.resolve(Response.json(features));
            if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
            return http.request(input, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'optimistic-account-a' };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null, defaultAuthAgentId: 'claude', defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS, agentOptionState: null,
            settings: { connectedServicesDefaultProfileByServiceId: {} }, targetServerId: connection.home.id,
            router: { push() {} }, setAgentOptionStateForCurrentAgent() {},
        }));
        try {
            const popover = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip);
            if (!popover.renderContent) throw new Error('Expected real auth selection content');
            const content = popover.renderContent({ maxHeight: 560, requestClose() {} }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
            await act(async () => { await content.props.setBindingForService(CLAUDE_SERVICE_KEY, { source: 'native' }); });
            expect(hook.getCurrent().connectedAccountDefaultsStatus).toBe('ready');
            const successor = { ...scope, accountId: 'optimistic-account-b' };
            await act(async () => {
                applyConnectedAccountCatalogSnapshot(successor, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true);
                storage.setState({ profileScope: successor, profile: AccountProfileSchema.parse({ id: successor.accountId }) });
                expect(() => hook.getCurrent().requireConnectedAccountDefaultsReady()).toThrow();
            });
            expect(hook.getCurrent().connectedAccountDefaultsStatus).not.toBe('ready');
        } finally { await hook.unmount(); await connection.dispose(); bridge.dispose(); }
    });

    it('inherits destination-only purpose defaults and refuses unavailable inheritance without blocking explicit or native-only auth', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const bridge = await loadSyncSingletonForTests();
        const http = createHomeHubArtifactHttpBoundary('catalog-inheritance');
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const service = CLAUDE_CONNECTED_ACCOUNTS[0]!.service;
        const value = { v: 1 as const, bindings: [{ purpose: { consumer, purpose: 'primary' },
            target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://catalog-inheritance.test', accountId: 'catalog-inheritance', request: (input, init) => {
            if (new URL(String(input)).pathname === '/v1/features') return Promise.resolve(Response.json(features));
            if (new URL(String(input)).pathname === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                status: 'present', revision: 5, content: { t: 'plain', v: { key: 'purposes', value } },
            }));
            return http.request(input, init);
        } });
        const scope = { serverId: connection.home.id, accountId: 'catalog-inheritance' };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId,
            connectedAccountsV4: [v4Account({ ...service, accountId: 'work', displayName: 'Work' })] }) });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 5, record: { key: 'purposes', value } }, true);
        let withdrawing = false;
        const withdrawnLabels: string[] = [];
        const hook = await renderHook((props: Readonly<{ agentOptionState: Record<string, unknown> | null; connectedAccounts: ConnectedAccountsParam }>) => {
            const result = useNewSessionConnectedServices({
            agentCore: null, defaultAuthAgentId: 'claude', defaultAuthConsumer: consumer, connectedAccounts: props.connectedAccounts,
            agentOptionState: props.agentOptionState, settings: { connectedServicesDefaultProfileByServiceId: {} },
            targetServerId: connection.home.id, router: { push() {} }, setAgentOptionStateForCurrentAgent() {},
            });
            if (withdrawing) withdrawnLabels.push(requireCollapsedContentPopover(result.connectedServicesAuthChip).label);
            return result;
        }, { initialProps: { agentOptionState: null, connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS } });
        try {
            expect(hook.getCurrent().connectedServicesBindingsPayload).toMatchObject({ bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
            } });
            const submittedAdmission = hook.getCurrent().requireConnectedAccountDefaultsReady;
            await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 6,
                record: { key: 'purposes', value } }, true); });
            expect(() => submittedAdmission()).toThrow();
            expect(() => hook.getCurrent().requireConnectedAccountDefaultsReady()).not.toThrow();
            withdrawing = true;
            await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'account-mode-mismatch' }, true); });
            expect(hook.getCurrent()).toMatchObject({ connectedAccountDefaultsStatus: 'unavailable', connectedServicesBindingsPayload: null });
            expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label).toBe('common.unavailable');
            expect(withdrawnLabels.every((label) => !label.includes('Work'))).toBe(true);
            withdrawing = false;
            await hook.rerender({ agentOptionState: { connectedServicesBindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } } }, connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS });
            expect(hook.getCurrent()).toMatchObject({ connectedAccountDefaultsStatus: 'ready' });
            await hook.rerender({ agentOptionState: null, connectedAccounts: [] });
            expect(hook.getCurrent()).toMatchObject({ connectedAccountDefaultsStatus: 'ready' });
        } finally { await hook.unmount(); await connection.dispose(); bridge.dispose(); }
    });

    it('refuses inherited authentication without the projected Agent consumer while allowing an explicit Native recovery', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const bridge = await loadSyncSingletonForTests();
        const http = createHomeHubArtifactHttpBoundary('unknown-consumer');
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://unknown-consumer.test', accountId: 'unknown-consumer', request: (input, init) =>
            new URL(String(input)).pathname === '/v1/features' ? Promise.resolve(Response.json(features)) : http.request(input, init) });
        const scope = { serverId: connection.home.id, accountId: 'unknown-consumer' };
        storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: { v: 1, bindings: [] } } }, true);
        const hook = await renderHook((agentOptionState: Record<string, unknown> | null) => useNewSessionConnectedServices({
            agentCore: null, defaultAuthAgentId: 'claude', defaultAuthConsumer: null,
            connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS, agentOptionState,
            settings: { connectedServicesDefaultProfileByServiceId: {} }, targetServerId: connection.home.id,
            router: { push() {} }, setAgentOptionStateForCurrentAgent() {},
        }), { initialProps: null });
        try {
            expect(hook.getCurrent()).toMatchObject({ connectedAccountDefaultsStatus: 'unavailable', connectedServicesBindingsPayload: null });
            await hook.rerender({ connectedServicesBindingsByServiceId: { [CLAUDE_SERVICE_KEY]: { source: 'native' } } });
            expect(hook.getCurrent()).toMatchObject({ connectedAccountDefaultsStatus: 'ready' });
        } finally { await hook.unmount(); await connection.dispose(); bridge.dispose(); }
    });
});

describe('useNewSessionConnectedServices', () => {
    beforeEach(arrangeLegacyConnectedServicesHomes);
    it('returns a connected-services chip that opens the anchored account picker popover', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const routerPush = vi.fn();
        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        const chip = hook.getCurrent().connectedServicesAuthChip;
        expect(chip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        expect(chip?.collapsedAction).toBeUndefined();
        expect(chip?.collapsedContentPopover).toEqual(expect.objectContaining({
            title: 'connectedServices.authChip.runsThroughOwnSignIn',
            label: 'connectedServices.authChip.runsThroughOwnSignIn',
            scrollEnabled: false,
            renderContent: expect.any(Function),
        }));

        const toggleCollapsedPopover = vi.fn();
        const renderedChip = chip!.render({
            chipStyle: () => null,
            iconColor: '#000',
            showLabel: true,
            textStyle: null,
            countTextStyle: null,
            chipAnchorRef: { current: null },
            popoverAnchorRef: { current: null },
            toggleCollapsedPopover,
        }) as React.ReactElement<{
            onPress?: () => void;
            testID?: string;
            dataSet?: { authSource?: string };
        }>;
        expect(renderedChip.props.testID).toBe('new-session-connected-services-auth-chip');
        expect(renderedChip.props.dataSet?.authSource).toBe('native');

        renderedChip.props.onPress?.();

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-connected-services-auth');
        expect(modalShowMock).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('updates the chip label and reopened popover selection after choosing a connected profile', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        const firstPopoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof firstPopoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const firstPopover = firstPopoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            firstPopover.props.setBindingForService(CLAUDE_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'work',
            });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' } },
        );
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Runs through Anthropic API key: Work');
        // "Runs through <account>": the account is the route's native source.
        expect(hook.getCurrent().routePresentation.applied).toMatchObject({ kind: 'native', sourceLabel: 'Anthropic API key: Work' });

        const reopenedPopoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof reopenedPopoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const reopenedPopover = reopenedPopoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ bindingsByServiceId: Record<string, unknown> }>;

        expect(reopenedPopover.props.bindingsByServiceId).toEqual({
            [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
        });

        await hook.unmount();
    });

    it('keeps the core chip available while scoping the account-groups decision to the target server', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        activeGroupsEnabled = false;
        await arrangeAccountGroupFeatures();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: { connectedServicesBindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'feature-pool' },
                } },
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: targetHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected account-groups picker content');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
        expect(content.props.resolveOptionAvailability?.({ serviceId: CLAUDE_SERVICE_KEY,
            optionId: `connected-service:${encodeURIComponent(CLAUDE_SERVICE_KEY)}:native`, binding: { source: 'native' },
        })).toMatchObject({ subtitle: 'connectedServices.defaultAuth.warning.connected_group_unavailable' });
        await hook.unmount();
    });

    it('keeps the core chip available while using the default scope for account groups', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        activeGroupsEnabled = false;
        await arrangeAccountGroupFeatures();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: { connectedServicesBindingsByServiceId: {
                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'group', groupId: 'feature-pool' },
                } },
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: null,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesAuthChip).toEqual(
            expect.objectContaining({
                key: 'new-session-connected-services-auth',
                controlId: 'connectedServices',
            }),
        );
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected account-groups picker content');
        const content = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<NewSessionConnectedServicesSelectionContentProps>;
        expect(content.props.resolveOptionAvailability?.({ serviceId: CLAUDE_SERVICE_KEY,
            optionId: `connected-service:${encodeURIComponent(CLAUDE_SERVICE_KEY)}:native`, binding: { source: 'native' },
        })).toMatchObject({ subtitle: 'connectedServices.defaultAuth.warning.connected_group_disabled' });
        await hook.unmount();
    });

    it('applies the per-agent default connected auth binding before the user opens the chip', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        publishLegacyTestPurposeBindings({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.claude', localId: 'claude' }, purpose: 'primary' },
            target: { kind: 'account', account: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'work' } },
        }] });

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'claude', connectedServices: null },
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CLAUDE_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'work',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Runs through Anthropic API key: Work');
        // "Runs through <account>": the account is the route's native source.
        expect(hook.getCurrent().routePresentation.applied).toMatchObject({ kind: 'native', sourceLabel: 'Anthropic API key: Work' });

        await hook.unmount();
    });

    it('applies the Team resource purpose default chosen on the Agent page over a released service-keyed default', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const teamSelection = {
            source: 'team_resource',
            resourceId: 'resource-acme',
            deliveryMode: 'direct',
            disclosedMember: { service: { pluginId: 'happier.agent.claude', localId: 'anthropic' }, accountId: 'source-member' },
        } as const;
        publishLegacyTestPurposeBindings({ v: 1, bindings: [], teamResourceSelections: [{
            purpose: { consumer: { pluginId: 'happier.agent.claude', localId: 'claude' }, purpose: 'primary' },
            teamId: 'team-acme', selection: teamSelection,
        }] });

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'claude', connectedServices: null },
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    // A stale released default for the same Agent never wins.
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CLAUDE_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'work' },
                                },
                            },
                        },
                    },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: { [CLAUDE_SERVICE_KEY]: teamSelection },
        });

        await hook.unmount();
    });

    it('applies an installed Agent default through its selected routing identity', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const installedAgentId = 'acme.review/reviewer';
        publishLegacyTestPurposeBindings({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'acme.review', localId: 'reviewer' }, purpose: 'primary' },
            target: { kind: 'account', account: { service: { pluginId: 'acme.review', localId: 'reviewer-service' }, accountId: 'reviewer' } },
        }] });
        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'acme.review',
                    localId: 'reviewer-service',
                    accountId: 'reviewer',
                    email: 'reviewer@acme.test',
                    kind: 'token',
                    displayName: 'Reviewer',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: installedAgentId,
                defaultAuthConsumer: { pluginId: 'acme.review', localId: 'reviewer' },
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            [installedAgentId]: {
                                v: 1,
                                bindingsByServiceId: {
                                    [NOVEL_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'reviewer',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
            },
        });

        await hook.unmount();
    });

    it('preserves a per-agent default group binding when the active profile changes', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        publishLegacyTestPurposeBindings({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            target: { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'primary' },
        }] });

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'fresh-profile',
                    email: 'fresh@example.com',
                    kind: 'oauth',
                    displayName: 'Fresh',
                }),
            ],
            connectedAccountGroupsV4: [{
                v: 1,
                ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'primary' },
                incarnation: 'primary:1',
                displayName: 'Primary pool',
                policy: { v: 1, strategy: 'least_limited', autoSwitch: true, switchOn: { usageLimit: true, authExpired: true, accountChanged: false, refreshFailure: true } },
                activeConnectedAccountId: 'fresh-profile',
                generation: 1,
                runtimeStateRevision: 1,
                state: { status: 'ready' },
                createdAt: 0,
                updatedAt: 0,
                members: [
                    { v: 1, connectedAccountId: 'fresh-profile', priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
                ],
            }],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'codex', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'primary',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [CODEX_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'primary',
                },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Runs through Codex: Primary pool');
        // "Runs through <account>": the account is the route's native source.
        expect(hook.getCurrent().routePresentation.applied).toMatchObject({ kind: 'native', sourceLabel: 'Codex: Primary pool' });

        await hook.unmount();
    });

    it('preserves a stale default group identity while presenting native availability', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        publishLegacyTestPurposeBindings({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            target: { kind: 'group', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'missing-group' },
        }] });

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'work',
                    email: 'work@example.com',
                    kind: 'oauth',
                    displayName: 'Work',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: { id: 'codex', connectedServices: null },
                defaultAuthConsumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'missing-group',
                                    },
                                },
                            },
                        },
                    },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [CODEX_SERVICE_KEY]: {
                    source: 'connected',
                    selection: 'group',
                    groupId: 'missing-group',
                },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('connectedServices.authChip.runsThroughOwnSignIn');

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{
            resolveOptionAvailability?: (params: { serviceId: string; optionId: string }) => { subtitle?: string };
        }>;

        expect(popover.props.resolveOptionAvailability?.({
            serviceId: CODEX_SERVICE_KEY,
            optionId: `connected-service:${encodeURIComponent(CODEX_SERVICE_KEY)}:native`,
        })).toEqual({
            subtitle: 'connectedServices.defaultAuth.warning.connected_group_unavailable',
        });

        await hook.unmount();
    });

    it('offers a NOVEL external plugin service from its projected declaration and emits the qualified spawn payload', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'acme.review',
                    localId: 'reviewer-service',
                    accountId: 'reviewer',
                    email: 'reviewer@acme.test',
                    kind: 'token',
                    displayName: 'Reviewer',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };

        const setAgentOptionStateForCurrentAgent = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                // An installed external Agent has no bundled core and no bundled
                // scalar service declaration — only the machine projection.
                agentCore: null,
                defaultAuthAgentId: 'acme.review/reviewer',
                defaultAuthConsumer: { pluginId: 'acme.review', localId: 'reviewer' },
                connectedAccounts: NOVEL_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: vi.fn() },
                setAgentOptionStateForCurrentAgent,
            }),
        );

        // Neutral/public presentation from the applied descriptor projection.
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('connectedServices.authChip.runsThroughOwnSignIn');

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose: vi.fn(),
            maxHeight: 420,
        }) as React.ReactElement<{ setBindingForService: (serviceId: string, binding: unknown) => void }>;

        await act(async () => {
            popover.props.setBindingForService(NOVEL_SERVICE_KEY, {
                source: 'connected',
                selection: 'profile',
                profileId: 'reviewer',
            });
        });

        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' } },
        );
        expect(hook.getCurrent().connectedServicesBindingsPayload).toEqual({
            v: 2,
            bindingsByServiceId: {
                [NOVEL_SERVICE_KEY]: { source: 'connected', selection: 'profile', profileId: 'reviewer' },
            },
        });
        expect(requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).label)
            .toBe('Runs through Acme Reviewer Auth: Reviewer');
        expect(hook.getCurrent().routePresentation).toEqual({
            applied: { kind: 'native', sourceLabel: 'Acme Reviewer Auth: Reviewer',
                authSource: 'connected', connectedCount: 1, modelId: null },
            pending: null,
        });

        await hook.unmount();
    });

    it('deep-links the picker settings action to the tapped service settings screen (UI-2)', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onOpenSettings: (serviceId: string) => void;
        }>;

        expect(typeof popover.props.onOpenSettings).toBe('function');
        act(() => {
            popover.props.onOpenSettings(CLAUDE_SERVICE_KEY);
        });

        // UI-2: the picker's settings action deep-links to the tapped service's
        // settings screen instead of discarding the serviceId.
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services',
            params: {
                service: CLAUDE_SERVICE_KEY,
                connect: '1',
            },
        });

        await hook.unmount();
    });

    it('routes oauth profiles that need reauth from the new-session popover to the reconnect flow', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.codex',
                    localId: 'openai-codex',
                    accountId: 'happier',
                    email: 'happier@example.com',
                    kind: 'oauth',
                    displayName: 'Happier',
                    status: 'needs_reauth',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                connectedAccounts: [
                    { purpose: 'primary', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
                ],
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onReconnectProfile?: (serviceId: string, profileId: string) => void;
        }>;

        expect(typeof popover.props.onReconnectProfile).toBe('function');
        act(() => {
            popover.props.onReconnectProfile?.(CODEX_SERVICE_KEY, 'happier');
        });

        expect(requestClose).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.codex',
                localId: 'openai-codex',
                accountId: 'happier',
            },
        });

        await hook.unmount();
    });

    it('routes token profiles that need reauth from the new-session popover to the profile action surface', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');

        profileState.current = {
            connectedAccountsV4: [
                v4Account({
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                    accountId: 'work@example.com',
                    email: 'work@example.com',
                    kind: 'token',
                    displayName: 'Work',
                    status: 'needs_reauth',
                }),
            ],
            connectedAccountGroupsV4: [],
            connectedServiceCredentialRevisionsV1: [],
        };
        const requestClose = vi.fn();
        const routerPush = vi.fn();

        const hook = await renderHook(() =>
            useNewSessionConnectedServices({
                agentCore: null,
                defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
                agentOptionState: null,
                settings: {
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                },
                targetServerId: activeHomeId,
                router: { push: routerPush },
                setAgentOptionStateForCurrentAgent: vi.fn(),
            }),
        );

        const popoverRenderer = requireCollapsedContentPopover(
            hook.getCurrent().connectedServicesAuthChip,
        ).renderContent;
        if (typeof popoverRenderer !== 'function') {
            throw new Error('Expected connected services popover content renderer');
        }
        const popover = popoverRenderer({
            requestClose,
            maxHeight: 420,
        }) as React.ReactElement<{
            onReconnectProfile?: (serviceId: string, profileId: string) => void;
        }>;

        expect(typeof popover.props.onReconnectProfile).toBe('function');
        act(() => {
            popover.props.onReconnectProfile?.(CLAUDE_SERVICE_KEY, 'work@example.com');
        });

        expect(requestClose).not.toHaveBeenCalled();
        expect(routerPush).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
                accountId: 'work@example.com',
            },
        });

        await hook.unmount();
    });

    it('preserves the new-Session Connected Service draft when direct disclosure is cancelled', async () => {
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const setAgentOptionStateForCurrentAgent = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: 'Shared Claude', resourceRevision: 4,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'never_delivered' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [], connectedServiceSelections: [selection],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            },
        };
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null,
            defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            agentOptionState: null,
            settings: {
                                connectedServicesDefaultProfileByServiceId: {},
            },
            targetServerId: 'server-1',
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            router: { push: vi.fn() },
            setAgentOptionStateForCurrentAgent,
        }));
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected connected services popover content renderer');
        const popover = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{
            setBindingForService: (serviceId: string, binding: typeof selection) => Promise<void> | void;
        }>;

        await act(async () => {
            await popover.props.setBindingForService(CLAUDE_SERVICE_KEY, selection);
        });

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).not.toHaveBeenCalled();
        expect(hook.getCurrent().connectedServicesBindingsPayload).toBeNull();
        await hook.unmount();
    });

    it('commits the exact direct Connected Service selection once after disclosure continues', async () => {
        modalConfirmMock.mockResolvedValue(true);
        const { useNewSessionConnectedServices } = await import('./useNewSessionConnectedServices');
        const setAgentOptionStateForCurrentAgent = vi.fn();
        const selection = {
            source: 'team_resource' as const,
            resourceId: 'resource-1',
            deliveryMode: 'direct' as const,
            disclosedMember: {
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
                accountId: 'shared-account',
            },
        };
        const resource = {
            id: 'resource-1', teamId: 'team-1', displayName: 'Shared Claude', resourceRevision: 4,
            readiness: { kind: 'available' as const }, recoveryAction: null,
            deliveryMode: 'direct' as const, mayBroker: false, mayReceiveDirect: true,
            directMaterialState: 'current' as const,
            sessionUsePolicy: 'personal_allowed' as const,
            providerModels: [], connectedServiceSelections: [selection],
            sourcePresentation: {
                kind: 'connected_service' as const,
                service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
            },
        };
        const hook = await renderHook(() => useNewSessionConnectedServices({
            agentCore: null,
            defaultAuthAgentId: 'claude',
                defaultAuthConsumer: { pluginId: 'happier.agent.claude', localId: 'claude' },
                connectedAccounts: CLAUDE_CONNECTED_ACCOUNTS,
            agentOptionState: null,
            settings: {
                                connectedServicesDefaultProfileByServiceId: {},
            },
            targetServerId: 'server-1',
            teamCredentialResources: [resource],
            teamNameById: { 'team-1': 'Acme' },
            router: { push: vi.fn() },
            setAgentOptionStateForCurrentAgent,
        }));
        const renderContent = requireCollapsedContentPopover(hook.getCurrent().connectedServicesAuthChip).renderContent;
        if (typeof renderContent !== 'function') throw new Error('Expected connected services popover content renderer');
        const popover = renderContent({ requestClose: vi.fn(), maxHeight: 420 }) as React.ReactElement<{
            setBindingForService: (serviceId: string, binding: typeof selection) => Promise<void> | void;
        }>;

        await act(async () => {
            await popover.props.setBindingForService(CLAUDE_SERVICE_KEY, selection);
        });

        expect(modalConfirmMock).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledOnce();
        expect(setAgentOptionStateForCurrentAgent).toHaveBeenCalledWith(
            'connectedServicesBindingsByServiceId',
            { [CLAUDE_SERVICE_KEY]: selection },
        );
        await hook.unmount();
    });

});
