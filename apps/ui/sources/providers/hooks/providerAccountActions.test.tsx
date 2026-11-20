import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderConnectionsDescribeFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

installSettingsViewCommonModuleMocks({ storage: 'real',
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/providers/new' }).module;
    },
});
// Native recycler layout is a platform boundary; exercise the real row/header renderers.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
// Machine transport is a genuine boundary. No Account operation may reach it.
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
const account = createProviderSettingsAccountHarness();
const accountConnectionId = ProviderConnectionIdSchema.parse('pc_account');
await loadSyncSingletonForTests();
// Warm the real screen graphs during collection, outside the behavior-test budget.
const [{ ProviderConnectionDetailScreen }, { AgentModelsScreen }] = await Promise.all([
    import('@/components/settings/providers/ProviderConnectionDetailScreen'),
    import('@/components/settings/agents/AgentModelsScreen'),
]);
const { AgentSessionDefaultsSection } = await import('@/components/settings/agents/AgentSettingsScreen');
const { resolveAgentCatalogProjection } = await import('@/agents/backendCatalog/agentCatalogProjection');
beforeEach(() => {
    providerHarness.reset();
    providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => machineRpcWithServerScope(request));
});
afterEach(async () => { standardCleanup(); clearActiveUnsavedChangesGuard(); await account.reset(); machineRpcWithServerScope.mockReset(); });

function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}

describe('Account Provider UI actions without a machine', () => {
    it('keeps external Agent model defaults renderable when the Agent declares no permission modes', async () => {
        await account.restore({ machines: [] });
        const identity = { pluginId: 'example.agent', localId: 'no-permission-modes' };
        const projection = {
            ...resolveAgentCatalogProjection('example.agent/no-permission-modes', { enabledAgentIds: [] }),
            identity,
            backendTargetKey: resolveBackendTargetKeyV2({ kind: 'agent', identity }),
        };
        const screen = await renderScreen(<AgentSessionDefaultsSection
            projection={projection}
            compatibilityTargetKeys={[]}
            accountSettingsAvailable
            onOpenModels={() => {}}
        />);
        expect(screen.findByTestId('settings.agents.detail.defaultModel')).not.toBeNull();
        expect(screen.findByTestId('settings.agents.detail.permissionMode')).toBeNull();
    });

    it('writes favorites through the Account Action and restores them after restart with a saved device Home view', async () => {
        const opaque = { v: 99, futureWriterField: 'keep' };
        const { serverId, accountId } = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [],
            settings: { favoriteModelSelectionsV1: [opaque] } });
        // Stateful HTTP CAS is the genuine boundary. The stock Provider harness only reads Settings.
        const { AccountSettingsV2UpdateRequestSchema } = await import('@happier-dev/protocol/account/settings/accountSettingsApiV2');
        let persisted: Record<string, unknown> = { favoriteModelSelectionsV1: [opaque] };
        let version = 1;
        const readSettings = {
            select: () => ({ body: { version, content: { t: 'plain', v: persisted } } }),
        };
        account.home.answer(serverId, '/v2/account/settings', readSettings);
        const writeSettings: Parameters<typeof account.home.answer>[2] = { select: input => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== version) return { status: 409, body: {
                success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: persisted },
            } };
            if (request.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account favorite write');
            persisted = request.content.v;
            version += 1;
            return { body: { success: true, version } };
        } };
        account.home.answer(serverId, 'POST /v2/account/settings', writeSettings);
        const { useAccountSettingsScope, useApplyFavoriteModelSelectionReplacementIntent } = await import('@/sync/store/settingsWriters');
        const { useCurrentFavoriteModelSelectionsV1Mutable } = await import('@/sync/store/hooks');
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        const hook = await renderHook(() => ({ writer: useApplyFavoriteModelSelectionReplacementIntent(),
            favorites: useCurrentFavoriteModelSelectionsV1Mutable(),
            ready: useMountedActionExecution(useAccountSettingsScope()).ready }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const { toggleFavoriteModelSelection } = await import('@/sync/domains/models/favoriteModelSelections');
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const favorites = toggleFavoriteModelSelection({
            favorites: hook.getCurrent().favorites[0],
            backend: { backendTargetKey: agentTargetKey, builtInAgentId: 'codex' },
            modelRef: { agentTargetKey, providerConnectionId: accountConnectionId, modelId: 'gpt-6.2-sol' },
            modelLabel: 'GPT 6.2 Sol',
            providerDisplaySnapshot: {
                providerName: 'CLIProxyAPI',
                connectionName: 'Work',
                connectionRole: 'named',
                connectionDisplayNameMode: 'custom',
            },
            reasoningEffort: 'high',
            addedAtMs: 5,
        });
        const selection = favorites[0]!;
        expect(selection).toMatchObject({
            selection: { ref: { providerConnectionId: accountConnectionId, modelId: 'gpt-6.2-sol' } },
            reasoningEffort: 'high',
        });
        await act(async () => { hook.getCurrent().favorites[1](favorites); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().favorites[0]).toEqual(favorites));
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().settings.currentFavoriteModelSelectionsV1).toEqual([selection]);
        const { readRetainedFavoriteModelSelectionsV1 } = await import('@/sync/domains/settings/sessionAuthoringSelectionPersistence');
        expect(readRetainedFavoriteModelSelectionsV1(storage.getState().settings)).toEqual([opaque, selection]);
        expect(persisted.favoriteModelSelectionsV1).toEqual([opaque, selection]);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('models.favorite.set', { selection, favorite: true },
            { serverId, expectedAccountId: accountId, surface: 'ui' }))
            .toEqual({ ok: true, result: { status: 'updated' } });
        const [{ saveHomeViewState }, { createSettingsDomain }, { createStore }] = await Promise.all([
            import('@/sync/domains/server/serverProfiles'), import('@/sync/store/domains/settings'), import('zustand/vanilla'),
        ]);
        await saveHomeViewState({ version: 1, groups: [], activeTargetKind: 'server', activeTargetId: serverId });
        type StoreState = ReturnType<typeof storage.getState>;
        const restarted = createStore<StoreState>()((set, get) => ({
            ...storage.getState(),
            ...createSettingsDomain<StoreState>({ set, get }),
        }));
        expect(restarted.getState().settings.currentFavoriteModelSelectionsV1).toEqual([selection]);
        await restarted.getState().activateSettingsScope({ serverId, accountId });
        expect(restarted.getState().settings.currentFavoriteModelSelectionsV1).toEqual([selection]);
        await account.restore({ accountId: 'other-account', machines: [] });
        await waitForHomeGovernance(() => expect(hook.getCurrent().favorites[0]).toEqual([]));
        await account.restore({ accountId, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [],
            httpAnswers: { '/v2/account/settings': readSettings, 'POST /v2/account/settings': writeSettings } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().favorites[0]).toEqual([selection]));
        // Removal uses the same admitted favorite Action and preserves forward-version entries.
        await act(async () => { await hook.getCurrent().writer({ base: [selection], proposed: [] }); });
        expect(storage.getState().settings.currentFavoriteModelSelectionsV1).toEqual([]);
        expect(persisted.favoriteModelSelectionsV1).toEqual([opaque]);
        const retained = hook.getCurrent().writer;
        await account.reset();
        await expect(retained({ base: [], proposed: [selection] })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(persisted.favoriteModelSelectionsV1).toEqual([opaque]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('reads Provider approval operands by their Account names without exposing ids or boolean literals', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_approval_view', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Work source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const catalogHook = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(catalogHook.getCurrent()?.data?.connections[0]?.displayName).toBe('Work source'));
        const { ActionApprovalFieldsCard } = await import('@/components/approvals/ActionApprovalFieldsCard');
        const { describeApprovalActionFields } = await import('@/components/approvals/approvalFieldValues');
        const screen = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.enabled.set', actionArgs: { action: 'setEnabled', connectionId: 'pc_approval_view', enabled: true, scope: 'account' },
        })} />);
        expect(screen.getTextContent()).toContain('Work source');
        expect(screen.getTextContent()).not.toContain('pc_approval_view');
        expect(screen.getTextContent()).not.toContain('true');
        expect(screen.getTextContent()).not.toContain('setEnabled');
        const foreign = await renderScreen(<ActionApprovalFieldsCard serverId="another-home" presentation={describeApprovalActionFields({
            actionId: 'providers.connections.delete', actionArgs: { action: 'delete', connectionId: 'pc_approval_view' },
        })} />);
        expect(foreign.getTextContent()).not.toContain('Work source');
        const creation = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.create_contribution', actionArgs: { action: 'createContribution', connectionId: 'pc_new',
                contributionKey: 'happier.provider.deepseek/deepseek', displayName: 'DeepSeek', savedSecretId: null, enable: true },
        })} />);
        expect(creation.getTextContent()).toContain('DeepSeek');
        expect(creation.getTextContent()).not.toContain('happier.provider.deepseek/deepseek');
        expect(creation.getTextContent()).not.toContain('pc_new');
        const custom = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.create_custom', actionArgs: { action: 'createCustom', connectionId: 'pc_custom',
                template: customTemplate(), savedSecretId: null, enable: true, manualModels: [] },
        })} />);
        expect(custom.getTextContent()).not.toContain('[]');
        expect(custom.getTextContent()).not.toContain('true');
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('retains the dirty author while reviewing approval and settles rejected writes without replay', async () => {
        const { serverId } = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [],
            settings: { actionsSettingsV1: { v: 1, actions: {
                'providers.connections.create_custom': { approvalRequiredSurfaces: ['ui'] },
            } } },
        });
        const [{ WorkspaceProvider }, { DestinationInstanceHost }, { resolveCompactAppDestinations }] = await Promise.all([
            import('@/components/appShell/workspace/WorkspaceProvider'), import('@/components/appShell/workspace/DestinationInstanceHost'),
            import('@/components/appShell/destinations/compactAppDestinationCatalog'),
        ]);
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let workspace: WorkspaceNavigationContextValue | null = null;
        let sourceTabId: string | null = null;
        function Wrapper({ children }: React.PropsWithChildren) {
            return <WorkspaceProvider enabled catalog={catalog}>{navigation => {
                workspace = navigation;
                sourceTabId ??= navigation.state.groups[navigation.state.focusedGroupId]!.activeTabId;
                const tab = navigation.state.tabs[sourceTabId]!;
                return <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/settings/providers/new"
                    focused visible navigation={navigation.navigationForTab(tab.id)}>{children}</DestinationInstanceHost>;
            }}</WorkspaceProvider>;
        }
        const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const refresh = async () => {};
        const resolveTarget = () => null;
        const hook = await renderHook(() => ({ mutation: useProviderConnectionMutation({ serverId, resolveTarget, refresh }),
            ready: useProviderActionClient(serverId).ready }), { wrapper: Wrapper });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        await waitForHomeGovernance(() => expect(workspace!.active).toBe(true));
        const dirty = { current: true };
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: dirty, requestDecision, tag: 'Provider.authoring.approval' });
        let pending: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => { pending = hook.getCurrent().mutation.run({ action: 'createCustom', connectionId: 'pc_approval',
            template: customTemplate(), savedSecretId: null, enable: false, manualModels: [] }); });
        await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(hook.getCurrent().mutation.pendingApproval).not.toBeNull());
        expect(requestDecision).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => {
            const state = workspace!.state;
            const active = state.tabs[state.groups[state.focusedGroupId]!.activeTabId]!;
            expect(active.id).toBe(sourceTabId);
        });
        const state = workspace!.state;
        expect(state.tabs[sourceTabId!]).toBeDefined();
        expect(dirty.current).toBe(true);
        expect(hook.getCurrent().mutation.isPending('createCustom:pc_approval')).toBe(true);
        // The author can say what it waits for and reopen the same approval (P1#7).
        const artifactId = hook.getCurrent().mutation.pendingApproval!.artifactId;
        expect(hook.getCurrent().mutation.pendingApproval?.href)
            .toContain(`/inbox/approvals/${encodeURIComponent(artifactId)}`);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
        await act(async () => { await pending!; });
        expect(hook.getCurrent().mutation.isPending('createCustom:pc_approval')).toBe(false);
        expect(hook.getCurrent().mutation.pendingApproval).toBeNull();
        expect(dirty.current).toBe(true);
    });

    it('keeps the Account connection readable when its selected-machine augmentation fails', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_provider_machine',
            machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })] });
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_connection_invalid') });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId,
            connectionId: 'pc_account' }));
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalled());
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().data?.connections[0]).toMatchObject({ connectionId: 'pc_account', displayName: 'Account source',
            authorized: false, runtime: { health: 'not_checked' } });
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent()).toMatchObject({ machineError: { code: 'provider_connection_invalid' }, loading: false });
        // A daemon's lagging catalog census cannot delete the fresh Account editor either.
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({ connections: [] }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_account');
        expect(hook.getCurrent().machineError).toBeNull();
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_connection_invalid') });
        await account.selectMachine(serverId, 'machine-a');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_account" />);
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('provider-error:provider_connection_invalid').length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-name')).not.toBeNull());
        expect(screen.findByTestId('provider-connection-header')).not.toBeNull();
    });

    it('initializes a fresh Account catalog before reading sources without another mounted observer', async () => {
        let catalog: ReturnType<typeof ProviderConnectionsCatalogV1Schema.parse> | null = null;
        const { serverId } = await account.restore({ machines: [] });
        const [{ resetProviderCatalogEngineForTests }, { resetProviderCatalogSnapshotsForTests }] = await Promise.all([
            import('@/sync/engine/settings/providerCatalogEngine'), import('@/sync/store/settings/providerCatalogSnapshot'),
        ]);
        resetProviderCatalogEngineForTests();
        resetProviderCatalogSnapshotsForTests();
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: catalog
                ? { status: 'present', revision: 1, content: { t: 'plain', v: catalog } }
                : { status: 'absent' } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe('absent');
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account initialization');
                catalog = mutation.content.v;
                return { body: { status: 'updated', revision: 1, cursor: 1 } };
            },
        });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().data?.connections).toEqual([]);
        expect(catalog).not.toBeNull();
        const [{ getProviderCatalogSnapshot }, { getActiveServerAccountScope }] = await Promise.all([
            import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        expect(getProviderCatalogSnapshot(getActiveServerAccountScope())).toMatchObject({ status: 'ready', revision: 1 });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('projects a populated contributed source into Agent Models without a machine', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_deepseek', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'QA DeepSeek', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderModelProjection } = await import('./useProviderModelProjection');
        const hook = await renderHook(() => useProviderModelProjection({ enabled: true, machineId: null, serverId,
            agentTargetKey: 'agent:happier.agent.claude/claude', mode: 'management' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().data?.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({ connectionId: 'pc_deepseek' }),
        ]));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('offers retry for an unavailable Account catalog and recovers the same mounted reader', async () => {
        const { serverId } = await account.restore({ machines: [] });
        let reachable = false;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => reachable
                ? { body: { status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } }
                : { body: { error: 'unavailable' }, status: 503 },
        });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().error).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: { retryable: true, action: 'retry' } });
        reachable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: null, data: { connections: [] } });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('opens Agent Models with native models and Account sources when no machine exists', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'manual-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        // Screen feature admission follows the Home view selection, not just
        // the Account connection restored for the Action transport.
        await account.home.selectHomes([serverId]);
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const ready = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(ready.getCurrent().ready).toBe(true));
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="codex" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        const nativeModel = getAgentStaticModels('codex')[0]!;
        expect(screen.getTextContent()).toContain(nativeModel.name || nativeModel.id);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models-source-visibility:pc_account')).not.toBeNull());
        expect(screen.findByTestId('agent-models')).not.toBeNull();
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('reads saved connection identity and manual models without asserting runtime authorization', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'manual-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const [{ useProviderConnections }, { useProviderConnectionModels }, { useProviderActionClient }, { useProviderModelProjection }] = await Promise.all([
            import('./useProviderConnections'), import('./useProviderConnectionModels'), import('@/providers/actions/useProviderActionClient'), import('./useProviderModelProjection'),
        ]);
        const hook = await renderHook(() => ({
            connections: useProviderConnections({ enabled: true, machineId: null, serverId }),
            models: useProviderConnectionModels({ enabled: true, machineId: null, serverId, connectionId: 'pc_account' }),
            actions: useProviderActionClient(serverId),
            projection: useProviderModelProjection({ enabled: true, machineId: null, serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management' }),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        await act(async () => { expect((await hook.getCurrent().connections.refresh())?.status).toBe('success'); });
        expect(hook.getCurrent().connections.data?.connections[0]?.connectionId).toBe('pc_account');
        expect(hook.getCurrent().connections.data?.connections[0]).toMatchObject({ authorized: false, runtime: { health: 'not_checked' } });
        await act(async () => { expect((await hook.getCurrent().models.refreshWithResult())?.status).toBe('success'); });
        expect(hook.getCurrent().models.models).toMatchObject([{ id: 'manual-model', source: 'manual', loadState: 'unknown' }]);
        await act(async () => { expect((await hook.getCurrent().projection.refreshWithResult())?.status).toBe('success'); });
        expect(hook.getCurrent().projection.data?.groups).toMatchObject([{
            connectionId: 'pc_account', modelLoadAction: 'machine_required',
            authorization: { authorized: false }, rows: [{ ref: { modelId: 'manual-model' }, loadState: 'unknown' }],
        }]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('creates, edits, adds manual models, reloads and deletes through the Account catalog', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse(DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1);
        let revision = 1;
        let writes = 0;
        const { serverId } = await account.restore({ catalog, machines: [], waivedActions: [
            'providers.connections.create_custom', 'providers.connections.update', 'providers.connections.delete',
        ] });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected keyless Plain Account write');
                writes += 1;
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const [{ useProviderConnections }, { useProviderConnectionMutation }, { useProviderActionClient }] = await Promise.all([
            import('./useProviderConnections'), import('./useProviderConnectionMutation'), import('@/providers/actions/useProviderActionClient'),
        ]);
        const resolveTarget = () => null;
        const hook = await renderHook(() => {
            const connections = useProviderConnections({ enabled: true, machineId: null, serverId });
            const refresh = React.useCallback(async () => { await connections.refresh(); }, [connections.refresh]);
            return { connections, mutation: useProviderConnectionMutation({ resolveTarget, serverId, refresh }),
                actions: useProviderActionClient(serverId) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        await act(async () => {
            const result = await hook.getCurrent().mutation.run({ action: 'createCustom', connectionId: 'pc_account',
                template: customTemplate(), savedSecretId: null, enable: false, manualModels: [] });
            expect(result?.status).toBe('success');
        });
        const created = catalog.connections[0]!;
        await act(async () => {
            const result = await hook.getCurrent().mutation.run({ action: 'update', connectionId: created.id,
                expectedRevision: created.revision, displayName: 'Renamed source', displayNameMode: 'custom' });
            expect(result?.status).toBe('success');
        });
        await act(async () => {
            const result = await hook.getCurrent().actions.mutateProviderModelSettings({ serverId, request: {
                action: 'manualAdd', connectionId: created.id, expectedConnectionRevision: catalog.connections[0]!.revision,
                models: [{ id: 'added-model' }],
            } });
            expect(result.status).toBe('success');
            await hook.getCurrent().connections.refresh();
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toMatchObject([{ id: 'added-model' }]);
        const beforeTemplateEdit = catalog.connections[0]!;
        const manualModels = catalog.manualModelsByConnectionId[accountConnectionId];
        const replacement = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Corrected template', baseUrl: 'https://corrected.example.test/v1', requiresApiKey: false });
        await act(async () => {
            const result = await hook.getCurrent().mutation.updateCustomTemplate({
                connectionId: created.id, expectedRevision: beforeTemplateEdit.revision, template: replacement,
            });
            expect(result).toMatchObject({ status: 'success', connection: {
                revision: beforeTemplateEdit.revision + 1,
                endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
            } });
        });
        expect(catalog.connections[0]).toMatchObject({
            source: { kind: 'custom', template: replacement }, revision: beforeTemplateEdit.revision + 1,
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toEqual(manualModels);
        expect(hook.getCurrent().connections.data?.connections[0]).toMatchObject({
            displayName: 'Renamed source', revision: beforeTemplateEdit.revision + 1,
            endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
        });
        const committedCatalog = catalog;
        const committedRowRevision = revision;
        const committedWrites = writes;
        await act(async () => {
            const result = await hook.getCurrent().mutation.updateCustomTemplate({
                connectionId: created.id, expectedRevision: beforeTemplateEdit.revision, template: customTemplate(),
            });
            expect(result).toBeNull();
        });
        expect(hook.getCurrent().mutation.error).toMatchObject({ code: 'provider_connection_changed', connectionId: created.id });
        expect(writes).toBe(committedWrites);
        expect(revision).toBe(committedRowRevision);
        expect(catalog).toEqual(committedCatalog);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        await hook.unmount();
        const reopened = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().data?.connections[0]?.displayName).toBe('Renamed source'));
        expect(reopened.getCurrent().data?.connections[0]).toMatchObject({
            revision: beforeTemplateEdit.revision + 1, endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toEqual(manualModels);
        const writer = await renderHook(() => {
            const refresh = React.useCallback(async () => { await reopened.getCurrent().refresh(); }, [reopened]);
            return useProviderConnectionMutation({ resolveTarget, serverId, refresh });
        });
        await act(async () => {
            expect((await writer.getCurrent().run({ action: 'delete', connectionId: created.id }))?.status).toBe('success');
        });
        expect(catalog.connections).toEqual([]);
        expect(reopened.getCurrent().data?.connections).toEqual([]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('reads and edits the Account source while the selected machine is offline', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_provider_account',
            machines: [createMachineFixture({ id: 'machine-offline', kind: 'persistent', active: false, activeAt: 1 })],
            waivedActions: ['providers.connections.update'],
        });
        await account.selectMachine(serverId, 'machine-offline');
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const [{ useProviderSettingsTarget }, { useProviderConnections }, { useProviderConnectionMutation }, { useProviderActionClient }] = await Promise.all([
            import('./targetMachine'), import('./useProviderConnections'), import('./useProviderConnectionMutation'), import('@/providers/actions/useProviderActionClient'),
        ]);
        const hook = await renderHook(() => {
            const target = useProviderSettingsTarget();
            const connections = useProviderConnections({ enabled: true, machineId: target.machineId, serverId: target.serverId });
            const refresh = React.useCallback(async () => { await connections.refresh(); }, [connections.refresh]);
            return { target, connections, actions: useProviderActionClient(serverId),
                mutation: useProviderConnectionMutation({ resolveTarget: target.resolveCurrentTarget, serverId: target.serverId, refresh }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        expect(hook.getCurrent().target.selection.selectedTarget?.machineId).toBe('machine-offline');
        expect(hook.getCurrent().target.machineId).toBeNull();
        await act(async () => { expect((await hook.getCurrent().connections.refresh())?.status).toBe('success'); });
        await act(async () => {
            expect((await hook.getCurrent().mutation.run({ action: 'update', connectionId: 'pc_account',
                expectedRevision: 1, displayName: 'Offline-edited source', displayNameMode: 'custom' }))?.status).toBe('success');
        });
        expect(hook.getCurrent().connections.data?.connections[0]?.displayName).toBe('Offline-edited source');
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('preserves a manual-model draft after a no-machine revision conflict', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderConnectionModelsSection } = await import('@/components/settings/providers/models/useProviderConnectionModelsSection');
        const hook = await renderHook(() => useProviderConnectionModelsSection({ declarationContext: { kind: 'account' },
            enabled: true, connectionId: 'pc_account', machineId: null, serverId,
            connection: { providerName: 'Account source', displayName: 'Account source', role: 'named',
                displayNameMode: 'custom', probeCapability: 'catalog' },
            resolveCurrentTarget: () => null,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().manualModelPolicy).toBe('allowed'));
        await act(async () => { hook.getCurrent().onManualModelTextChange('my-model'); });
        // A second client updated this same connection while the local draft was open.
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 2, content: { t: 'plain', v: {
                ...catalog, connections: [{ ...catalog.connections[0], revision: 2 }],
            } } },
        });
        await act(async () => { expect(await hook.getCurrent().manualDraft.save()).toBe(false); });
        expect(hook.getCurrent().error?.code).toBe('provider_connection_changed');
        expect(hook.getCurrent().manualModelText).toBe('my-model');
        expect(hook.getCurrent().manualDraft.dirtyRef.current).toBe(true);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('reads after an unknown Account write without replaying it or discarding the manual draft', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        let writes = 0;
        const { serverId } = await account.restore({ catalog, machines: [] });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                writes += 1;
                catalog = mutation.content.v;
                revision += 1;
                // The Home committed, but its receipt was lost in transit.
                return { dispatchThenFail: true };
            },
        });
        const { useProviderConnectionModelsSection } = await import('@/components/settings/providers/models/useProviderConnectionModelsSection');
        const hook = await renderHook(() => useProviderConnectionModelsSection({ declarationContext: { kind: 'account' },
            enabled: true, connectionId: 'pc_account', machineId: null, serverId,
            connection: { providerName: 'Account source', displayName: 'Account source', role: 'named',
                displayNameMode: 'custom', probeCapability: 'catalog' }, resolveCurrentTarget: () => null,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().manualModelPolicy).toBe('allowed'));
        await act(async () => { hook.getCurrent().onManualModelTextChange('my-model'); });
        await act(async () => { expect(await hook.getCurrent().manualDraft.save()).toBe(false); });
        expect(hook.getCurrent().error).toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown', action: 'review_current_state' });
        expect(hook.getCurrent().errorRetry).toBeUndefined();
        expect(hook.getCurrent().modelCount).toBe(1);
        expect(hook.getCurrent().manualModelText).toBe('my-model');
        await act(async () => { await hook.getCurrent().errorReviewCurrentState?.(); });
        expect(writes).toBe(1);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('keeps the addressed Account Agent title when its selected same-Home machine is missing', async () => {
        const { serverId } = await account.restore({ serverIdentityId: 'srv_agent_same_home', machines: [] });
        const agent = { id: 'same-home-agent', name: 'same-home-agent', title: 'Addressed Account Agent title',
            launch: { kind: 'command', command: 'same-home-agent' }, createdAt: 1, updatedAt: 1 };
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [agent] });
        account.home.answer(serverId, `GET ${ACP_CATALOG_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: record } },
        });
        const { useAcpCatalogForServer } = await import('@/sync/store/useAcpCatalog');
        const acp = await renderHook(() => useAcpCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(acp.getCurrent().snapshot?.catalog).toMatchObject({ status: 'ready', record }));
        await account.selectMachine(serverId, 'missing-same-home-machine', 'agents');
        const [{ useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
            import('@/sync/domains/machines/administration/useTargetSelection'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents));
        expect(selection.getCurrent().selectedTarget).toEqual({
            serverIdentityId: 'srv_agent_same_home', machineId: 'missing-same-home-machine',
        });
        expect(selection.getCurrent().state.kind).toBe('missing');
        expect(selection.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(true);
        expect(selection.getCurrent().resolveExecutionTarget()).toBeNull();
        let writes = 0;
        for (const route of ['POST /v2/account/settings', `POST ${ACP_CATALOG_ROWS_ROUTE_V1}`]) {
            account.home.answer(serverId, route, { select: () => {
                writes += 1;
                return { status: 500, body: { error: 'unexpected_write' } };
            } });
        }
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const agentTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agent.id, configuredBackendId: agent.id });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId={null} />);
        expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
        expect(screen.getTextContent()).toContain(agent.title);
        expect(writes).toBe(0);
        expect(account.catalogMutations).toEqual([]);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it.each(['revoked', 'missing'] as const)('does not disclose active Account sources or Agent titles through an inaccessible foreign Agent Home (%s)', async state => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_private_active', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Private active Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_private_active: [{ id: 'private-active-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_agent_active', machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const admitted = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(admitted.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        const privateAgent = { id: 'private-active-agent', name: 'private-active-agent',
            title: 'Private active Account Agent title', launch: { kind: 'command', command: 'private-agent' }, createdAt: 1, updatedAt: 1 };
        const acpRecord = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [privateAgent] });
        account.home.answer(serverId, `GET ${ACP_CATALOG_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } },
        });
        const { useAcpCatalogForServer } = await import('@/sync/store/useAcpCatalog');
        const acp = await renderHook(() => useAcpCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(acp.getCurrent().snapshot?.catalog).toMatchObject({
            status: 'ready', record: acpRecord,
        }));
        const peerId = await account.addHome({ name: 'Foreign Agent Home', serverUrl: 'https://foreign-agent-home.test',
            accountId: 'peer-account', serverIdentityId: 'srv_agent_foreign', active: false });
        const peerMachine = createMachineFixture({ id: 'peer-machine', active: true, activeAt: Date.now() });
        if (state === 'revoked') await account.publishMachines(peerId, [peerMachine]);
        await account.selectMachine(peerId, peerMachine.id, 'agents');
        if (state === 'revoked') await account.publishMachines(peerId, [{ ...peerMachine, seq: peerMachine.seq + 1,
            updatedAt: peerMachine.activeAt + 1, metadataVersion: peerMachine.metadataVersion + 1,
            daemonStateVersion: peerMachine.daemonStateVersion + 1, revokedAt: Date.now() }]);
        const [{ useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
            import('@/sync/domains/machines/administration/useTargetSelection'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents));
        expect(selection.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_agent_foreign', machineId: peerMachine.id });
        expect(['offline', 'locked', 'missing', 'replaced', 'revoked']).toContain(selection.getCurrent().state.kind);
        expect(selection.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(false);
        expect(selection.getCurrent().resolveExecutionTarget()).toBeNull();
        let settingsWrites = 0;
        let acpWrites = 0;
        for (const homeId of [serverId, peerId]) {
            account.home.answer(homeId, 'POST /v2/account/settings', { select: () => {
                settingsWrites += 1;
                return { status: 500, body: { error: 'unexpected_settings_write' } };
            } });
            account.home.answer(homeId, `POST ${ACP_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
                acpWrites += 1;
                return { status: 500, body: { error: 'unexpected_acp_write' } };
            } });
        }
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const agentTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: privateAgent.id, configuredBackendId: privateAgent.id });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId={null} />);
        expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
        expect(screen.findByTestId('agent-models')).toBeNull();
        expect(screen.findByTestId('agent-models-source-visibility:pc_private_active')).toBeNull();
        expect(screen.getTextContent()).not.toContain('private-active-model');
        expect(screen.getTextContent()).not.toContain(privateAgent.title);
        expect(account.catalogMutations).toEqual([]);
        expect(settingsWrites).toBe(0);
        expect(acpWrites).toBe(0);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(providerHarness.state.requests).toEqual([]);
    });

});
