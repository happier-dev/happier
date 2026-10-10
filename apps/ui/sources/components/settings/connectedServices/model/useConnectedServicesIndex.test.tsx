import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { resetConnectedAccountCatalogEngineForTests } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resetProviderCatalogEngineForTests } from '@/sync/engine/settings/providerCatalogEngine';
import { resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { useConnectedServicesIndex } from './useConnectedServicesIndex';

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
} } };
const gateway = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_gateway',
    source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
    role: 'named', displayName: 'Subscriptions', displayNameMode: 'custom', deployment: { kind: 'managedLocal' },
    gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, claudeHelperModels: { fast: 'haiku' },
    revision: 3, createdAt: 1, updatedAt: 1 });
const mutations: ConnectedAccountCatalogRowMutationV1[] = [];
let savedConnections: readonly ProviderConnectionV1[] = [gateway];
let rowStatus: 'absent' | 'present' | 'deleted' = 'absent';
let content: ConnectedAccountCatalogRowMutationV1['content'] | null = null;
let beforeNextPurposeRead: (() => Promise<void>) | undefined;

beforeEach(() => {
    savedConnections = [gateway];
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
        if (path === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
            content: { t: 'plain', v: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: savedConnections } } });
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

async function mount(mode: 'load' | 'cached', machineId: string | null, retiredProjectionLifetime = false, gateways = false) {
    const scope = { serverId: runtime.serverId, accountId: 'account-a' };
    storage.setState({ profileScope: scope, settingsScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })], true, { sourceServerId: scope.serverId });
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
        phase: 'unavailable', interactionEnabled: false, machineId, serverId: scope.serverId, platform: 'web',
        accountLifetime: lifetime, reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {} };
    const Wrapper = ({ children }: { children: React.ReactNode }) => <runtime.Wrapper>
        <AppShellPluginUiProjectionValueProvider value={value}>{children}</AppShellPluginUiProjectionValueProvider>
    </runtime.Wrapper>;
    return renderHook(() => useConnectedServicesIndex({ agents: mode, gateways }), { wrapper: Wrapper });
}

describe('Connected Services index purpose source admission', () => {
    it('admits the selected Machine when its consumer joins a pending generic purpose read', async () => {
        let releaseRead!: () => void;
        let markReadStarted!: () => void;
        const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
        const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
        beforeNextPurposeRead = async () => { markReadStarted(); await readGate; };
        const generic = await mount('cached', null);
        let selected: Awaited<ReturnType<typeof mount>> | undefined;
        try {
            await readStarted;
            selected = await mount('load', 'm1');
            releaseRead();
            await vi.waitFor(() => expect(selected!.getCurrent().purposeCatalog.status).toBe('ready'));
            expect(selected.getCurrent().purposeCatalog.value).toEqual(purposeValue);
            expect(mutations).toEqual([expect.objectContaining({ expectedRevision: 'absent', sourceSettingsVersion: 7 })]);
            await vi.waitFor(() => expect(generic.getCurrent().purposeCatalog.value).toEqual(purposeValue));
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
            await vi.waitFor(() => expect(hook.getCurrent().purposeCatalog.status).toBe('ready'));
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
            await vi.waitFor(() => expect(hook.getCurrent().purposeCatalog.status).toBe('unavailable'));
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
            await vi.waitFor(() => expect(hook.getCurrent().purposeCatalog.status).toBe(status));
            if (status === 'ready') {
                expect(hook.getCurrent().purposeCatalog.value).toEqual(purposeValue);
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
            await vi.waitFor(() => expect(hook.getCurrent().purposeCatalog.status).toBe('ready'));
            expect(hook.getCurrent().purposeCatalog.value).toEqual(status === 'present' ? purposeValue : { v: 1, bindings: [] });
            expect(mutations).toEqual([]);
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
});
