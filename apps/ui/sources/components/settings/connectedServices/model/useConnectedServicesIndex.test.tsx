import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { renderHook } from '@/dev/testkit';
import { useConnectAccountSheetModel } from '../setup/useConnectAccountSheetModel';
import { useAgentSignInTargets } from '../defaults/useAgentSignInTargets';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { refreshConnectedAccountCatalog, resetConnectedAccountCatalogEngineForTests } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { getConnectedAccountCatalogValue, resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema,
    type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resetProviderCatalogEngineForTests } from '@/sync/engine/settings/providerCatalogEngine';
import { applyProviderCatalogSnapshot, beginProviderCatalogLoad, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { useConnectedServicesIndex } from './useConnectedServicesIndex';
import { useConnectedServicesAgentUses } from './useConnectedServicesAgents';
import { t } from '@/text';

installConnectedServicesCommonModuleMocks();
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Machine RPC is a genuine boundary; selection, projections and row activation stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

const consumer = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const purposeValue = { v: 1 as const, bindings: [{ purpose: { consumer, purpose: 'primary' },
    target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] };
const source = { connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
    codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } },
} }, actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: Object.fromEntries([
    'providers.connections.create_contribution', 'providers.connections.update', 'providers.connections.enabled.set',
].map(id => [id, ['ui']])) } };
const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
    source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
    role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
    gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, claudeHelperModels: { fast: 'haiku' },
    revision: 3, createdAt: 1, updatedAt: 1 });
const mutations: ConnectedAccountCatalogRowMutationV1[] = [];
const providerRowHomes: string[] = [];
let savedConnections: readonly ProviderConnectionV1[] = [gateway];
let rowStatus: 'absent' | 'present' | 'deleted' = 'absent';
let content: ConnectedAccountCatalogRowMutationV1['content'] | null = null;
let beforeNextPurposeRead: (() => Promise<void>) | undefined;
let providerCatalog: ProviderConnectionsCatalogV1 | null = null;
let providerRevision = 1;
let catalogReadGate: Promise<void> | null = null;

beforeEach(() => {
    providerRowHomes.length = 0;
    savedConnections = [gateway]; providerCatalog = null; providerRevision = 1; catalogReadGate = null;
    rowStatus = 'absent'; content = null; mutations.length = 0; machineRpc.mockReset();
    beforeNextPurposeRead = undefined;
    resetConnectedAccountCatalogEngineForTests(); resetConnectedAccountCatalogSnapshotsForTests();
    resetProviderCatalogEngineForTests(); resetProviderCatalogSnapshotsForTests();
    clearDaemonMergedProjectionCacheForTests();
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: { codex: {
        id: 'codex', identity: consumer, isBuiltIn: true, title: 'Codex',
        connectedAccounts: [{ purpose: 'primary', service }],
    } } });
    machineRpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
        ? { protocolVersion: 1, projection } : { error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' });
});
const runtime = installSessionPaneRuntimeTestHarness({
    accountCurrentness: () => createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }),
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: source }, version: 7 });
        if (path === '/v1/account/saved-secrets/resources/materials') return Response.json({ resources: [] });
        if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
        if (path === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 && init?.method === 'POST') {
            const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
            providerCatalog = mutation.content.v; providerRevision += 1;
            return Response.json({ status: 'updated', revision: providerRevision, cursor: providerRevision });
        }
        if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) { providerRowHomes.push(new URL(String(url)).origin); await catalogReadGate; }
        if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: providerRevision,
            content: { t: 'plain', v: providerCatalog ?? { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: savedConnections } } });
        if (path === '/v1/account/entity-rows/connected-accounts/purposes') {
            if (init?.method === 'POST') {
                const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                mutations.push(mutation); content = mutation.content; rowStatus = 'present';
                return Response.json({ status: 'updated', revision: 1, cursor: 1 });
            }
            const beforeRead = beforeNextPurposeRead;
            beforeNextPurposeRead = undefined;
            await beforeRead?.();
            return Response.json(rowStatus === 'absent' ? { status: 'absent' }
                : rowStatus === 'deleted' ? { status: 'deleted', revision: 4 }
                    : { status: 'present', revision: 1, content });
        }
        return null;
    },
});

function createIndexWrapper(machineId: string | null, retiredProjectionLifetime = false, projectionServerId = runtime.serverId) {
    const scope = { serverId: runtime.serverId, accountId: 'account-a' };
    storage.setState({ profileScope: scope, settingsScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    storage.getState().applyMachines(machineId ? [createMachineFixture({ id: machineId, activeAt: Date.now() })] : [], true, { sourceServerId: scope.serverId });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real captured index Account');
    if (retiredProjectionLifetime) {
        const replacementScope = { ...scope, accountId: 'account-b' };
        storage.setState({ profileScope: replacementScope, settingsScope: replacementScope,
            profile: AccountProfileSchema.parse({ id: replacementScope.accountId }) });
        captureActiveServerAccountScopeLifetime();
        storage.setState({ profileScope: scope, settingsScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
        captureActiveServerAccountScopeLifetime();
        expect(lifetime.isCurrent()).toBe(false);
    }
    const value: AppShellPluginUiProjectionValue = { pluginUiProjection: null, pluginBrowserProjection: null,
        phase: 'unavailable', interactionEnabled: false, machineId, serverId: projectionServerId, platform: 'web',
        accountLifetime: lifetime, reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
    const Wrapper = ({ children }: React.PropsWithChildren) => <runtime.Wrapper>
        <AppShellPluginUiProjectionValueProvider value={value}>{children}</AppShellPluginUiProjectionValueProvider>
    </runtime.Wrapper>;
    return Wrapper;
}

async function mount(mode: 'load' | 'cached', machineId: string | null, retiredProjectionLifetime = false, gateways = false,
    projectionServerId = runtime.serverId) {
    return renderHook(() => useConnectedServicesIndex({ agents: mode, gateways }), {
        wrapper: createIndexWrapper(machineId, retiredProjectionLifetime, projectionServerId),
    });
}

const readPurposeCatalog = () => getConnectedAccountCatalogValue(runtime.accountScope, 'purposes');
const filterActionNoop = () => {};

describe('Connected Services index purpose source admission', () => {
    it('does no Agent sign-in receipt render work on account health changes and publishes changed purpose defaults', async () => {
        const scope = runtime.accountScope;
        if (!scope) throw new Error('The fixture requires an active Account scope');
        rowStatus = 'present';
        content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useAgentSignInTargets(); }, {
            wrapper: createIndexWrapper(null),
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().some(row => row.agent === 'Codex')).toBe(true));
            const heldRenders = renders;
            const held = hook.getCurrent();
            for (const status of ['connected', 'needs_reauth', 'refresh_failed_retryable']) {
                await act(async () => storage.getState().applyProfile(AccountProfileSchema.parse({ ...storage.getState().profile,
                    connectedAccountsV4: [{ ref: { service, accountId: 'work' }, status,
                        authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
                        configurationReady: true, configurationRevision: null }],
                })));
            }
            expect(renders).toBe(heldRenders);
            expect(hook.getCurrent()).toBe(held);
            content = { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } };
            await act(async () => refreshConnectedAccountCatalog(scope, 'purposes'));
            expect(hook.getCurrent().some(row => row.agent === 'Codex')).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('keeps a single-service sheet idle on another service health change and updates its own saved accounts', async () => {
        rowStatus = 'present';
        content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
        const request = { service };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useConnectAccountSheetModel(request, filterActionNoop); }, {
            wrapper: createIndexWrapper(null),
        });
        const otherService = { pluginId: 'acme.ledger', localId: 'ledger' };
        const ownAccount = { ref: { service, accountId: 'work' }, status: 'connected',
            authenticationModeId: 'oauth', revisionSemantics: 'legacy_unfenced', credentialRevision: null,
            configurationReady: true, configurationRevision: null };
        const apply = (status: string, ownStatus = 'connected') => storage.getState().applyProfile(AccountProfileSchema.parse({
            ...storage.getState().profile, connectedAccountsV4: [
                { ...ownAccount, status: ownStatus }, { ...ownAccount, ref: { service: otherService, accountId: 'other' }, status },
            ],
        }));
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('ready'));
            await act(async () => { apply('connected'); });
            const heldRenders = renders;
            const held = hook.getCurrent().savedAccounts;
            for (const status of ['needs_reauth', 'connected', 'refresh_failed_retryable']) {
                await act(async () => { apply(status); });
            }
            expect(renders).toBe(heldRenders);
            expect(hook.getCurrent().savedAccounts).toBe(held);
            await act(async () => { apply('connected', 'needs_reauth'); });
            expect(hook.getCurrent().savedAccounts).toEqual([expect.objectContaining({ status: 'needs_reauth' })]);
        } finally { await hook.unmount(); }
    });
    it('retains the Gateway place and exact refusal on a fresh catalog failure, then recovers Add', async () => {
        let releaseRead!: () => void;
        catalogReadGate = new Promise<void>(resolve => { releaseRead = resolve; });
        savedConnections = [];
        const hook = await mount('cached', null, false, true);
        try {
            const scope = { serverId: runtime.serverId, accountId: 'account-a' };
            await act(async () => { applyProviderCatalogSnapshot(scope, { status: 'unavailable', reason: 'encryption-material-unavailable' }, true); });
            expect(hook.getCurrent().gatewaySectionVisible).toBe(true);
            expect(hook.getCurrent().gatewayUnavailable).toEqual({ kind: 'catalog', catalog: { status: 'unavailable', reason: 'encryption-material-unavailable' } });
            expect(hook.getCurrent().gatewaysLoading).toBe(false);
            expect(hook.getCurrent().addGateway).toBeNull();
            releaseRead();
            await vi.waitFor(() => expect(hook.getCurrent().addGateway).toEqual(expect.any(Function)));
            expect(hook.getCurrent().gatewayUnavailable).toBeNull();
        } finally { releaseRead(); await hook.unmount(); }
    });
    it('admits the selected Machine when its consumer joins a pending generic purpose read', async () => {
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        beforeNextPurposeRead = async () => { markReadStarted(); await readGate; };
        const mountAgentUses = (mode: 'load' | 'cached', machineId: string | null) =>
            renderHook(() => useConnectedServicesAgentUses({ agents: mode }), { wrapper: createIndexWrapper(machineId) });
        const generic = await mountAgentUses('cached', null);
        let selected: Awaited<ReturnType<typeof mountAgentUses>> | undefined;
        try {
            await readStarted;
            selected = await mountAgentUses('load', 'm1');
            releaseRead();
            const expectedDefault = purposeValue.bindings[0]!.target;
            await vi.waitFor(() => expect(selected!.getCurrent().agentUses).toContainEqual(expect.objectContaining({
                title: 'Codex', defaults: [expectedDefault],
            })));
            expect(mutations).toEqual([expect.objectContaining({ expectedRevision: 'absent', sourceSettingsVersion: 7 })]);
            await vi.waitFor(() => expect(generic.getCurrent().agentUses).toContainEqual(expect.objectContaining({
                title: 'Codex', defaults: [expectedDefault],
            })));
        } finally {
            releaseRead();
            await selected?.unmount();
            await generic.unmount();
        }
    });
    it('lists an admitted Account gateway without a Machine despite an unrelated unavailable declaration', async () => {
        savedConnections = [gateway, ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_unknown',
            source: { kind: 'contribution', contributionKey: 'example.unknown/source' } })];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            await vi.waitFor(() => expect(hook.getCurrent().gateways).toEqual([
                expect.objectContaining({ connectionId: gateway.id, title: gateway.displayName }),
            ]));
            expect(hook.getCurrent().gatewayCatalog?.data?.connections[0]).toEqual(gateway);
            expect(hook.getCurrent().gatewaysKnown).toBe(false);
            expect(hook.getCurrent().addGateway).toBeNull();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('knows an authoritative empty gateway Account catalog without requesting a Machine', async () => {
        savedConnections = [];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            expect(hook.getCurrent().gateways).toEqual([]);
            expect(hook.getCurrent().gatewaysKnown).toBe(true);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('keeps the Gateway place unavailable when a managed source cannot be admitted', async () => {
        savedConnections = [ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_unknown',
            source: { kind: 'contribution', contributionKey: 'example.unknown/source' } })];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            expect(hook.getCurrent().gatewaySectionVisible).toBe(true);
            expect(hook.getCurrent().gatewayUnavailable).toEqual({ kind: 'declaration' });
            expect(hook.getCurrent().addGateway).toBeNull();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('keeps the known gateways listed while the Account catalog reloads, without offering another', async () => {
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gateways).toEqual([expect.objectContaining({ connectionId: gateway.id })]));
            await act(async () => { beginProviderCatalogLoad({ serverId: runtime.serverId, accountId: 'account-a' }); });
            expect(hook.getCurrent().gateways).toEqual([expect.objectContaining({ connectionId: gateway.id })]);
            expect(hook.getCurrent().addGateway).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('keeps an empty Gateways group while the Account catalog reloads, but adds only once it is current', async () => {
        savedConnections = [];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().addGateway).toEqual(expect.any(Function)));
            await act(async () => { beginProviderCatalogLoad({ serverId: runtime.serverId, accountId: 'account-a' }); });
            expect(hook.getCurrent().gateways).toEqual([]);
            expect(hook.getCurrent().addGateway).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('holds the Gateways group while the first Account catalog loads, and names what a gateway draws on', async () => {
        let releaseRead!: () => void;
        catalogReadGate = new Promise<void>((resolve) => { releaseRead = resolve; });
        savedConnections = [ProviderConnectionV1Schema.parse({ ...gateway, purposeBindingDefaults: {
            'anthropic-upstream': { kind: 'account', account: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' } },
        } })];
        const hook = await mount('cached', null, false, true);
        try {
            expect(hook.getCurrent().gateways).toBeNull();
            expect(hook.getCurrent().gatewaysLoading).toBe(true);
            releaseRead();
            await vi.waitFor(() => expect(hook.getCurrent().gateways).toEqual([expect.objectContaining({ connectionId: gateway.id })]));
            expect(hook.getCurrent().gatewaysLoading).toBe(false);
            expect(hook.getCurrent().gateways?.[0]?.summary).toMatch(/claude/i);
        } finally { releaseRead(); await hook.unmount(); }
    });
    it('adds a first gateway from an empty Account: one managed connection, no slot yet, on, then its page', async () => {
        savedConnections = [];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().addGateway).toEqual(expect.any(Function)));
            let route: string | null = null;
            await act(async () => { route = await hook.getCurrent().addGateway!(); });
            const created = providerCatalog?.connections ?? [];
            expect(created).toEqual([expect.objectContaining({ displayName: t('settingsProvidersCollection.gateway.mainGatewayName'), deployment: { kind: 'managedLocal' },
                source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' }, purposeBindingDefaults: {} })]);
            expect(providerCatalog?.accountGrants.map(grant => grant.connectionId)).toEqual([created[0]!.id]);
            expect(route).toBe(`/(app)/settings/providers/${created[0]!.id}`);
            await vi.waitFor(() => expect(hook.getCurrent().gateways).toEqual([expect.objectContaining({ connectionId: created[0]!.id })]));
            expect(hook.getCurrent().addGateway).toBeNull();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('knows external-only Account connections contain no gateways without requesting a Machine', async () => {
        const { gatewayPlacement: _placement, claudeHelperModels: _helpers, ...base } = gateway;
        savedConnections = [ProviderConnectionV1Schema.parse({ ...base, deployment: { kind: 'external' } })];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            expect(hook.getCurrent().gateways).toEqual([]);
            expect(hook.getCurrent().gatewaysKnown).toBe(true);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('knows admitted bundled Agent purposes with no machine after the Account row loads', async () => {
        rowStatus = 'present';
        content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
        const hook = await mount('load', null);
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('ready'));
            expect(hook.getCurrent().agentsKnown).toBe(true);
            expect(hook.getCurrent().agentEntries).toEqual(expect.arrayContaining([
                expect.objectContaining({ identity: consumer, connectedAccounts: expect.arrayContaining([
                    expect.objectContaining({ service }),
                ]) }),
            ]));
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });

    it('does not activate retained defaults with a retired Machine admission from the same Account id', async () => {
        const hook = await mount('load', 'm1', true);
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('unavailable'));
            expect(mutations).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it.each([
        { mode: 'load' as const, machineId: 'm1', status: 'ready' },
        { mode: 'cached' as const, machineId: 'm1', status: 'unavailable' },
        { mode: 'load' as const, machineId: null, status: 'unavailable' },
    ])('admits ordinary predecessor defaults only with its explicitly demanded scoped Machine: %j', async ({ mode, machineId, status }) => {
        const hook = await mount(mode, machineId);
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe(status));
            if (status === 'ready') {
                expect(readPurposeCatalog().value).toEqual(purposeValue);
                expect(mutations).toEqual([expect.objectContaining({ expectedRevision: 'absent', sourceSettingsVersion: 7 })]);
            } else {
                expect(mutations).toEqual([]);
                expect(machineRpc).not.toHaveBeenCalled();
            }
        } finally { await hook.unmount(); }
    });
    it.each(['present', 'deleted'] as const)('treats an admitted %s row as authority without requesting a Machine', async (status) => {
        rowStatus = status;
        content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
        const hook = await mount('cached', 'm1');
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('ready'));
            expect(readPurposeCatalog().value).toEqual(status === 'present' ? purposeValue : { v: 1, bindings: [] });
            expect(mutations).toEqual([]);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('reads active Account gateways rather than a stale foreign app-shell Machine projection', async () => {
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const foreign = await upsertServerProfileOnly({ serverUrl: 'https://foreign-index.test', name: 'Foreign index Home' });
        const hook = await mount('cached', 'm1', false, true, foreign.id);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gateways).toEqual([
                expect.objectContaining({ connectionId: gateway.id, title: gateway.displayName }),
            ]));
            expect(hook.getCurrent().gatewayCatalog?.scope?.serverId).toBe(runtime.serverId);
            expect(providerRowHomes.length).toBeGreaterThan(0);
            expect(providerRowHomes.every(origin => origin === 'https://session-pane.test')).toBe(true);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(mutations).toEqual([]);
        } finally { await hook.unmount(); }
    });

});
