import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { AcpCatalogRecordV1Schema, ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema, ProfileRowsListResponseV1Schema,
    ProfileReferenceGuardReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';
import { PROFILE_TRANSFER_ROUTE_V1, ProfileTransferRowReadResponseV1Schema } from '@happier-dev/protocol/profiles/profileTransferV1';
import { type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
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
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { LMSTUDIO_PROVIDER_CONTRIBUTION } from '../../../../../../../packages/plugins/lmstudio/src/provider/contribution';

// Only platform/navigation, secure storage, HTTP, Socket.IO and machine RPC
// boundaries are replaced. The complete launcher and all domain owners stay real.
const authoringRoute = vi.hoisted(() => ({
    agentType: 'claude' as string | undefined,
    backendTarget: undefined as string | undefined,
    backendTargetKey: undefined as string | undefined,
}));
installNewSessionScreenModelCommonModuleMocks({ storage: async (importOriginal) => importOriginal(),
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    routerConfig: { pathname: '/new', params: () => ({ machineId: 'credential-devbox', directory: '/repo', prompt: 'hello', ...authoringRoute }) } });
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
        { native: 'signedOut' as const, connected: false, selected: 'provider', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'native-with-provider', acpReady: true, ready: false },
    ])('loads readiness with the picker closed and keeps Start on the exact launch credential: %j', async (scenario) => {
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
        const pendingAcpRead = createDeferred<Response>();
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://credential-launcher.test', accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                    status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: purposeValue } } }));
                if (path === '/v1/account/entity-rows/acp') return scenario.acpReady
                    ? Promise.resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }))
                    : pendingAcpRead.promise;
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
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const agentRequirements = readAccountAgentProviderRequirements(agentTargetKey);
        if (!agentRequirements) throw new Error('Expected real first-party Claude Provider requirements');
        const lmstudio = ProviderContributionV1Schema.parse(LMSTUDIO_PROVIDER_CONTRIBUTION);
        const modelDescriptor = { id: 'local-model', name: 'Local model' };
        const providerGroup = createProviderModelProjectionGroupFixture({
            connectionId: 'pc_lmstudio', providerName: lmstudio.name, connectionName: lmstudio.name,
            suppressedConnectedServiceIds: agentRequirements.authIsolation.suppressConnectedServiceIds,
            rows: [{ ref: { agentTargetKey, providerConnectionId: 'pc_lmstudio', modelId: modelDescriptor.id },
                descriptor: modelDescriptor, sources: { probe: true, manual: false, static: false }, confidence: 'probe',
                compatibility: { ...resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey,
                    endpoints: lmstudio.endpointTemplates, credential: lmstudio.credential, agent: agentRequirements,
                    model: modelDescriptor, adapterVersion: 3 }), confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible' }],
        });
        const providerProjection = createProviderModelProjectionFixture({ agentTargetKey, groups: [providerGroup] });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return providerProjection;
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: Date.now(), data: nativeFacts(scenario.native) } } };
            return { jobs: [] };
        });
        const draftId = `credential-${scenario.native}-${scenario.connected}-${scenario.selected}`;
        if (scenario.selected === 'provider') writeNewSessionDraftToRepository({ scope, draftId, draft: {
            input: 'hello', selectedMachineId: machine.id, selectedPath: '/repo', targetServerId: scope.serverId,
            backendTarget: { kind: 'backend', backendId: 'claude' },
            modelSelection: { v: 1, updatedAt: 1, ref: providerGroup.rows[0]!.ref },
            permissionMode: 'default', updatedAt: 1,
        } });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId }));
        try {
            await vi.waitFor(() => expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)))
                .toMatchObject({ status: 'ready', agents: [{ agentId: 'claude', installed: true }] }));
            await flushHookEffects();
            if (scenario.selected === 'provider') await vi.waitFor(() => {
                expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true);
            });
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
            pendingAcpRead.resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }));
            await hook.unmount();
            await connection.dispose();
            mountedConnection = null;
            bridge.dispose();
        }
    });
});

describe('New Session ACP catalog authority and retained authoring', () => {
    beforeEach(() => {
        // These cases reopen authored drafts, not an explicit Claude route intent.
        Object.assign(authoringRoute, { agentType: undefined, backendTarget: undefined, backendTargetKey: undefined });
    });
    afterEach(() => {
        Object.assign(authoringRoute, { agentType: 'claude', backendTarget: undefined, backendTargetKey: undefined });
    });
    const configuredTarget = { kind: 'agent',
        identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'kiro' } as const;
    const bundledTarget = { kind: 'backend', backendId: 'claude' } as const;
    const pluginTarget = { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } } as const;
    const configuredKey = resolveBackendTargetKeyV2(configuredTarget);
    const bundledKey = resolveBackendTargetKeyV2(bundledTarget);
    const pluginKey = resolveBackendTargetKeyV2(pluginTarget);
    type AcpPhase = 'ready' | 'loading' | 'unavailable';

    async function restoreCatalogAuthoringFixture(input: Readonly<{
        name: string;
        target: PersistedBackendTargetRefV2;
        profile?: 'configured-only' | 'bundled-only';
    }>) {
        await prepareSessionDraftPersistenceStorage();
        mountedBridge = await loadSyncSingletonForTests();
        const accountId = `catalog-authoring-${input.name}`;
        const http = createHomeHubArtifactHttpBoundary(accountId);
        const acpRead = createDeferred<void>();
        let acpPhase: AcpPhase = 'ready';
        let pendingAcpRefresh: Promise<void> | null = null;
        const acpRecord = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'kiro', name: 'kiro', title: 'Configured Kiro', command: 'kiro-cli', args: ['acp'], env: {},
            capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
        }] });
        const profileId = `catalog-profile-${input.name}`;
        const compatibilityByTargetKey = {
            [configuredKey]: input.profile === 'configured-only',
            [bundledKey]: input.profile === 'bundled-only',
            [pluginKey]: false,
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'kiro' })]: false,
        };
        const profileRecord = ProfileRecordV1Schema.parse({ v: 1, id: profileId, enabled: true,
            promptStack: [], secretBindings: {}, definition: { kind: 'inline', profile: {
                v: 2, id: profileId, name: 'Scoped catalog profile', compatibilityByTargetKey,
                preferredAgentTargetKey: input.profile === 'configured-only' ? configuredKey : bundledKey,
                createdAt: 1, updatedAt: 1,
            } },
        });
        const transfer = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1,
                inventory: input.profile ? [{ kind: 'account_row', id: profileId, revision: 1 }] : [] } },
        });
        const profileRows = ProfileRowsListResponseV1Schema.parse({ status: 'listed',
            rows: input.profile ? [{ id: profileId, revision: 1, content: { t: 'plain', v: profileRecord } }] : [],
            complete: true, nextCursor: null, referenceGuardRevision: 1, transferControl: transfer, diagnostics: [],
        });
        const connection = await restoreServerAccountForTest({ serverUrl: `https://${accountId}.test`, accountId,
            request: async (request, init) => {
                const path = new URL(String(request)).pathname;
                if (path === '/v1/features') return Response.json(buildServerFeaturesResponse());
                if (path === '/v2/account/settings') return Response.json({ version: 1,
                    content: { t: 'plain', v: { useProfiles: Boolean(input.profile), useEnhancedSessionWizard: false,
                        lastUsedAgent: 'claude', lastUsedBackendTarget: input.target } } });
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
                    if (acpPhase === 'loading') await acpRead.promise;
                    if (acpPhase === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
                    return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } });
                }
                if (path === PROFILE_ROWS_ROUTE_V1) return Response.json(profileRows);
                if (path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Response.json(ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 1 }));
                if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json(transfer);
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } });
                return http.request(request, init);
            } });
        mountedConnection = connection;
        const scope = { serverId: connection.home.id, accountId };
        storage.setState({ settingsScope: scope, profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId }),
            settings: { ...settingsDefaults, useEnhancedSessionWizard: false, useProfiles: Boolean(input.profile),
                lastUsedAgent: 'claude', lastUsedBackendTarget: input.target } });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId });
        const agentCapabilities = { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' }, isBuiltIn: true,
                title: 'Claude', capabilities: agentCapabilities },
            kiro: { id: 'kiro', identity: { pluginId: 'happier.agent.kiro', localId: 'kiro' }, isBuiltIn: true,
                title: 'Kiro', capabilities: agentCapabilities },
            'acme.review/provider': { id: 'acme.review/provider', identity: pluginTarget.identity,
                title: 'Acme Review', capabilities: agentCapabilities },
        } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries(
                Object.keys(projection.agentsById).map(agentId => [`cli.${agentId}`, { ok: true, checkedAt: Date.now(), data: nativeFacts('signedIn') }]),
            ) };
            return { jobs: [] };
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored catalog authoring Account');
        await Promise.all([refreshAcpCatalog(scope), refreshProfileCatalog(scope),
            refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime })]);
        expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('ready');
        expect(getProfileCatalogSnapshot(scope)?.catalog.status).toBe('ready');
        const inputs = readCachedDaemonMergedProjectionCacheEntry({ serverId: scope.serverId, machineId: machine.id });
        if (inputs?.kind !== 'ready') throw new Error('Expected real ready daemon projection fixture');
        expect(getResolvedBackendCatalogEntries({ enabledAgentIds: Object.keys(projection.agentsById),
            acpCatalogSnapshot: getAcpCatalogSnapshot(scope)?.catalog,
            mergedProviderProjectionById: inputs.inputs.mergedProviderProjectionById,
            mergedBackendProjectionById: inputs.inputs.mergedBackendProjectionById,
            discoveredBackendIds: inputs.inputs.discoveredBackendIds,
        }).map(entry => entry.backendTargetKey)).toContain(configuredKey);
        const draftId = `catalog-draft-${input.name}`;
        writeNewSessionDraftToRepository({ scope, draftId, draft: { input: 'hello', selectedMachineId: machine.id,
            selectedPath: '/repo', targetServerId: scope.serverId, backendTarget: input.target,
            selectedProfileId: input.profile ? profileId : null, selectedSecretId: null,
            permissionMode: 'default', updatedAt: 1 } });
        return {
            scope, draftId, profileId,
            async withdraw(phase: Exclude<AcpPhase, 'ready'>) {
                acpPhase = phase;
                await act(async () => {
                    const refreshing = refreshAcpCatalog(scope);
                    if (phase === 'loading') pendingAcpRefresh = refreshing;
                    else await refreshing;
                });
                await vi.waitFor(() => expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe(phase));
            },
            async restoreReady() {
                acpPhase = 'ready';
                acpRead.resolve();
                await pendingAcpRefresh;
                await refreshAcpCatalog(scope);
            },
        };
    }

    it.each(['loading', 'unavailable'] as const)('retains the configured target and configured-only Profile while ACP is %s', async (phase) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `configured-${phase}`, target: configuredTarget, profile: 'configured-only' });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        const assertAuthoredSelection = () => {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            expect(model.simpleProps.agentPickerSelectedOptionId).toBe(configuredKey);
            expect(model.simpleProps.selectedProfileId).toBe(fixture.profileId);
            const draft = readNewSessionDraftFromRepository(fixture);
            expect(draft?.selectedProfileId).toBe(fixture.profileId);
            return model;
        };
        try {
            await vi.waitFor(() => { expect(assertAuthoredSelection().simpleProps.canCreate).toBe(true); });
            await fixture.withdraw(phase);
            await flushHookEffects();
            expect(assertAuthoredSelection().simpleProps.canCreate).toBe(false);
            await act(async () => { await fixture.restoreReady(); });
            await vi.waitFor(() => { expect(assertAuthoredSelection().simpleProps.canCreate).toBe(true); });
            const draft = readNewSessionDraftFromRepository(fixture);
            expect(draft?.backendTarget && resolveBackendTargetKeyV2(draft.backendTarget)).toBe(configuredKey);
        } finally { await fixture.restoreReady(); await hook.unmount(); }
    });

    it.each(['loading', 'unavailable'] as const)('reopens the configured draft and Profile while ACP starts %s', async (phase) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `reopened-${phase}`, target: configuredTarget, profile: 'configured-only' });
        await fixture.withdraw(phase);
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            const assertRetainedDraft = () => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.agentPickerSelectedOptionId, JSON.stringify({
                    remembered: storage.getState().settings.lastUsedBackendTarget,
                    draft: readNewSessionDraftFromRepository(fixture)?.agentTarget,
                    picker: model.simpleProps.agentPickerOptions?.map(option => option.id),
                })).toBe(configuredKey);
                expect(model.simpleProps.selectedProfileId).toBe(fixture.profileId);
                const draft = readNewSessionDraftFromRepository(fixture);
                expect(draft?.input).toBe('hello');
                expect(draft?.selectedProfileId).toBe(fixture.profileId);
                return model;
            };
            await vi.waitFor(() => expect(assertRetainedDraft().simpleProps.canCreate).toBe(false));
            await act(async () => { await fixture.restoreReady(); });
            await vi.waitFor(() => expect(assertRetainedDraft().simpleProps.canCreate).toBe(true));
            const draft = readNewSessionDraftFromRepository(fixture);
            expect(draft?.backendTarget && resolveBackendTargetKeyV2(draft.backendTarget)).toBe(configuredKey);
        } finally { await fixture.restoreReady(); await hook.unmount(); }
    });

    it('honors an explicit bundled route over a remembered configured target while ACP is loading', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'bundled-route', target: configuredTarget });
        await fixture.withdraw('loading');
        authoringRoute.backendTargetKey = bundledKey;
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.agentPickerSelectedOptionId, JSON.stringify({
                    remembered: storage.getState().settings.lastUsedBackendTarget,
                    picker: model.simpleProps.agentPickerOptions?.map(option => option.id),
                })).toBe(bundledKey);
                expect(model.simpleProps.canCreate).toBe(true);
            });
        } finally { await fixture.restoreReady(); await hook.unmount(); }
    });

    it.each([
        { name: 'bundled-loading', target: bundledTarget, key: bundledKey, agentId: 'claude', phase: 'loading' as const },
        { name: 'bundled-unavailable', target: bundledTarget, key: bundledKey, agentId: 'claude', phase: 'unavailable' as const },
        { name: 'plugin-loading', target: pluginTarget, key: pluginKey, agentId: 'acme.review/provider', phase: 'loading' as const },
        { name: 'plugin-unavailable', target: pluginTarget, key: pluginKey, agentId: 'acme.review/provider', phase: 'unavailable' as const },
    ])('keeps $name Start and authored draft independent of ACP authority', async (scenario) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: scenario.name, target: scenario.target });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            await fixture.withdraw(scenario.phase);
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.agentPickerSelectedOptionId).toBe(scenario.key);
                expect(model.simpleProps.agentType).toBe(scenario.agentId);
                expect(model.simpleProps.canCreate).toBe(true);
                const draft = readNewSessionDraftFromRepository(fixture);
                expect(draft?.input).toBe('hello');
                const target = draft?.agentTarget ?? draft?.backendTarget;
                expect(target && resolveBackendTargetKeyV2(target)).toBe(scenario.key);
            });
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            const { NewSessionSimplePanel } = await import('../components/NewSessionSimplePanel');
            const screen = await renderScreen(<NewSessionSimplePanel {...model.simpleProps} />);
            try { expect(screen.findByTestId('new-session-composer-send')?.props.accessibilityState).toMatchObject({ disabled: false }); }
            finally { await screen.unmount(); }
        } finally { await fixture.restoreReady(); await hook.unmount(); }
    });

    it('reconciles a genuinely incompatible Profile only against complete ready ACP authority', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'ready-incompatible', target: configuredTarget, profile: 'bundled-only' });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.selectedProfileId).toBe(fixture.profileId);
                expect(model.simpleProps.agentPickerSelectedOptionId).toBe(bundledKey);
                expect(model.simpleProps.canCreate).toBe(true);
                const draft = readNewSessionDraftFromRepository(fixture);
                expect(draft?.selectedProfileId).toBe(fixture.profileId);
                expect(draft?.backendTarget && resolveBackendTargetKeyV2(draft.backendTarget)).toBe(bundledKey);
            });
        } finally { await hook.unmount(); }
    });
});
