import { rememberLastUsedBackendSelection, readLastUsedBackendSelection } from '@/sync/domains/state/newSessionTargetUiState';
import 'fake-indexeddb/auto';
import * as React from 'react';
import { Modal } from '@/modal';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { NewSessionPathSelectionContentProps } from '../components/NewSessionPathSelectionContent';
import { createDeferred, createMachineFixture, createPlainMachineRowFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
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
import { refreshMachineAgents, useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { getSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { NewSessionDraft } from '@/sync/domains/state/persistence';
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
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { resolveActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';
import { LMSTUDIO_PROVIDER_CONTRIBUTION } from '../../../../../../../packages/plugins/lmstudio/src/provider/contribution';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { randomUUID } from '@/platform/randomUUID';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { applyTeamProjection, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

// Only platform/navigation, secure storage, HTTP, Socket.IO and machine RPC
// boundaries are replaced. The complete launcher and all domain owners stay real.
const authoringRoute = vi.hoisted(() => ({
    prompt: 'hello' as string | undefined,
    machineId: 'credential-devbox' as string | undefined,
    agentType: 'claude' as string | undefined,
    directory: '/repo' as string | undefined,
    backendTarget: undefined as string | undefined,
    backendTargetKey: undefined as string | undefined,
    dataId: undefined as string | undefined,
}));
installNewSessionScreenModelCommonModuleMocks({ storage: async (importOriginal) => importOriginal(),
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    routerConfig: { pathname: '/new', params: () => ({ ...authoringRoute }) } });
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
const connectedDescriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({
    id: 'claude-subscription', serviceId: 'claude-subscription', pluginId: service.pluginId,
    provenance: 'first_party', sourceKind: 'bundled', title: 'Claude subscription',
    authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
        pkce: 'required', callbackUrl: 'https://platform.claude.com/oauth/code/callback', outcomeReconciliation: 'none' }] },
    capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
});
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
    resetTeamsSnapshotsForTests();
    rpc.mockReset(); storage.setState(initialState, true); authoringRoute.directory = '/repo'; authoringRoute.machineId = 'credential-devbox'; authoringRoute.dataId = undefined; authoringRoute.prompt = 'hello'; });

describe('New Session selected credential launch gate', () => {
    it.each(['connected', 'native'] as const)('reconciles a closed native catalog only for the %s model source', async (source) => {
        await prepareSessionDraftPersistenceStorage();
        mountedBridge = await loadSyncSingletonForTests();
        const accountId = `credential-model-source-${source}`;
        const museService = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const modelId = 'meta/muse-spark-1.3-contributor';
        const profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{
            ref: { service: museService, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
            status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
            displayName: 'Muse', providerIdentity: {}, expiresAt: null,
        }] });
        const http = createHomeHubArtifactHttpBoundary(accountId, profile, {
            machines: [createPlainMachineRowFixture({ id: 'credential-devbox', accountId })],
        });
        const features = buildServerFeaturesResponse();
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const purposeValue = { v: 1 as const, bindings: [] };
        const acpRecord = { v: 1 as const, definitions: [] };
        mountedConnection = await restoreServerAccountForTest({ serverUrl: `https://${accountId}.test`, accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (path === '/v2/account/settings') return Promise.resolve(Response.json({ version: 1,
                    content: { t: 'plain', v: { useEnhancedSessionWizard: true, lastUsedAgent: 'codex' } } }));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                    status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: purposeValue } } }));
                if (path === '/v1/account/entity-rows/acp') return Promise.resolve(Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: acpRecord } }));
                return http.request(input, init);
            } });
        const scope = { serverId: mountedConnection.home.id, accountId };
        rememberLastUsedBackendSelection(scope, { lastUsedAgent: 'codex', lastUsedBackendTarget: null });
        storage.setState({ profileScope: scope, settingsScope: scope, profile,
            settings: { ...settingsDefaults, lastUsedAgent: 'codex', useEnhancedSessionWizard: true } });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: purposeValue } }, true);
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: acpRecord }, true);
        const { BUNDLED_CANONICAL_AGENT_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
        const codex = BUNDLED_CANONICAL_AGENT_DECLARATIONS.codex;
        const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({ ...connectedDescriptor,
            id: 'muse-account', serviceId: 'muse-account', pluginId: museService.pluginId, title: 'Muse' });
        installConnectedAccountDescriptorProjection({ scopeKey: accountId, status: 'ready', conflicts: [], errorReason: null,
            descriptors: [descriptor] });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                'happier.agent.muse/muse-account': descriptor,
            } } }, agentsById: { codex: { id: 'codex', identity: codex.identity, title: 'Codex', isBuiltIn: true,
                providerRequirements: codex.providerRequirements,
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                connectedAccounts: codex.connectedAccounts.map(purpose => ({ ...purpose,
                    service: typeof purpose.service === 'string' ? { pluginId: codex.identity.pluginId, localId: purpose.service } : purpose.service })),
            } } });
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { method?: string } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.codex': {
                ok: true, checkedAt: Date.now(), data: nativeFacts('signedIn'),
            } } };
            if (method === 'capabilities.invoke' && payload?.method === 'probeModels') return { ok: true, result: {
                source: 'dynamic', availableModels: [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }], supportsFreeform: false,
            } };
            if (method === 'capabilities.invoke' && payload?.method === 'probeConfigOptions') return { ok: true, result: {
                source: 'dynamic', configOptions: [],
            } };
            return { jobs: [] };
        });
        authoringRoute.agentType = 'codex';
        const draftId = randomUUID();
        writeNewSessionDraftToRepository({ scope, draftId, draft: {
            input: 'hello', selectedMachineId: machine.id, selectedPath: '/repo', targetServerId: scope.serverId,
            agentType: 'codex', selectedProfileId: null, selectedSecretId: null,
            backendTarget: { kind: 'backend', backendId: 'codex' }, permissionMode: 'default', modelMode: 'default', updatedAt: 1,
            backendNewSessionOptionStateByTargetKey: source === 'connected' ? { [agentTargetKey]: { connectedServices: {
                v: 2, bindingsByServiceId: { 'happier.agent.muse/muse-account': {
                    source: 'connected', selection: 'profile', profileId: 'work',
                } },
            } } } : {},
        } });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId }));
        try {
            await vi.waitFor(async () => {
                await flushHookEffects();
                const model = hook.getCurrent();
                if (model.variant !== 'wizard') throw new Error('Expected the enhanced launcher');
                expect(model.wizardProps.agent.modelOptions.some(option => option.value === 'gpt-6-luna')).toBe(true);
            });
            const model = hook.getCurrent();
            if (model.variant !== 'wizard') throw new Error('Expected the enhanced launcher');
            const selection = { v: 1 as const, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId } };
            await act(async () => {
                model.wizardProps.agent.setModelSelection?.(selection);
                model.wizardProps.agent.setAcpConfigOptionOverride?.('reasoning_effort', 'minimal');
            });
            await flushHookEffects();
            const selected = hook.getCurrent();
            if (selected.variant !== 'wizard') throw new Error('Expected the enhanced launcher');
            expect(selected.wizardProps.agent.modelMode).toBe(source === 'connected' ? modelId : 'default');
            if (source === 'connected') {
                expect(selected.wizardProps.agent.modelSelection?.ref).toEqual(selection.ref);
                expect(selected.wizardProps.agent.acpConfigOptionOverrides?.overrides.reasoning_effort?.value).toBe('minimal');
            }
        } finally { await hook.unmount(); authoringRoute.agentType = 'claude'; }
    });

    it('does not probe native suggestions after inherited purpose authority withdraws', async () => {
        await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        mountedBridge = bridge;
        const accountId = 'credential-suggestions';
        const profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{
            ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
            status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
            displayName: 'Work', providerIdentity: {}, expiresAt: null,
        }] });
        const http = createHomeHubArtifactHttpBoundary(accountId, profile, {
            machines: [createPlainMachineRowFixture({ id: 'credential-devbox', accountId })],
        });
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
        rememberLastUsedBackendSelection(scope, { lastUsedAgent: 'claude', lastUsedBackendTarget: null });
        storage.setState({ profileScope: scope, settingsScope: scope,
            settings: { ...settingsDefaults, lastUsedAgent: 'claude', useEnhancedSessionWizard: false },
            profile });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: connection.home.id });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1,
            record: { key: 'purposes', value: purposeValue } }, true);
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: acpRecord }, true);
        installConnectedAccountDescriptorProjection({ scopeKey: 'credential-suggestions', status: 'ready', conflicts: [], errorReason: null,
            descriptors: [connectedDescriptor] });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                'happier.agent.claude/claude-subscription': connectedDescriptor,
            } } }, agentsById: { claude: {
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
        let renders = 0;
        const hook = await renderHook(() => {
            if (++renders > 100) throw new Error('New Session suggestion host did not settle within 100 renders');
            return useNewSessionScreenModel({ draftId: 'credential-suggestions' });
        });
        try {
            const published: string[] = [];
            await vi.waitFor(async () => {
                await flushHookEffects();
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                await act(async () => {
                    await resolveActiveSuggestionsHandler(model.simpleProps.emptyAutocompleteSuggestions, '/project')('/project', new AbortController().signal,
                        rows => published.push(...rows.map(row => row.text)));
                });
                expect(probes).toEqual([expect.objectContaining({ connectedServices: expect.objectContaining({
                    bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' } },
                }) })]);
                expect(published).toContain('/project-check');
            });
            probes.length = 0;
            withdrawn = true;
            await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', {
                status: 'unavailable', reason: 'forbidden',
            }, true); });
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            await act(async () => { await resolveActiveSuggestionsHandler(model.simpleProps.emptyAutocompleteSuggestions, '/project')('/project', new AbortController().signal, () => {}); });
            await flushHookEffects();
            expect(probes).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it.each([
        { native: 'signedOut' as const, connected: true, selected: 'native', acpReady: true, ready: false },
        { native: 'signedIn' as const, connected: true, selected: 'native', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: true, selected: 'connected', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: true, selected: 'connected-late', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: true, selected: 'connected-late-edited', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'native', acpReady: true, ready: false },
        { native: 'signedIn' as const, connected: true, selected: 'native', acpReady: false, ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'provider', acpReady: true, ready: true },
        { native: 'signedOut' as const, connected: false, selected: 'native-with-provider', acpReady: true, ready: false },
        { native: 'signedOut' as const, connected: false, selected: 'provider-unconfirmed', acpReady: true, ready: false },
        { native: 'signedOut' as const, connected: false, selected: 'provider-unavailable', acpReady: true, ready: false },
    ])('loads readiness with the picker closed and keeps Start on the exact launch credential: %j', async (scenario) => {
        await prepareSessionDraftPersistenceStorage();
        const bridge = await loadSyncSingletonForTests();
        const accountId = `credential-launcher-${scenario.native}-${scenario.connected}-${scenario.selected}-${scenario.acpReady}`;
        const profile = AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: scenario.connected ? [{
            ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
            status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
            displayName: 'Work', providerIdentity: {}, expiresAt: null,
        }] : [] });
        const http = createHomeHubArtifactHttpBoundary(accountId, profile, {
            machines: [createPlainMachineRowFixture({ id: 'credential-devbox', accountId })],
        });
        const features = buildServerFeaturesResponse();
        features.features.providers.enabled = true;
        features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const purposeValue = { v: 1 as const, bindings: [] };
        const acpRecord = { v: 1 as const, definitions: [] };
        const lateDraft = scenario.selected.startsWith('connected-late');
        const editedLateDraft = scenario.selected === 'connected-late-edited';
        const profileId = 'credential-late-profile';
        const profileRecord = ProfileRecordV1Schema.parse({ v: 1, id: profileId, enabled: true,
            promptStack: [], secretBindings: {}, definition: { kind: 'inline', profile: {
                v: 2, id: profileId, name: 'Draft profile', compatibilityByTargetKey: { 'agent:happier.agent.claude/claude': true },
                preferredAgentTargetKey: 'agent:happier.agent.claude/claude', createdAt: 1, updatedAt: 1,
            } },
        });
        const profileTransfer = ProfileTransferRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1,
                inventory: [{ kind: 'account_row', id: profileId, revision: 1 }] } },
        });
        const pendingAcpRead = createDeferred<Response>();
        const connection = await restoreServerAccountForTest({ serverUrl: `https://${accountId}.test`, accountId,
            request: (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Promise.resolve(Response.json(features));
                if (lateDraft && path === '/v2/account/settings') return Promise.resolve(Response.json({ version: 1,
                    content: { t: 'plain', v: { useProfiles: true, useEnhancedSessionWizard: false, lastUsedAgent: 'claude' } } }));
                if (lateDraft && path === PROFILE_ROWS_ROUTE_V1) return Promise.resolve(Response.json(ProfileRowsListResponseV1Schema.parse({
                    status: 'listed', rows: [{ id: profileId, revision: 1, content: { t: 'plain', v: profileRecord } }],
                    complete: true, nextCursor: null, referenceGuardRevision: 1, transferControl: profileTransfer, diagnostics: [],
                })));
                if (lateDraft && path === PROFILE_REFERENCE_GUARD_ROUTE_V1) return Promise.resolve(Response.json(
                    ProfileReferenceGuardReadResponseV1Schema.parse({ status: 'ready', revision: 1 })));
                if (lateDraft && path === PROFILE_TRANSFER_ROUTE_V1) return Promise.resolve(Response.json(profileTransfer));
                if (path === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(Response.json({
                    status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: purposeValue } } }));
                if (path === '/v1/account/entity-rows/acp') return scenario.acpReady
                    ? Promise.resolve(Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } }))
                    : pendingAcpRead.promise;
                return http.request(input, init);
            } });
        const scope = { serverId: connection.home.id, accountId };
        mountedConnection = connection;
        rememberLastUsedBackendSelection(scope, { lastUsedAgent: 'claude', lastUsedBackendTarget: null });
        storage.setState({ profileScope: scope, settingsScope: scope, settings: { ...settingsDefaults, lastUsedAgent: 'claude', useEnhancedSessionWizard: false, useProfiles: lateDraft },
            profile });
        const machine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        storage.getState().applyMachines([machine], false, { sourceServerId: connection.home.id });
        applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 1, record: { key: 'purposes', value: purposeValue } }, true);
        applyAcpCatalogSnapshot(scope, scenario.acpReady
            ? { status: 'ready', revision: 1, record: acpRecord }
            : { status: 'loading' }, true);
        installConnectedAccountDescriptorProjection({ scopeKey: 'credential-launcher', status: 'ready', conflicts: [], errorReason: null,
            descriptors: [connectedDescriptor] });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: {
                'happier.agent.claude/claude-subscription': connectedDescriptor,
            } } }, agentsById: { claude: {
            id: 'claude', identity: consumer, isBuiltIn: true, title: 'Claude', connectedAccounts: [declaration],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const agentRequirements = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' });
        if (!agentRequirements) throw new Error('Expected real first-party Claude Provider requirements');
        const lmstudio = ProviderContributionV1Schema.parse(LMSTUDIO_PROVIDER_CONTRIBUTION);
        const modelDescriptor = { id: 'local-model', name: 'Local model' };
        const providerGroup = createProviderModelProjectionGroupFixture({
            connectionId: 'pc_lmstudio', providerName: lmstudio.name, connectionName: lmstudio.name,
            authorization: scenario.selected === 'provider-unavailable'
                ? { authorized: false, error: createProviderErrorV1('provider_not_enabled_on_machine') }
                : { authorized: true },
            suppressedConnectedServiceIds: agentRequirements.authIsolation.suppressConnectedServiceIds,
            rows: [{ ref: { agentTargetKey, providerConnectionId: 'pc_lmstudio', modelId: modelDescriptor.id },
                descriptor: modelDescriptor, sources: { probe: true, manual: false, static: false }, confidence: 'probe',
                compatibility: { ...resolveProviderBindingCompatibilityWithFingerprintV1({ agentTargetKey,
                    endpoints: lmstudio.endpointTemplates, credential: lmstudio.credential, agent: agentRequirements,
                    model: modelDescriptor, adapterVersion: 3 }), confirmed: scenario.selected !== 'provider-unconfirmed' },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible' }],
        });
        const providerProjection = createProviderModelProjectionFixture({ agentTargetKey, groups: [providerGroup] });
        let nativeStatus = scenario.native;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION) return providerProjection;
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.claude': { ok: true, checkedAt: Date.now(), data: nativeFacts(nativeStatus) } } };
            return { jobs: [] };
        });
        const draftId = randomUUID();
        const connectedDraft = {
            input: 'hello', selectedMachineId: machine.id, selectedPath: '/repo', targetServerId: scope.serverId,
            agentType: 'claude', acpSessionModeId: null, selectedProfileId: null, selectedSecretId: null,
            backendTarget: { kind: 'backend', backendId: 'claude' }, permissionMode: 'default', updatedAt: 1,
            // The configuration-seed adapter produces this canonical envelope.
            backendNewSessionOptionStateByTargetKey: { [agentTargetKey]: { connectedServices: {
                v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': {
                    source: 'connected', selection: 'profile', profileId: 'work',
                } },
            } } },
        } satisfies NewSessionDraft;
        if (scenario.selected === 'connected') writeNewSessionDraftToRepository({ scope, draftId, draft: connectedDraft });
        if (lateDraft) {
            // The route supplies no new folder intent during persisted recovery.
            authoringRoute.directory = undefined;
            await refreshProfileCatalog(scope);
        }
        if (scenario.selected.startsWith('provider') || scenario.selected === 'native-with-provider') writeNewSessionDraftToRepository({ scope, draftId, draft: {
            input: 'hello', selectedMachineId: machine.id, selectedPath: '/repo', targetServerId: scope.serverId,
            agentType: 'claude', acpSessionModeId: null, selectedProfileId: null, selectedSecretId: null,
            backendTarget: { kind: 'backend', backendId: 'claude' },
            modelSelection: { v: 1, updatedAt: 1, ref: scenario.selected.startsWith('provider')
                ? providerGroup.rows[0]!.ref : { agentTargetKey, providerConnectionId: null, modelId: 'default' } },
            permissionMode: 'default', updatedAt: 1,
        } });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId }));
        try {
            await vi.waitFor(() => expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)))
                .toMatchObject({ status: 'ready', agents: [{ agentId: 'claude', installed: true }] }));
            await flushHookEffects();
            if (lateDraft) {
                const cold = hook.getCurrent();
                if (cold.variant !== 'simple') throw new Error('Expected cold simple launcher');
                expect(cold.simpleProps.canCreate).toBe(false);
                if (editedLateDraft) {
                    // The blocker is the composer's status line: its primary action is the one-tap connected account.
                    expect(cold.simpleProps.connectionStatus?.action?.testID).toBe('new-session-agent-blocker.connected');
                    await act(async () => { cold.simpleProps.connectionStatus?.action?.onPress(); });
                    await vi.waitFor(() => {
                        const edited = hook.getCurrent();
                        if (edited.variant !== 'simple') throw new Error('Expected edited simple launcher');
                        expect(edited.simpleProps.canCreate).toBe(true);
                    });
                }
                // The real repository publishes a late scoped draft, as after a cold
                // Account restore. No reader, subscription or autosave is replaced.
                const restoredDraft = { ...connectedDraft, selectedPath: '/repo/late', selectedProfileId: profileId,
                    modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: 'haiku' } },
                    backendNewSessionOptionStateByTargetKey: {
                        ...(editedLateDraft ? { [agentTargetKey]: { connectedServices: {
                            v: 2, bindingsByServiceId: { 'happier.agent.claude/claude-subscription': { source: 'native' } },
                        } } } : connectedDraft.backendNewSessionOptionStateByTargetKey),
                        'agent:happier.agent.codex/codex': { reasoningEffort: 'low' },
                    },
                } satisfies NewSessionDraft;
                vi.useFakeTimers();
                await act(async () => { writeNewSessionDraftToRepository({ scope, draftId, draft: restoredDraft }); });
                await flushHookEffects();
                await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
                const saved = readNewSessionDraftFromRepository({ scope, draftId });
                expect(saved).toMatchObject({ selectedPath: '/repo/late', selectedProfileId: profileId,
                    modelSelection: { ref: { modelId: 'haiku' } },
                    ...(editedLateDraft ? { backendNewSessionOptionStateByTargetKey: {
                        [agentTargetKey]: { connectedServicesBindingsByServiceId: {
                            'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' },
                        } }, 'agent:happier.agent.codex/codex': { reasoningEffort: 'low' },
                    } } : { backendNewSessionOptionStateByTargetKey: restoredDraft.backendNewSessionOptionStateByTargetKey }) });
                const hydrated = hook.getCurrent();
                if (hydrated.variant !== 'simple') throw new Error('Expected hydrated simple launcher');
                expect(hydrated.simpleProps.canCreate, JSON.stringify({
                    statusBadges: hydrated.simpleProps.statusBadges,
                    selectedMachineId: hydrated.simpleProps.selectedMachineId,
                    agentType: hydrated.simpleProps.agentType,
                    inventory: machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)),
                })).toBe(true);
                await hook.unmount();
                // Flush device storage, discard the repository's in-memory replicas,
                // and reopen through the same real persisted reader used on reload.
                const draftStorage = getSessionDraftPersistenceStorage();
                if ('flush' in draftStorage) await draftStorage.flush();
                resetSessionDraftRepositoryForTests();
                vi.useRealTimers();
                const reopened = await renderHook(() => useNewSessionScreenModel({ draftId }));
                try {
                    await flushHookEffects();
                    const restored = reopened.getCurrent();
                    if (restored.variant !== 'simple') throw new Error('Expected restored simple launcher');
                    expect(restored.simpleProps.canCreate).toBe(true);
                    expect(restored.simpleProps.selectedPath).toBe('/repo/late');
                    expect(restored.simpleProps.selectedProfileId).toBe(profileId);
                    expect(restored.simpleProps.modelMode).toBe('haiku');
                    const { NewSessionSimplePanel } = await import('../components/NewSessionSimplePanel');
                    const panel = await renderScreen(<NewSessionSimplePanel {...restored.simpleProps} />);
                    try { expect(panel.findByTestId('new-session-composer-send')?.props.accessibilityState)
                        .toMatchObject({ disabled: false }); } finally { await panel.unmount(); }
                } finally { await reopened.unmount(); }
                return;
            }
            if (scenario.selected.startsWith('provider')) await vi.waitFor(() => {
                expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION)).toBe(true);
                const current = hook.getCurrent();
                if (current.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(current.simpleProps.agentInputExtraActionChips?.some(chip =>
                    chip.collapsedContentPopover?.label?.includes(lmstudio.name))).toBe(true);
            });
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            const observedAdmission = JSON.stringify({
                purpose: getConnectedAccountCatalogValue(scope, 'purposes'), acp: getAcpCatalogSnapshot(scope),
                inventory: machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id)),
                projection: readCachedDaemonMergedProjectionCacheEntry({ serverId: scope.serverId, machineId: machine.id })?.kind,
                profileScope: storage.getState().profileScope, selectedMachineId: model.simpleProps.selectedMachineId,
                agentType: model.simpleProps.agentType,
                statusBadges: model.simpleProps.statusBadges,
            });
            expect(model.simpleProps.canCreate, observedAdmission).toBe(scenario.ready);
            expect(model.simpleProps.agentPickerOptions?.find(option => option.id === agentTargetKey)?.disabled).toBe(false);
            // An installed signed-out executable still offers its model/source
            // detail, so the Provider credential can actually be selected.
            expect(model.simpleProps.agentPickerOptions?.find(option => option.id === agentTargetKey)?.onSelectImmediate)
                .toBeTypeOf('function');
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
            expect(Boolean(model.simpleProps.connectionStatus?.text),
                observedAdmission).toBe(!scenario.ready);
            // Unknown Provider admission uses the status line, not a native
            // sign-in recovery line that cannot admit the selected route.
            expect(model.simpleProps.connectionStatus?.action?.testID?.startsWith('new-session-agent-blocker.') === true, observedAdmission)
                .toBe(!scenario.ready && !scenario.selected.startsWith('provider'));
            if (scenario.native === 'signedOut' && !scenario.connected && scenario.selected === 'native') {
                // Sign in opens the Agent's own chooser where the person is (owner, 2026-11-05), never another page.
                const shown = vi.spyOn(Modal, 'show');
                await act(async () => { model.simpleProps.connectionStatus?.action?.onPress(); });
                expect(shown).toHaveBeenCalledTimes(1);
                expect(shown.mock.calls[0]![0].props).toMatchObject({ target: { agent: { agentId: 'claude' }, machineId: machine.id } });
                Modal.hide(shown.mock.results[0]!.value as string);
                shown.mockRestore();
                const inventory = await renderHook(() => useMachineAgents({
                    serverId: scope.serverId, machineId: machine.id, load: false,
                }));
                try {
                    // Use the same explicit refresh as Machine Agents' Check again after native
                    // auth changes; passive inventory reads may reuse the five-minute auth cache.
                    // Picker eligibility stays true and cannot substitute for credential admission.
                    for (const status of ['signedIn', 'signedOut'] as const) {
                        nativeStatus = status;
                        await act(async () => { await inventory.getCurrent().refresh(); });
                        await vi.waitFor(() => {
                            const current = hook.getCurrent();
                            if (current.variant !== 'simple') throw new Error('Expected refreshed simple launcher');
                            expect(current.simpleProps.canCreate).toBe(status === 'signedIn');
                            expect(Boolean(current.simpleProps.connectionStatus?.text)).toBe(status === 'signedOut');
                            expect(current.simpleProps.connectionStatus?.action?.testID)
                                .toBe(status === 'signedOut' ? 'new-session-agent-blocker.action' : undefined);
                            expect(current.simpleProps.agentPickerOptions?.find(option => option.id === agentTargetKey)?.disabled).toBe(false);
                        });
                    }
                } finally { await inventory.unmount(); }
            }
            if (!scenario.ready && scenario.connected) {
                await act(async () => { model.simpleProps.connectionStatus?.action?.onPress(); });
                await act(async () => { await flushHookEffects(); });
                const recovered = hook.getCurrent();
                if (recovered.variant !== 'simple') throw new Error('Expected recovered simple launcher');
                expect(recovered.simpleProps.canCreate).toBe(true);
                expect(recovered.simpleProps.connectionStatus?.text).toBeFalsy();
                if (scenario.selected === 'native' && scenario.native === 'signedOut') {
                    const authoredPath = '/repo/authored-before-send';
                    const renderPathContent = recovered.simpleProps.pathPopover?.renderContent;
                    const pathContent = typeof renderPathContent === 'function'
                        ? renderPathContent({ requestClose: () => {}, maxHeight: 600 }) : renderPathContent;
                    if (!React.isValidElement<NewSessionPathSelectionContentProps>(pathContent)) {
                        throw new Error('Expected the real folder picker');
                    }
                    await act(async () => {
                        // Route text is passive hydration; a real text edit
                        // materializes the new draft before autosave/Send.
                        recovered.simpleProps.promptStore.setPrompt('hello authored before send');
                        pathContent.props.onChangeSelectedPath(authoredPath);
                        recovered.simpleProps.setModelMode?.('haiku');
                    });
                    await act(async () => {
                        const lifetime = captureActiveServerAccountScopeLifetime();
                        if (!lifetime) throw new Error('Expected the current credential Account');
                        await refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id,
                            accountLifetime: lifetime });
                    });
                    const refreshed = hook.getCurrent();
                    if (refreshed.variant !== 'simple') throw new Error('Expected refreshed simple launcher');
                    expect(refreshed.simpleProps.canCreate).toBe(true);
                    expect(refreshed.simpleProps.selectedPath).toBe(authoredPath);
                    expect(refreshed.simpleProps.modelMode).toBe('haiku');
                    await vi.waitFor(() => expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
                        selectedPath: authoredPath, modelSelection: { ref: { modelId: 'haiku' } },
                    }));
                    await act(async () => { await refreshed.simpleProps.handleCreateSession(); });
                    const submitted = readNewSessionDraftFromRepository({ scope, draftId });
                    expect(submitted).toMatchObject({ selectedPath: authoredPath,
                        modelSelection: { ref: { modelId: 'haiku' } },
                        backendNewSessionOptionStateByTargetKey: {
                            [agentTargetKey]: { connectedServicesBindingsByServiceId: {
                                'happier.agent.claude/claude-subscription': { source: 'connected', profileId: 'work' },
                            } },
                        },
                    });
                    await hook.unmount();
                    // Reopening the stored draft carries no new folder intent.
                    authoringRoute.directory = undefined;
                    const reopened = await renderHook(() => useNewSessionScreenModel({ draftId }));
                    try {
                        await flushHookEffects();
                        const restored = reopened.getCurrent();
                        if (restored.variant !== 'simple') throw new Error('Expected reopened simple launcher');
                        expect(restored.simpleProps.canCreate).toBe(true);
                        expect(restored.simpleProps.selectedPath).toBe(authoredPath);
                        expect(restored.simpleProps.modelMode).toBe('haiku');
                    } finally { await reopened.unmount(); }
                }
            }
        } finally {
            vi.useRealTimers();
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
        seedDraft?: boolean;
        rememberedProfile?: 'missing' | 'available';
        definitionInventory?: boolean;
        includeCodex?: boolean;
        serverIdentityId?: string;
        isolated?: boolean;
        profilesPresentationEnabled?: boolean;
        seedProfile?: boolean;
        actionDefault?: NewSessionDraft['actionDefault'];
        actionsSettings?: import('@happier-dev/protocol/actions/actionSettings').ActionsSettingsV1;
        credentials?: import('@/auth/storage/tokenStorage').AuthCredentials;
        externalActionRequest?: (request: URL, init?: RequestInit) => Promise<Response | null>;
    }>) {
        await prepareSessionDraftPersistenceStorage();
        mountedBridge = await loadSyncSingletonForTests();
        const accountId = `catalog-authoring-${input.name}`;
        const baseMachine = createMachineFixture({ id: 'credential-devbox', activeAt: Date.now() });
        const machine: Machine = input.isolated ? { ...baseMachine, isShared: false, metadata: { ...baseMachine.metadata!,
            platform: 'linux', agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } } : baseMachine;
        const http = createHomeHubArtifactHttpBoundary(accountId, undefined, {
            machines: [createPlainMachineRowFixture({ id: machine.id, accountId, machine })],
        });
        const authoringMemory = createAuthoringMemoryHttpBoundary();
        let accountSettingsWrites = 0;
        const acpRead = createDeferred<void>();
        let acpPhase: AcpPhase = 'ready';
        let pendingAcpRefresh: Promise<void> | null = null;
        const acpRecord = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: 'kiro', name: 'kiro', title: 'Configured Kiro', launch: { kind: 'command' as const, command: 'kiro-cli', args: ['acp'] }, env: {},
            capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
                supportsConfigOptions: 'unknown', promptImageSupport: 'unknown' }, createdAt: 1, updatedAt: 1,
        }] });
        if (input.definitionInventory) {
            acpRecord.definitions[0]!.launch = { kind: 'uv', package: 'kiro-acp', version: '1', args: [] };
            acpRecord.definitions.push({ ...acpRecord.definitions[0]!, id: 'review', name: 'review', title: 'Configured Review',
                launch: { kind: 'uv', package: 'review-acp', version: '1', args: [] } });
        }
        let definitionFacts = input.definitionInventory ? acpRecord.definitions.map((definition, index) =>
            MachineAgentInventoryItemSchema.parse({ ...nativeFacts('signedIn'), agentId: 'custom-acp',
                definitionId: definition.id, title: definition.title, installed: index === 0,
                managed: true, fit: { kind: 'can_run', via: 'uv' },
                install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null } })) : [];
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
            credentials: input.credentials,
            serverIdentityId: input.serverIdentityId,
            request: async (request, init) => {
                const actionResponse = await input.externalActionRequest?.(new URL(String(request)), init);
                if (actionResponse) return actionResponse;
                const memoryResponse = await authoringMemory.handle(request, init);
                if (memoryResponse) return memoryResponse;
                const path = new URL(String(request)).pathname;
                if (path === '/v2/account/settings' && init?.method === 'POST') accountSettingsWrites += 1;
                const machineRead = createPlainMachineReadHttpResponseFixture(path, init, accountId, machine);
                if (machineRead) return machineRead;
                if (path === '/v1/features') return Response.json(buildServerFeaturesResponse());
                if (path === '/v2/account/settings') return Response.json({ version: 1,
                    content: { t: 'plain', v: { useProfiles: input.profilesPresentationEnabled ?? Boolean(input.profile || input.rememberedProfile), useEnhancedSessionWizard: false,
                        lastUsedAgent: 'claude', lastUsedBackendTarget: input.target,
                        ...(input.actionsSettings ? { actionsSettingsV1: input.actionsSettings } : {}) } } });
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
        const scope = { serverId: resolveServerProfileScopeId(connection.home), accountId };
        rememberLastUsedBackendSelection(scope, { lastUsedAgent: 'claude', lastUsedBackendTarget: input.target });
        storage.setState({ settingsScope: scope, profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId }),
            settings: { ...settingsDefaults, useEnhancedSessionWizard: false, useProfiles: input.profilesPresentationEnabled ?? Boolean(input.profile || input.rememberedProfile),
                lastUsedAgent: 'claude', lastUsedBackendTarget: input.target,
                ...(input.actionsSettings ? { actionsSettingsV1: input.actionsSettings } : {}) } });
        storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId });
        observeMachinePresenceForTest(scope, [machine.id]);
        const agentCapabilities = { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' }, isBuiltIn: true,
                title: 'Claude', capabilities: agentCapabilities },
            ...(input.includeCodex ? { codex: { id: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, isBuiltIn: true,
                title: 'Codex', capabilities: agentCapabilities } } : {}),
            kiro: { id: 'kiro', identity: { pluginId: 'happier.agent.kiro', localId: 'kiro' }, isBuiltIn: true,
                title: 'Kiro', capabilities: agentCapabilities },
            'acme.review/provider': { id: 'acme.review/provider', identity: pluginTarget.identity,
                title: 'Acme Review', capabilities: agentCapabilities },
        } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries(
                [...Object.keys(projection.agentsById).map(agentId => [`cli.${agentId}`, { ok: true, checkedAt: Date.now(), data: nativeFacts('signedIn') }]),
                    ...(input.definitionInventory ? [['tool.acpAgentInventory', { ok: true, checkedAt: Date.now(), data: { items: definitionFacts } }]] : [])],
            ) };
            return { jobs: [] };
        });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected restored catalog authoring Account');
        await Promise.all([refreshAcpCatalog(scope), refreshProfileCatalog(scope),
            refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime })]);
        expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('ready');
        const profileCatalog = getProfileCatalogSnapshot(scope)?.catalog;
        expect(profileCatalog?.status, profileCatalog?.status === 'unavailable' ? profileCatalog.reason : undefined).toBe('ready');
        if (input.definitionInventory) {
            await refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime, force: true });
            expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id))
                .agents.filter(agent => agent.definitionId).map(agent => [agent.definitionId, agent.state]))
                .toEqual([['kiro', 'ready'], ['review', 'notInstalled']]);
        }
        if (input.rememberedProfile) {
            // Seed the real reserved-row owner: its bootstrap must not replace
            // a store-only fixture with the HTTP boundary's empty projection.
            const { sync } = await import('@/sync/sync');
            await sync.applyAuthoringMemoryDelta({
                lastUsedProfile: input.rememberedProfile === 'missing' ? 'deleted-profile' : profileId,
            }, { expectedSettingsScope: scope });
        }
        const inputs = readCachedDaemonMergedProjectionCacheEntry({ serverId: scope.serverId, machineId: machine.id });
        if (inputs?.kind !== 'ready') throw new Error('Expected real ready daemon projection fixture');
        expect(getResolvedBackendCatalogEntries({ enabledAgentIds: Object.keys(projection.agentsById),
            acpCatalogSnapshot: getAcpCatalogSnapshot(scope)?.catalog,
            mergedProviderProjectionById: inputs.inputs.mergedProviderProjectionById,
            mergedBackendProjectionById: inputs.inputs.mergedBackendProjectionById,
            discoveredBackendIds: inputs.inputs.discoveredBackendIds,
        }).map(entry => entry.backendTargetKey)).toContain(configuredKey);
        const draftId = `catalog-draft-${input.name}`;
        if (input.seedDraft !== false) writeNewSessionDraftToRepository({ scope, draftId, draft: { input: 'hello', selectedMachineId: machine.id,
            selectedPath: '/repo', targetServerId: scope.serverId,
            ...(input.target.kind === 'agent' ? { agentTarget: input.target } : { backendTarget: input.target }),
            agentType: 'claude', acpSessionModeId: null,
            selectedProfileId: input.profile && input.seedProfile !== false ? profileId : null, selectedSecretId: null,
            ...(input.actionDefault ? { actionDefault: input.actionDefault } : {}),
            permissionMode: 'default', updatedAt: 1 } });
        return {
            scope, draftId, profileId, home: connection.home,
            accountSettingsWrites: () => accountSettingsWrites,
            async refreshDefinitions(selected: 'kiro' | 'review', status: 'signedOut' | 'missing') {
                acpRecord.definitions.reverse();
                definitionFacts = acpRecord.definitions.map(definition => MachineAgentInventoryItemSchema.parse({
                    ...nativeFacts(definition.id === selected && status === 'signedOut' ? 'signedOut' : 'signedIn'),
                    agentId: 'custom-acp', definitionId: definition.id, title: definition.title,
                    managed: true, fit: { kind: 'can_run', via: 'uv' },
                    installed: definition.id !== selected || status !== 'missing',
                    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null },
                }));
                await refreshAcpCatalog(scope);
                await refreshMachineAgents({ serverId: scope.serverId, machineId: machine.id, accountLifetime: lifetime, force: true });
            },
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

    it('projects pushed Team model defaults into New Session while explicit choices stay local', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'managed-defaults', target: bundledTarget, seedDraft: false });
        const teamId = 'managed-defaults-team';
        const address = createTeamAddress(fixture.scope.serverId, teamId)!;
        const publish = (modelId: string) => applyTeamProjection({ scope: fixture.scope, address, observedAt: Date.now(),
            team: teamSummaryFixture({ id: teamId, viewerRole: 'member', capabilities: teamCapabilitiesFixture({}),
                policy: teamPolicyFixture({ managedDefaultsStatus: 'available', managedDefaults: { team: {
                    modelByAgentTargetKey: { [bundledKey]: { v: 1, updatedAt: 1,
                        ref: { agentTargetKey: bundledKey, providerConnectionId: null, modelId } } },
                }, groups: {} } }) }),
        });
        publish('haiku');
        writeNewSessionDraftToRepository({ scope: fixture.scope, draftId: fixture.draftId, draft: {
            input: 'hello', selectedMachineId: 'credential-devbox', selectedPath: '/repo', selectedProfileId: null, selectedSecretId: null,
            agentType: 'claude', permissionMode: 'default', acpSessionModeId: null,
            targetServerId: fixture.scope.serverId, backendTarget: bundledTarget, primaryTeamId: teamId, updatedAt: 1,
        } });
        const settingsBefore = storage.getState().settings;
        const writesBefore = fixture.accountSettingsWrites();
        let hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        const simple = () => {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            return model.simpleProps;
        };
        try {
            await vi.waitFor(() => expect(simple().modelMode).toBe('haiku'));
            await vi.waitFor(() => expect(readNewSessionDraftFromRepository({ scope: fixture.scope, draftId: fixture.draftId })?.updatedAt).toBeGreaterThan(1));
            await hook.unmount();
            await act(async () => { publish('sonnet'); });
            hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
            await vi.waitFor(() => expect(simple().modelMode).toBe('sonnet'));
            await act(async () => {
                const setModelMode = simple().setModelMode;
                if (!setModelMode) throw new Error('Expected the simple launcher model control');
                setModelMode('opus');
            });
            expect(simple().modelMode).toBe('opus');
            await act(async () => { publish('haiku'); });
            expect(simple().modelMode).toBe('opus');
            expect(fixture.accountSettingsWrites() - writesBefore).toBe(0);
            expect(storage.getState().settings).toEqual(settingsBefore);
        } finally { await hook.unmount(); }
    });

    it.each(['agent_user_missing', 'workspace_not_ready'] as const)('first isolated owner launch: %s', async (code) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `first-launch-${code.replaceAll('_', '-')}`,
            target: bundledTarget, seedDraft: false, isolated: true });
        authoringRoute.directory = undefined;
        const original = rpc.getMockImplementation();
        if (!original) throw new Error('Expected Machine RPC boundary');
        const launches: unknown[] = [];
        let statusReads = 0;
        rpc.mockImplementation((request: { method: string; payload?: unknown }) => {
            if (request.method === 'machines.agentIsolation.status') {
                statusReads += 1;
                return Promise.resolve({ protection: 'unavailable', status: { kind: 'unavailable', code } });
            }
            if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
                launches.push(request.payload);
                return Promise.resolve({ ok: false, code: 'invalid_directory' });
            }
            return original(request);
        });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.requesterIsolation?.status)
                    .toMatchObject({ status: { kind: 'unavailable', code } });
            });
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.canCreate, JSON.stringify(model.simpleProps.connectionStatus)).toBe(code === 'agent_user_missing');
            });
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            expect(launches).toEqual([]); // Background status must never prepare the member.
            if (code === 'agent_user_missing') {
                expect(model.simpleProps.folderChipState).toMatchObject({ kind: 'launch_preparable' });
                await act(async () => { await model.simpleProps.handleCreateSession(); });
                await vi.waitFor(() => expect(launches).toHaveLength(1));
                expect(launches[0]).toMatchObject({ prepareAgentIsolationMember: true,
                    directory: { kind: 'path', path: '~' } });
            } else {
                expect(model.simpleProps.folderChipState).toMatchObject({ kind: 'failed' });
                const isolation = model.requesterIsolation;
                if (!isolation) throw new Error('Expected requester directory state');
                expect(isolation.failed).toBe(true);
                await act(async () => { isolation.retry(); });
                await vi.waitFor(() => expect(statusReads).toBe(2));
                await vi.waitFor(() => expect(hook.getCurrent().requesterIsolation?.failed).toBe(true));
                expect(launches).toEqual([]);
            }
        } finally { await hook.unmount(); }
    });

    it('consumes Add Create once in the original composer without sending its retained prompt', async () => {
        const { createExternalActionAccountHttpBoundary } = await import('@/dev/testkit/harness/externalActionAccountHttpBoundary');
        const { installRealActionExecutorModuleLoader, createServedHomeAccountToken } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
        const { ManagedAcceptedV1Schema, managedMachineActionEndpointPathV1 } = await import('@happier-dev/protocol/machines/managed/actionsV1');
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { createMachineReadBatchResponseFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { storeTempData } = await import('@/utils/sessions/tempDataStore');
        const { NewSessionEmbeddedHostProvider, mergeNewSessionHostParams } = await import('@/components/sessions/new/navigation/newSessionHost');
        const restoreExecutor = await installRealActionExecutorModuleLoader();
        onTestFinished(restoreExecutor);
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.managed.acquire': ['ui'] } });
        const acquired: unknown[] = [];
        const admission = createDeferred<void>();
        onTestFinished(() => admission.resolve());
        let managed: ReturnType<typeof ManagedMachineV1Schema.parse> | null = null;
        const guest = createMachineFixture({ id: 'created-guest', activeAt: Date.now() });
        const boundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://catalog-authoring-create-return.test', serverIdentityId: 'srv_create_return',
            accountId: 'catalog-authoring-create-return', machineId: 'credential-devbox', installationId: 'installation',
            actionId: 'machines.managed.acquire', tokenEpoch: 0,
            execute: async input => {
                acquired.push(input);
                await admission.promise;
                return ManagedAcceptedV1Schema.parse({ managedId: 'created-managed' });
            },
        });
        const fixture = await restoreCatalogAuthoringFixture({ name: 'create-return', target: bundledTarget,
            profile: 'bundled-only', serverIdentityId: 'srv_create_return', actionsSettings,
            credentials: { token: createServedHomeAccountToken('catalog-authoring-create-return', true) },
            externalActionRequest: async (request, init) => {
                if (request.pathname === managedMachineActionEndpointPathV1('machines.managed.get')) {
                    if (!managed) throw new Error('Expected admitted managed Machine');
                    return Response.json(managed);
                }
                if (request.pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
                    return createMachineReadBatchResponseFixture(init.body, id => id === guest.id
                        ? createPlainMachineRowFixture({ id, accountId: 'catalog-authoring-create-return', machine: guest })
                        : id === boundary.machine.id ? boundary.machine : null);
                }
                if (request.pathname === `/v1/machines/${guest.id}`) return Response.json({ machine:
                    createPlainMachineRowFixture({ id: guest.id, accountId: 'catalog-authoring-create-return', machine: guest }) });
                return boundary.handle(request, init);
            } });
        authoringRoute.prompt = undefined;
        authoringRoute.machineId = undefined;
        authoringRoute.directory = undefined;
        const selection = createManagedMachineSelectionDraft({
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
            selection: { kind: 'one-off', homeId: fixture.scope.serverId,
                launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'credential-devbox', installationId: 'installation' },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            receipt: { launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: {} },
                controller: { machineId: 'credential-devbox', installationId: 'installation' }, optionStatus: 'current', prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        managed = ManagedMachineV1Schema.parse({ id: 'created-managed', homeId: fixture.scope.serverId,
            custodianAccountId: fixture.scope.accountId, launch: selection.receipt.launch,
            controller: selection.receipt.controller, enrolledMachineId: guest.id, allocation: 'bound',
            resource: { contributionRef: selection.receipt.launch.provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const retained = readNewSessionDraftFromRepository(fixture);
        if (!retained) throw new Error('Expected original composer draft');
        writeNewSessionDraftToRepository({ ...fixture, draft: { ...retained, input: 'Keep the original drafted prompt',
            selectedPath: '/authored/original', permissionMode: 'read-only' } });
        const openDraft = vi.fn();
        let host: import('@/components/sessions/new/navigation/newSessionHost').NewSessionEmbeddedHost = {
            kind: 'docked', demanded: true, params: { draftId: fixture.draftId, spawnServerId: fixture.scope.serverId },
            setParams: patch => { host = { ...host, params: mergeNewSessionHostParams(host.params, patch) }; },
            openDraft, onHandedOff: vi.fn() };
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }), {
            wrapper: ({ children }: React.PropsWithChildren) => <NewSessionEmbeddedHostProvider host={host}>{children}</NewSessionEmbeddedHostProvider>,
        });
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected original simple composer');
                expect(model.simpleProps.canCreate).toBe(true);
                expect(model.simpleProps.promptStore.getPrompt()).toBe('Keep the original drafted prompt');
                expect(model.simpleProps.selectedProfileId).toBe(fixture.profileId);
            });
            const returnedDataId = storeTempData({ managedMachineSelection: selection, managedMachineUseOptions: { create: true } });
            host.setParams({ dataId: returnedDataId,
                machineId: undefined, spawnServerId: fixture.scope.serverId });
            await hook.rerender();
            await vi.waitFor(() => expect(acquired).toHaveLength(1));
            expect(acquired[0]).not.toHaveProperty('agentStart');
            expect(hook.getCurrent().managedMachineDraft?.progress).toMatchObject({ kind: 'acquiring' });
            await act(async () => { admission.resolve(); });
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected original simple composer');
                expect(model.simpleProps.selectedMachineId).toBe(guest.id);
            });
            await flushHookEffects();
            expect(acquired).toHaveLength(1);
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected original simple composer');
            expect(model.simpleProps.promptStore.getPrompt()).toBe('Keep the original drafted prompt');
            expect(model.simpleProps.agentType).toBe('claude');
            expect(model.simpleProps.selectedProfileId).toBe(fixture.profileId);
            expect(model.simpleProps.selectedPath).toBe('/authored/original');
            await vi.waitFor(() => expect(readNewSessionDraftFromRepository(fixture)?.selectedMachineId).toBe(guest.id));
            expect(readNewSessionDraftFromRepository(fixture)?.permissionMode).toBe('read-only');
            expect(openDraft).not.toHaveBeenCalled();
            expect(rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_SPAWN_NEW
                || request.payload?.method === RPC_METHODS.SESSION_SPAWN_NEW)).toBe(false);
        } finally {
            admission.resolve();
            await hook.unmount();
            authoringRoute.dataId = undefined;
        }
    });

    it('recovers a managed draft and its authored folder through a local Home profile alias', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'managed-home-alias', target: bundledTarget,
            seedDraft: false, serverIdentityId: 'srv_managed_draft_recovery' });
        authoringRoute.machineId = undefined;
        authoringRoute.directory = undefined;
        const managedMachineSelection = createManagedMachineSelectionDraft({
            selection: { kind: 'preset', homeId: fixture.scope.serverId, id: 'reviewed-preset', revision: 3 },
            receipt: { launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
                name: 'Guest', choices: {} },
                controller: { machineId: 'credential-devbox', installationId: 'installation' }, optionStatus: 'current',
                prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' },
                retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
        });
        const managedMachineAcquisition = { requestId: 'retained-acquire', selection: managedMachineSelection.selection };
        writeNewSessionDraftToRepository({ ...fixture, draft: {
            input: 'retained prompt', targetServerId: fixture.home.id, selectedMachineId: null, selectedPath: '/authored/retained',
            agentType: 'claude', backendTarget: bundledTarget, acpSessionModeId: null, selectedProfileId: null, selectedSecretId: null,
            permissionMode: 'default', updatedAt: 1, managedMachineSelection, managedMachineAcquisition,
        } });
        expect(fixture.home.id).not.toBe(fixture.scope.serverId);
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        try {
            await vi.waitFor(() => {
                const model = hook.getCurrent();
                expect(model.managedMachineDraft?.selection).toEqual(managedMachineSelection);
                expect(model.managedMachineDraft?.acquisition).toEqual(managedMachineAcquisition);
                if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
                expect(model.simpleProps.selectedPath).toBe('/authored/retained');
            });
        } finally { await hook.unmount(); }
    });

    it.each([false, true])('keeps a retained launcher local across ticks, heartbeats and resource publications (presented=%s)', async (initiallyPresented) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `retained-ticks-${initiallyPresented ? 'visible' : 'hidden'}`, target: bundledTarget });
        const pickerBuilds = vi.spyOn(await import('./screenModel/buildNewSessionAgentPickerOptions'), 'buildNewSessionAgentPickerOptions');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const initialMachine = storage.getState().machines['credential-devbox'];
        if (!initialMachine) throw new Error('Expected fixture Machine');
        const resourceSummary = (since: number) => MachinePublishedResourceSummaryV1Schema.parse({
            v: 1, vitals: { state: 'unavailable', since, reason: 'reader_failed' }, attention: { level: 'calm', reasons: [] },
        });
        await act(async () => storage.getState().applyMachines([{ ...initialMachine, daemonStateVersion: 10,
            daemonState: { contributionRegistryProjectionRevision: 1, resources: resourceSummary(0) } }], false,
            { sourceServerId: fixture.scope.serverId }));
        let renders = 0;
        let presented = initiallyPresented;
        const hook = await renderHook(() => {
            renders += 1;
            return useNewSessionScreenModel({ draftId: fixture.draftId });
        }, { wrapper: ({ children }) => <PluginSurfaceFocusEligibilityProvider active={presented}>{children}</PluginSurfaceFocusEligibilityProvider> });
        try {
            await flushHookEffects();
            const settled = renders;
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected simple launcher');
            const options = model.simpleProps.agentPickerOptions;
            const settledPickerBuilds = pickerBuilds.mock.calls.length;
            const measureNow = performance.now.bind(performance);
            const started = measureNow();
            vi.useFakeTimers();
            const timerRenders: number[] = [];
            for (let tick = 0; tick < 5; tick += 1) {
                await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
                timerRenders.push(renders - settled);
            }
            const heartbeatRenders: number[] = [];
            for (let tick = 0; tick < 5; tick += 1) {
                const machine = storage.getState().machines['credential-devbox'];
                if (!machine) throw new Error('Expected fixture Machine');
                await act(async () => {
                    storage.getState().applyMachines([{ ...machine, activeAt: Date.now() + tick + 1 }], false,
                        { sourceServerId: fixture.scope.serverId });
                });
                heartbeatRenders.push(renders - settled);
            }
            const resourceRenders: number[] = [];
            for (let tick = 0; tick < 5; tick += 1) {
                const machine = storage.getState().machines['credential-devbox'];
                if (!machine) throw new Error('Expected fixture Machine');
                await act(async () => storage.getState().applyMachines([{ ...machine,
                    daemonStateVersion: 11 + tick,
                    daemonState: { ...machine.daemonState, resources: resourceSummary(tick + 1) },
                }], false, { sourceServerId: fixture.scope.serverId }));
                resourceRenders.push(renders - settled);
            }
            const current = hook.getCurrent();
            const changedPickerInputs = pickerBuilds.mock.calls.slice(settledPickerBuilds).map(([next], index) => {
                const previous = pickerBuilds.mock.calls[settledPickerBuilds + index - 1]![0];
                return Object.keys(next).filter(key => next[key as keyof typeof next] !== previous[key as keyof typeof previous]);
            });
            console.info('FX86 launcher counts', { presented, settled, timerRenders, heartbeatRenders, resourceRenders,
                pickerBuilds: pickerBuilds.mock.calls.length - settledPickerBuilds, changedPickerInputs, elapsedMs: measureNow() - started,
                pickerStable: current.variant === 'simple' && current.simpleProps.agentPickerOptions === options });
            expect(timerRenders).toEqual([0, 0, 0, 0, 0]);
            expect(heartbeatRenders).toEqual([0, 0, 0, 0, 0]);
            expect(resourceRenders).toEqual([0, 0, 0, 0, 0]);
            expect(pickerBuilds.mock.calls.length - settledPickerBuilds).toBe(0);
            expect(current.variant === 'simple' && current.simpleProps.agentPickerOptions).toBe(options);
            if (!presented) {
                expect(pickerBuilds.mock.calls.length - settledPickerBuilds).toBe(0);
                presented = true;
                await hook.rerender();
                const resumed = hook.getCurrent();
                if (resumed.variant !== 'simple') throw new Error('Expected resumed simple launcher');
                expect(resumed.simpleProps.agentPickerSelectedOptionId).toBe(model.simpleProps.agentPickerSelectedOptionId);
                expect(resumed.simpleProps.modelMode).toBe(model.simpleProps.modelMode);
            }
        } finally { vi.useRealTimers(); await hook.unmount(); pickerBuilds.mockRestore(); }
    });

    it('keeps configured definition status and recovery attached to selection across inventory refresh and reorder', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'definition-identity', target: configuredTarget, definitionInventory: true });
        const reviewKey = resolveBackendTargetKeyV2({ ...configuredTarget, definitionId: 'review' });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        const assertSelection = (key: string, blockedTitle?: string, actionLabel?: string) => {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected real simple launcher');
            expect(model.simpleProps.agentPickerSelectedOptionId).toBe(key);
            // Configured targets retain catalog admission, independently of native setup facts.
            expect(model.simpleProps.canCreate).toBe(true);
            if (blockedTitle) {
                expect(model.simpleProps.connectionStatus?.text).toContain(blockedTitle);
                expect(model.simpleProps.connectionStatus?.action?.label).toBe(actionLabel);
            } else {
                expect(model.simpleProps.connectionStatus?.text).toBeFalsy();
                expect(model.simpleProps.connectionStatus?.action).toBeUndefined();
            }
            return model.simpleProps;
        };
        try {
            const { t } = await import('@/text');
            await vi.waitFor(() => assertSelection(configuredKey));
            await act(async () => { assertSelection(configuredKey).onAgentPickerSelect?.(reviewKey); });
            await vi.waitFor(() => assertSelection(reviewKey, 'Configured Review', t('machineAgents.setUp')));
            await act(async () => { await fixture.refreshDefinitions('kiro', 'signedOut'); });
            await vi.waitFor(() => assertSelection(reviewKey));
            await act(async () => { assertSelection(reviewKey).onAgentPickerSelect?.(configuredKey); });
            await vi.waitFor(() => assertSelection(configuredKey, 'Configured Kiro', t('machineAgents.actionSignIn')));
            await act(async () => { await fixture.refreshDefinitions('review', 'missing'); });
            await vi.waitFor(() => assertSelection(configuredKey));
            await act(async () => { assertSelection(configuredKey).onAgentPickerSelect?.(reviewKey); });
            await vi.waitFor(() => assertSelection(reviewKey, 'Configured Review', t('machineAgents.setUp')));
        } finally { await hook.unmount(); }
    });

    it.each(['fresh', 'retained'] as const)('settles cold Home and New Session with a missing remembered Profile on %s drafts before Agent selection', async phase => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `cold-profile-depth-${phase}`, target: bundledTarget,
            seedDraft: false, rememberedProfile: 'missing' });
        const { NewSessionEmbeddedHostProvider } = await import('../navigation/newSessionHost');
        const host = { params: { machineId: 'credential-devbox', directory: '/repo' }, targetServerId: fixture.scope.serverId,
            setParams: () => {}, openDraft: () => {}, onHandedOff: () => {}, demanded: false };
        const renders = { home: 0, drawer: 0 };
        if (phase === 'retained') {
            for (const surface of ['home', 'drawer'] as const) writeNewSessionDraftToRepository({ scope: fixture.scope,
                draftId: `${fixture.draftId}-${surface}`, draft: {
                    input: 'retained prompt', selectedMachineId: 'credential-devbox', selectedPath: '/repo',
                    targetServerId: fixture.scope.serverId, backendTarget: bundledTarget,
                    selectedProfileId: null, selectedSecretId: null, agentType: 'claude', acpSessionModeId: null,
                    permissionMode: 'default', modelSelection: { v: 1, updatedAt: 1,
                        ref: { agentTargetKey: bundledKey, providerConnectionId: null, modelId: 'haiku' } }, updatedAt: 1,
                } });
        }
        const models: Partial<Record<keyof typeof renders, ReturnType<typeof useNewSessionScreenModel>>> = {};
        function Surface({ surface }: { surface: keyof typeof renders }) {
            if (++renders[surface] > 100) throw new Error(`Cold ${surface} profile selection did not settle within 100 renders`);
            models[surface] = useNewSessionScreenModel({ draftId: `${fixture.draftId}-${surface}` });
            return null;
        }
        const screen = await renderScreen(<>
            <NewSessionEmbeddedHostProvider host={host}><Surface surface="home" /></NewSessionEmbeddedHostProvider>
            <Surface surface="drawer" />
        </>);
        try {
            await flushHookEffects();
            for (const surface of ['home', 'drawer'] as const) {
                const model = models[surface];
                if (model?.variant !== 'simple') throw new Error('Expected simple launcher');
                expect(model.simpleProps.selectedProfileId).toBeNull();
                expect(model.simpleProps.agentType).toBe('claude');
                if (phase === 'retained') expect(model.simpleProps.modelMode).toBe('haiku');
                expect(renders[surface]).toBeLessThan(30);
            }
            expect(storage.getState().authoringMemory.lastUsedProfile).toBe('deleted-profile');
        } finally { await screen.unmount(); }
    });

    it.each([
        { surface: 'seeded-profile', seedDraft: true, seedProfile: true, configuredAction: false, contextual: true, presentationEnabled: false },
        { surface: 'configured-action', seedDraft: true, seedProfile: false, configuredAction: true, contextual: true, presentationEnabled: false },
        { surface: 'ordinary-remembered', seedDraft: false, seedProfile: false, configuredAction: false, contextual: false, presentationEnabled: false },
        { surface: 'ordinary-remembered-enabled', seedDraft: false, seedProfile: false, configuredAction: false, contextual: true, presentationEnabled: true },
        { surface: 'explicit-clear', seedDraft: true, seedProfile: false, configuredAction: false, contextual: true, presentationEnabled: true },
    ])('keeps explicit Profile authoring with presentation disabled or explicitly cleared: $surface', async (scenario) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `presentation-${scenario.surface}`, target: bundledTarget,
            profile: 'bundled-only', rememberedProfile: 'available', profilesPresentationEnabled: scenario.presentationEnabled,
            seedDraft: scenario.seedDraft, seedProfile: scenario.seedProfile,
            ...(scenario.configuredAction ? { actionDefault: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, configuredActionId: 'fix-check',
                label: 'Fix check', launchMode: 'review' as const } } : {}),
        });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        const current = () => {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected simple launcher');
            return model;
        };
        try {
            expect(current().simpleProps.useProfiles).toBe(scenario.contextual);
            expect(current().simpleProps.selectedProfileId).toBe(scenario.seedProfile || (!scenario.seedDraft && scenario.presentationEnabled)
                ? fixture.profileId : null);
            if (scenario.contextual) {
                const renderContent = current().simpleProps.profilePopover?.renderContent;
                if (typeof renderContent !== 'function') throw new Error('Expected contextual Profile picker');
                const content = renderContent({ maxHeight: 560, requestClose: () => {} });
                if (!React.isValidElement<React.ComponentProps<typeof import('../components/NewSessionProfilePopoverBrowserContent').NewSessionProfilePopoverBrowserContent>>(content)) {
                    throw new Error('Expected real Profile picker content');
                }
                const props = content.props.profilesListProps;
                const profile = props.customProfiles?.find(profile => profile.id === fixture.profileId);
                const onPressProfile = props.onPressProfile;
                if (!profile || !onPressProfile) throw new Error('Expected available Profile');
                await act(async () => { await onPressProfile(profile); });
                expect(current().simpleProps.selectedProfileId).toBe(fixture.profileId);
                if (scenario.seedDraft) {
                    await vi.waitFor(() => expect(readNewSessionDraftFromRepository(fixture)?.selectedProfileId).toBe(fixture.profileId));
                }
            }
            expect(storage.getState().settings.useProfiles).toBe(scenario.presentationEnabled);
            expect(fixture.accountSettingsWrites()).toBe(0);
        } finally { await hook.unmount(); }
    });

    it('keeps explicit Default Environment and Profile selections through remembered-choice refreshes', async () => {
        const fixture = await restoreCatalogAuthoringFixture({ name: 'explicit-profile-depth', target: bundledTarget,
            profile: 'bundled-only', seedDraft: false, rememberedProfile: 'available' });
        const hook = await renderHook(() => useNewSessionScreenModel({ draftId: fixture.draftId }));
        const getProfileContent = () => {
            const model = hook.getCurrent();
            if (model.variant !== 'simple') throw new Error('Expected simple launcher');
            const renderContent = model.simpleProps.profilePopover?.renderContent;
            if (typeof renderContent !== 'function') throw new Error('Expected Profile picker renderer');
            const content = renderContent({ maxHeight: 560, requestClose: () => {} });
            if (!React.isValidElement<React.ComponentProps<typeof import('../components/NewSessionProfilePopoverBrowserContent').NewSessionProfilePopoverBrowserContent>>(content)) {
                throw new Error('Expected real Profile picker content');
            }
            const props = content.props.profilesListProps;
            if (!props.onPressDefaultEnvironment || !props.onPressProfile) throw new Error('Expected Profile selection callbacks');
            return { model, props, onPressDefaultEnvironment: props.onPressDefaultEnvironment, onPressProfile: props.onPressProfile };
        };
        try {
            expect(getProfileContent().model.simpleProps.selectedProfileId).toBe(fixture.profileId);
            await act(async () => { getProfileContent().onPressDefaultEnvironment(); });
            await act(async () => { storage.getState().applyAuthoringMemory({ lastUsedProfile: 'deleted-profile' }); });
            await act(async () => { storage.getState().applyAuthoringMemory({ lastUsedProfile: fixture.profileId }); });
            expect(getProfileContent().model.simpleProps.selectedProfileId).toBeNull();
            const profile = getProfileContent().props.customProfiles?.find(profile => profile.id === fixture.profileId);
            if (!profile) throw new Error('Expected available Profile');
            await act(async () => { await getProfileContent().onPressProfile(profile); });
            await act(async () => { storage.getState().applyAuthoringMemory({ lastUsedProfile: 'deleted-profile' }); });
            expect(getProfileContent().model.simpleProps.selectedProfileId).toBe(fixture.profileId);
        } finally { await hook.unmount(); }
    });

    it.each(['fresh', 'late'] as const)('settles Agent picker updates on a %s scoped draft', async (phase) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `picker-depth-${phase}`, target: bundledTarget, seedDraft: false });
        const { AgentInputChipPickerPanel } = await import('@/components/sessions/agentInput/components/AgentInputChipPickerPanel');
        const { NewSessionEngineOptionDetail } = await import('../components/NewSessionEngineOptionDetail');
        let renders = 0;
        let current!: ReturnType<typeof useNewSessionScreenModel>;
        const close = () => {};
        function PickerHarness() {
            // Stop a regression before React's asynchronous loop floods the runner.
            if (++renders > 100) throw new Error('New Session Agent selection did not settle within 100 renders');
            current = useNewSessionScreenModel({ draftId: fixture.draftId });
            if (current.variant !== 'simple') throw new Error('Expected simple launcher');
            const onSelect = current.simpleProps.onAgentPickerSelect;
            if (!onSelect) throw new Error('Expected Agent picker selection');
            return <AgentInputChipPickerPanel title="Agent" options={current.simpleProps.agentPickerOptions ?? []}
                selectedOptionId={current.simpleProps.agentPickerSelectedOptionId}
                onSelect={onSelect} onRequestClose={close} />;
        }
        const screen = await renderScreen(<PickerHarness />);
        const hook = { getCurrent: () => current, unmount: () => screen.unmount() };
        try {
            const opening = hook.getCurrent();
            if (opening.variant !== 'simple') throw new Error('Expected simple launcher');
            await act(async () => { opening.simpleProps.onAgentPickerVisibilityChange?.(true); });
            await vi.waitFor(() => expect(screen.findAllByType(NewSessionEngineOptionDetail)).toHaveLength(1));
            if (phase === 'late') {
                await act(async () => { writeNewSessionDraftToRepository({ ...fixture, draft: {
                    input: 'restored prompt', selectedMachineId: 'credential-devbox', selectedPath: '/repo/late',
                    targetServerId: fixture.scope.serverId, backendTarget: bundledTarget,
                    selectedProfileId: null, selectedSecretId: null, agentType: 'claude', acpSessionModeId: null,
                    permissionMode: 'default', modelSelection: { v: 1, updatedAt: 1,
                        ref: { agentTargetKey: bundledKey, providerConnectionId: null, modelId: 'haiku' } },
                    backendNewSessionOptionStateByTargetKey: { [pluginKey]: { reasoningEffort: 'low' } }, updatedAt: 1,
                } }); });
                await flushHookEffects();
                const hydrated = hook.getCurrent();
                if (hydrated.variant !== 'simple') throw new Error('Expected simple launcher');
                expect(hydrated.simpleProps.modelMode).toBe('haiku');
            }
            for (const key of [configuredKey, pluginKey, bundledKey]) {
                const model = hook.getCurrent();
                if (model.variant !== 'simple') throw new Error('Expected simple launcher');
                expect(model.simpleProps.agentPickerOptions?.some(option => option.id === key)).toBe(true);
                const before = renders;
                await screen.pressByTestIdAsync(`agent-input-chip-picker.option:${key}`);
                await flushHookEffects();
                const selected = hook.getCurrent();
                if (selected.variant !== 'simple') throw new Error('Expected selected simple launcher');
                expect(selected.simpleProps.agentPickerSelectedOptionId).toBe(key);
                expect(renders - before).toBeLessThan(30);
            }
            await vi.waitFor(() => expect(screen.findAllByType(NewSessionEngineOptionDetail)).toHaveLength(1));
            vi.useFakeTimers();
            await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
            if (phase === 'late') expect(readNewSessionDraftFromRepository(fixture)?.backendTarget).toMatchObject(bundledTarget);
            if (phase === 'late') expect(readNewSessionDraftFromRepository(fixture)?.backendNewSessionOptionStateByTargetKey)
                .toMatchObject({ [pluginKey]: { reasoningEffort: 'low' } });
        } finally { vi.useRealTimers(); await hook.unmount(); }
    });

    it.each(['deferred', 'missed'] as const)('updates the rendered Agent picker after a %s Machine answer and browses Codex', async (outcome) => {
        const fixture = await restoreCatalogAuthoringFixture({ name: `machine-answer-${outcome}`,
            target: bundledTarget, includeCodex: true });
        const original = rpc.getMockImplementation();
        if (!original) throw new Error('Expected Machine RPC fixture');
        const readyAnswer = await original({ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE });
        let answer = createDeferred<unknown>();
        rpc.mockImplementation((request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? answer.promise : original(request));
        rpc.mockClear();
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({
            serverId: fixture.scope.serverId, machineId: 'credential-devbox',
        }, 'authority'); });
        const { AgentInputChipPickerPanel } = await import('@/components/sessions/agentInput/components/AgentInputChipPickerPanel');
        const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
        let current!: ReturnType<typeof useNewSessionScreenModel>;
        const close = () => {};
        function PickerHarness() {
            current = useNewSessionScreenModel({ draftId: fixture.draftId });
            if (current.variant !== 'simple') throw new Error('Expected simple launcher');
            return <AgentInputChipPickerPanel title="Agent" options={current.simpleProps.agentPickerOptions ?? []}
                selectedOptionId={current.simpleProps.agentPickerSelectedOptionId}
                onSelect={current.simpleProps.onAgentPickerSelect ?? close} onRequestClose={close} />;
        }
        const screen = await renderScreen(<PickerHarness />);
        try {
            if (current.variant !== 'simple') throw new Error('Expected simple launcher');
            await act(async () => { current.variant === 'simple' && current.simpleProps.onAgentPickerVisibilityChange?.(true); });
            await vi.waitFor(() => expect(rpc.mock.calls.some(([request]) =>
                request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true));
            const codexKey = 'agent:happier.agent.codex/codex';
            await screen.pressByTestIdAsync(`agent-input-chip-picker.option:${codexKey}`);
            await vi.waitFor(() => expect(screen.findByType(SessionModelPicker).props.agentTargetKey).toBe(codexKey));
            if (outcome === 'missed') {
                await act(async () => { answer.reject(new RpcError('Machine transport unavailable', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE)); });
                await flushHookEffects();
                answer = createDeferred<unknown>();
                rpc.mockClear();
                await vi.waitFor(() => {
                    expect(screen.findByTestId('model-picker-overlay-refresh')).not.toBeNull();
                    expect(screen.findByTestId('model-picker-overlay-refresh')?.props.disabled).not.toBe(true);
                });
                await screen.pressByTestIdAsync('model-picker-overlay-refresh');
                await vi.waitFor(() => expect(rpc.mock.calls.some(([request]) =>
                    request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true));
            }
            await act(async () => { answer.resolve(readyAnswer); });
            await vi.waitFor(() => {
                if (current.variant !== 'simple') throw new Error('Expected simple launcher');
                expect(current.simpleProps.agentPickerOptions?.find(option => option.id === codexKey)?.disabled).toBe(false);
            });
            await screen.pressByTestIdAsync(`agent-input-chip-picker.option:${codexKey}`);
            await vi.waitFor(() => expect(screen.findByType(SessionModelPicker).props.agentTargetKey).toBe(codexKey));
            expect(screen.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.startsWith('model-picker-overlay-option:')
                && node.props.testID.includes('agent:happier.agent.claude/claude'))).toEqual([]);
        } finally { answer.resolve(readyAnswer); await screen.unmount(); }
    });

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
                    remembered: readLastUsedBackendSelection(storage.getState().settingsScope).lastUsedBackendTarget,
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
                    remembered: readLastUsedBackendSelection(storage.getState().settingsScope).lastUsedBackendTarget,
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
                expect(model.simpleProps.canCreate, JSON.stringify({
                    connectionStatus: model.simpleProps.connectionStatus,
                    selectedMachineId: model.simpleProps.selectedMachineId,
                    selectedPath: model.simpleProps.selectedPath,
                    statusBadges: model.simpleProps.statusBadges,
                })).toBe(true);
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
