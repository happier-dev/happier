import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { applyConnectedAccountCatalogSnapshot, getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { applyAcpCatalogSnapshot, getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { refreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';

// Only platform/navigation, secure storage, HTTP, Socket.IO and machine RPC
// boundaries are replaced. The complete launcher and all domain owners stay real.
installNewSessionScreenModelCommonModuleMocks({ storage: async (importOriginal) => importOriginal(),
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    routerConfig: { pathname: '/new', params: { machineId: 'credential-devbox', directory: '/repo', agentType: 'claude', prompt: 'hello' } } });
installDisconnectedServerSocketBoundary();
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
// IndexedDB is a genuine device-storage boundary; the draft repository remains real.
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
const declaration = { purpose: 'model_upstream', service, credentialKinds: ['oauth' as const] };
const initialState = storage.getState();
let mountedConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let mountedBridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | null = null;

function nativeFacts(status: 'signedIn' | 'signedOut') {
    // The daemon probe carries facts; the admitted descriptor supplies its id and title.
    const { agentId: _agentId, title: _title, ...facts } = MachineAgentInventoryItemSchema.parse({
        agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: '1', update: { supported: false, command: null },
        signIn: { status, loginSupport: 'login_terminal' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    });
    return facts;
}

afterEach(async () => { await standardCleanup(); await mountedConnection?.dispose(); mountedConnection = null;
    mountedBridge?.dispose(); mountedBridge = null;
    rpc.mockReset(); storage.setState(initialState, true); });

describe('New Session selected credential launch gate', () => {
    it('does not probe native suggestions after inherited purpose authority withdraws', async () => {
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        mountedBridge = bridge;
        const accountId = 'credential-suggestions';
        const http = createHomeHubArtifactHttpBoundary(accountId);
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const purposeValue = { v: 1 as const, bindings: [{ purpose: { consumer, purpose: declaration.purpose },
            target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] };
        const acpRecord = { v: 1 as const, definitions: [] };
        let withdrawn = false;
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://credential-suggestions.test', accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(withdrawn
                    ? Response.json({ error: 'forbidden' }, { status: 403 })
                    : Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: purposeValue } } }));
                if (path === '/v1/account/entity-rows/acp') return Promise.resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }));
                return http.request(input, init);
            } });
        const scope = { serverId: connection.home.id, accountId };
        mountedConnection = connection;
        storage.setState({ profileScope: scope, settingsScope: scope,
            settings: { ...settingsDefaults, lastUsedAgent: 'claude', useEnhancedSessionWizard: false },
            profile: AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{
                ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work', providerIdentity: {}, expiresAt: null,
            }] }) });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: connection.home.id });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: purposeValue } }, true);
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: acpRecord }, true);
        installConnectedAccountDescriptorProjection({ scopeKey: 'credential-suggestions', status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: 'claude-subscription', serviceId: 'claude-subscription', pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled',
                title: 'Claude subscription', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                    pkce: 'required', outcomeReconciliation: 'none' }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { claude: {
            id: 'claude', identity: consumer, isBuiltIn: true, title: 'Claude', connectedAccounts: [declaration],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const probes: unknown[] = [];
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { method?: string; params?: unknown } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.invoke' && payload?.method === 'probeCatalogs') {
                probes.push(payload.params);
                return { ok: true, result: { commands: { supported: true, items: [{ command: 'project-check' }] },
                    skills: { supported: true, items: [] } } };
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: Date.now(), data: nativeFacts('signedIn') } } };
            return { jobs: [] };
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored suggestion Account');
        await refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: 'credential-suggestions' }));
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                await model.simpleProps.emptyAutocompleteSuggestions('/project');
                expect(probes).toEqual([expect.objectContaining({ connectedServices: expect.objectContaining({
                    bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' } },
                }) })]);
            });
            probes.length = 0;
            withdrawn = true;
            await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
                status: 'unavailable', reason: 'forbidden',
            }, true); });
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            await act(async () => { await model.simpleProps.emptyAutocompleteSuggestions('/project'); });
            await flushHookEffects();
            expect(probes).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it.each([
        { native: 'signedOut' as const, connected: true, selected: 'native', acpReady: true, ready: false },
        { native: 'signedIn' as const, connected: true, selected: 'native', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: true, selected: 'connected', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'native', acpReady: true, ready: false },
        { native: 'signedIn' as const, connected: true, selected: 'native', acpReady: false, ready: true },
    ])('keeps Start and the inline recovery on the exact launch credential: %j', async (scenario) => {
        await prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        const accountId = 'credential-launcher';
        const http = createHomeHubArtifactHttpBoundary(accountId);
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const purposeValue = { v: 1 as const, bindings: scenario.selected === 'connected'
            ? [{ purpose: { consumer, purpose: declaration.purpose }, target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] : [] };
        const acpRecord = { v: 1 as const, definitions: [] };
        let releaseAcpRead: (() => void) | null = null;
        const pendingAcpRead = new Promise<Response>((resolve) => {
            releaseAcpRead = () => resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }));
        });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://credential-launcher.test', accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                    status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: purposeValue } } }));
                if (path === '/v1/account/entity-rows/acp') return scenario.acpReady
                    ? Promise.resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }))
                    : pendingAcpRead;
                return http.request(input, init);
            } });
        const scope = { serverId: connection.home.id, accountId };
        mountedConnection = connection;
        storage.setState({ profileScope: scope, settingsScope: scope, settings: { ...settingsDefaults, lastUsedAgent: 'claude', useEnhancedSessionWizard: false },
            profile: AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: scenario.connected ? [{
                ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work', providerIdentity: {}, expiresAt: null,
            }] : [] }) });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: connection.home.id });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1, record: { key: 'purposes', value: purposeValue } }, true);
        applyAcpCatalogSnapshot(scope, scenario.acpReady
            ? { status: 'ready', revision: 1, record: acpRecord }
            : { status: 'loading' }, true);
        installConnectedAccountDescriptorProjection({ scopeKey: 'credential-launcher', status: 'ready', conflicts: [], errorReason: null,
            descriptors: [{ id: 'claude-subscription', serviceId: 'claude-subscription', pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled',
                title: 'Claude subscription', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
                    pkce: 'required', outcomeReconciliation: 'none' }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { claude: {
            id: 'claude', identity: consumer, isBuiltIn: true, title: 'Claude', connectedAccounts: [declaration],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: Date.now(), data: nativeFacts(scenario.native) } } };
            return { jobs: [] };
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored launcher Account');
        await refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: `credential-${scenario.native}-${scenario.connected}-${scenario.selected}` }));
        try {
            await flushHookEffects();
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            const observedAdmission = JSON.stringify({
                purpose: getConnectedAccountCatalogValue(scope, 'purposes'), acp: getAcpCatalogSnapshot(scope),
                inventory: machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)),
                projection: readCachedDaemonMergedProjectionCacheEntry({ serverId: scope.serverId, machineId: machine.id })?.kind,
                profileScope: storage.getState().profileScope, selectedMachineId: model.simpleProps.selectedMachineId,
                agentType: model.simpleProps.agentType,
            });
            expect(model.simpleProps.canCreate, observedAdmission).toBe(scenario.ready);
            if (!scenario.acpReady) {
                expect(model.simpleProps.agentPickerOptions?.map((option) => option.id)).toContain('agent:happier.agent.claude/claude');
                act(() => { model.simpleProps.promptStore.setPrompt('hello'); });
                const { NewSessionSimplePanel } = await import('../components/NewSessionSimplePanel');
                const rendered = await renderScreen(<NewSessionSimplePanel {...model.simpleProps} />);
                try {
                    expect(rendered.findByTestId('new-session-composer-send')?.props.accessibilityState)
                        .toMatchObject({ disabled: false });
                } finally { await rendered.unmount(); }
            }
            expect(model.simpleProps.statusBadges?.some((badge) => badge.key === 'new-session-create-blocked'),
                observedAdmission).toBe(!scenario.ready);
            if (!scenario.ready) {
                const { t } = await import('@/text');
                expect(model.simpleProps.statusBadges?.find((badge) => badge.key === 'new-session-create-blocked'),
                    observedAdmission).toMatchObject({
                    label: expect.stringContaining(t('machineAgents.needsSignIn')),
                    accessibilityLabel: expect.stringContaining(t('machineAgents.needsSignIn')),
                });
            }
            const screen = await renderScreen(<>{model.simpleProps.composerTopContent}</>);
            try {
                expect(Boolean(screen.findHostByTestId('new-session-agent-blocker')), observedAdmission).toBe(!scenario.ready);
                if (!scenario.ready && scenario.connected) {
                    await screen.pressByTestIdAsync('new-session-agent-blocker.connected');
                    await act(async () => { await flushHookEffects(); });
                    const recovered = hook.getCurrent();
                    if (recovered.variant !== 'simple') throw new Error('Expected recovered simple launcher');
                    expect(recovered.simpleProps.canCreate).toBe(true);
                    expect(recovered.simpleProps.statusBadges?.some((badge) => badge.key === 'new-session-create-blocked')).toBe(false);
                }
            } finally { await screen.unmount(); }
        } finally {
            releaseAcpRead?.();
            await hook.unmount();
            await connection.dispose();
            mountedConnection = null;
            bridge.dispose();
        }
    });
});
