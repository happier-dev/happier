import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ConnectedAccountCatalogRowMutationV1Schema, type ConnectedAccountCatalogRowMutationV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { useConnectAccountSheetModel } from '../setup/useConnectAccountSheetModel';
import { useAgentSignInTargets } from '../defaults/useAgentSignInTargets';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { renderHook, renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, refreshAuthenticatedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { advanceConnectedAccountDescriptorProjectionState, createConnectedAccountDescriptorProjectionLoadingState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { storage } from '@/sync/domains/state/storageStore';
import { refreshConnectedAccountCatalog, resetConnectedAccountCatalogEngineForTests } from '@/sync/engine/settings/connectedAccountCatalogEngine';
import { resetConnectedAccountCatalogSnapshotsForTests } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { applyConnectedAccountCatalogSnapshot, beginConnectedAccountCatalogLoad, getConnectedAccountCatalogValue } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { ProviderConnectionV1Schema, type ProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/v1';
import { ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema,
    type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { resetProviderCatalogEngineForTests } from '@/sync/engine/settings/providerCatalogEngine';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { applyProviderCatalogSnapshot, beginProviderCatalogLoad, resetProviderCatalogSnapshotsForTests } from '@/sync/store/settings/providerCatalogSnapshot';
import { connectedServicesModuleState, installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';
import { useConnectedServicesIndex } from './useConnectedServicesIndex';
import { useConnectedServicesAgentUses } from './useConnectedServicesAgents';
import { ConnectedServicesSettingsView } from '../ConnectedServicesSettingsView';
import { ConnectedServicesSettingsLayout } from '../collection/ConnectedServicesSettingsLayout';
import { ConnectedServicesRailView } from '../collection/ConnectedServicesRail';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';

// P8 / O-COLUMNS-R3: the retained page cost contract measures the All services overview.
installConnectedServicesCommonModuleMocks({ searchParams: { view: 'all' } });
// Gateway summaries use the real translation owner, independent of the screen fixture's key labels.
const { t } = await vi.importActual<typeof import('@/text')>('@/text');
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
    gatewayPlacement: { kind: 'machine', machineId: 'hub-a' }, roleModels: { fast: 'haiku' },
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
let purposeReads = 0;
let qualifiedAccountsAvailable = false;

beforeEach(() => {
    connectedServicesModuleState.searchParams = { view: 'all' };
    providerRowHomes.length = 0;
    savedConnections = [gateway]; providerCatalog = null; providerRevision = 1; catalogReadGate = null;
    rowStatus = 'absent'; content = null; mutations.length = 0; machineRpc.mockReset();
    beforeNextPurposeRead = undefined;
    purposeReads = 0;
    qualifiedAccountsAvailable = false;
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
    features: () => createRootLayoutFeaturesResponse(qualifiedAccountsAvailable ? {
        capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
    } : {}),
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
            purposeReads += 1;
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

function createIndexWrapper(machineId: string | null, retiredProjectionLifetime = false,
    projectionServerId = runtime.serverId, readConnectedAccountProjectionRevision?: () => number) {
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
        <AppShellPluginUiProjectionValueProvider value={readConnectedAccountProjectionRevision
            ? { ...value, connectedAccountProjectionRevision: readConnectedAccountProjectionRevision() } : value}>{children}</AppShellPluginUiProjectionValueProvider>
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

const FILTER_ACTION_LABELS: Readonly<Record<string, string | undefined>> = {};
const filterActionNoop = () => {};
const filterActionPresent: ConnectedAccountIdentityPresenter = (input) => presentConnectedAccountIdentity({
    ...input, hidden: false, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
});

function MountedFilterActionColumn() {
    const { indexModel } = useConnectedServicesIndex({ agents: 'cached' });
    return <ConnectedServicesRailView model={indexModel} labelsByKey={FILTER_ACTION_LABELS} selection={{ kind: 'index' }}
        present={filterActionPresent} identitiesHidden={false} onSetIdentitiesHidden={filterActionNoop}
        onConnect={filterActionNoop} onOpenIndex={filterActionNoop} onOpenService={filterActionNoop}
        onOpenAccount={filterActionNoop} onOpenPool={filterActionNoop} onOpenAgentSignIn={filterActionNoop}
        renderAccountMeta={() => null} />;
}

describe('Connected Services index purpose source admission', () => {
    it.each([0, 79])('keeps Hetzner offered with %s unreachable Machines and acquires only the selected Machine per sheet open', async (offlineCount) => {
        qualifiedAccountsAvailable = true;
        await refreshAuthenticatedServerFeaturesSnapshot({ serverId: runtime.serverId, credentials: runtime.credentials, force: true });
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const Wrapper = createIndexWrapper('m1');
        storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() }),
            ...Array.from({ length: offlineCount }, (_, index) => createMachineFixture({ id: `retired-${index}`, active: false, activeAt: 1 })),
        ], true, { sourceServerId: runtime.serverId });
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected sheet Account lifetime');
        const state = advanceConnectedAccountDescriptorProjectionState(
            createConnectedAccountDescriptorProjectionLoadingState('fleet'),
            { kind: 'error', reason: 'partial_machine_failure', descriptors: [], conflicts: [] });
        installConnectedAccountDescriptorProjection(state, lifetime);
        machineRpc.mockClear();
        const hook = await renderHook(() => useConnectAccountSheetModel({ intent: 'add' }, filterActionNoop), { wrapper: Wrapper });
        try {
            await vi.waitFor(() => expect(machineRpc).toHaveBeenCalled());
            const targets = machineRpc.mock.calls.map(([request]) => request.machineId);
            expect(targets).toEqual(['m1']);
            await vi.waitFor(() => expect(hook.getCurrent().catalog.find(entry => entry.service.pluginId === 'happier.machine.hetzner'
                && entry.service.localId === 'hetzner-account')).toMatchObject({ canAdd: true, category: 'cloud-machines' }));
            // The full-answer boundary fixture needs one selected-Machine read,
            // even after the sheet settles with a retired fleet in the inventory.
            expect(machineRpc.mock.calls.map(([request]) => request.machineId)).toEqual(['m1']);
        } finally { await hook.unmount(); retireConnectedAccountDescriptorProjection(lifetime); }
    });

    it.each([3, 30])('keeps the index quiet while %s other Machines open their content, and offers them all in the Connect sheet', async (others) => {
        const Wrapper = createIndexWrapper('m1');
        const fleet = Array.from({ length: others }, (_, index) => createMachineFixture({ id: `other-${index}`, active: false, activeAt: 1,
            metadata: null, metadataVersion: 1, daemonStateVersion: 5 }));
        storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() }), ...fleet], true, { sourceServerId: runtime.serverId });
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useConnectedServicesIndex({ agents: 'load' }); }, { wrapper: Wrapper });
        const sheet = await renderHook(() => useConnectAccountSheetModel({ intent: 'add' }, filterActionNoop), { wrapper: Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().agentsKnown).toBe(true));
            expect(hook.getCurrent().targetSelection.selectedTarget?.machineId).toBe('m1');
            await act(async () => {});
            renders = 0;
            // Row-by-row content opening of the rest of the fleet, as a large Account hydrates.
            for (const machine of fleet) {
                await act(async () => storage.getState().applyMachines([{ ...machine, metadataVersion: 2, daemonStateVersion: 6,
                    metadata: { ...createMachineFixture().metadata!, displayName: `Opened ${machine.id}` } }], false,
                    { sourceServerId: runtime.serverId }));
            }
            expect(renders).toBe(0);
            // The chooser leaf still offers every Machine, with its opened label.
            await vi.waitFor(() => expect(sheet.getCurrent().targetSelection.candidates.map(candidate => candidate.displayName))
                .toEqual(expect.arrayContaining(fleet.map(machine => `Opened ${machine.id}`))));
            // Positive control: the selected Machine's own label is a real input.
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now(), metadataVersion: 2,
                metadata: { ...createMachineFixture().metadata!, displayName: 'Renamed selected' } })], false, { sourceServerId: runtime.serverId }));
            await vi.waitFor(() => expect(renders).toBeGreaterThan(0));
        } finally { await sheet.unmount(); await hook.unmount(); }
    });

    it.each([3, 30])('keeps the index quiet without a stored choice while %s online Machines open their content', async (others) => {
        const Wrapper = createIndexWrapper(null);
        const fleet = Array.from({ length: others }, (_, index) => createMachineFixture({ id: `online-${index}`, activeAt: Date.now(),
            metadata: null, metadataVersion: 1, daemonStateVersion: 5 }));
        storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() }), ...fleet], true, { sourceServerId: runtime.serverId });
        storage.getState().markMachineListSettled(runtime.serverId);
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useConnectedServicesIndex({ agents: 'load' }); }, { wrapper: Wrapper });
        try {
            await act(async () => {});
            expect(hook.getCurrent().targetSelection.selectedTarget).toBeNull();
            renders = 0;
            for (const machine of fleet) {
                await act(async () => storage.getState().applyMachines([{ ...machine, metadataVersion: 2, daemonStateVersion: 6,
                    metadata: { ...createMachineFixture().metadata!, displayName: `Opened ${machine.id}` } }], false,
                    { sourceServerId: runtime.serverId }));
            }
            expect(renders).toBe(0);
            // Eligibility changes that leave two or more automatic candidates change no choice.
            const goOffline = (machineId: string) => act(async () => storage.getState().applyMachines([{
                ...storage.getState().machines[machineId]!, revokedAt: Date.now() }], false, { sourceServerId: runtime.serverId }));
            for (const machine of fleet.slice(0, -1)) await goOffline(machine.id);
            expect(renders).toBe(0);
            expect(hook.getCurrent().targetSelection.selectedTarget).toBeNull();
            // Positive control: the flip that leaves one automatic candidate chooses it.
            await goOffline(fleet.at(-1)!.id);
            await vi.waitFor(() => expect(hook.getCurrent().targetSelection.selectedTarget?.machineId).toBe('m1'));
        } finally { await hook.unmount(); }
    });

    it('retains the Home setup model when Machine publications only advance plugin availability observation time', async () => {
        const scope = runtime.accountScope;
        if (!scope) throw new Error('The fixture requires an active Account scope');
        const publish = (availabilityCursor: number, inventoryComplete: boolean) => replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: { availabilityCursor, intentReads: [], materializations: [], snapshots: [], inventoryComplete },
        });
        await act(async () => publish(1, true));
        const hook = await mount('cached', null);
        try {
            const seen = new Set([hook.getCurrent().indexModel]);
            for (let cursor = 2; cursor <= 6; cursor++) {
                await act(async () => publish(cursor, true));
                seen.add(hook.getCurrent().indexModel);
            }
            expect(seen.size - 1).toBe(0);
            await act(async () => publish(7, false));
            expect(hook.getCurrent().indexModel).not.toBe([...seen][0]);
        } finally { await hook.unmount(); }
    });

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
        const request = { service, intent: 'link' as const };
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
    it.each([true, false])('keeps saved tool classification and rail identity through equal purpose refreshes (cold=%s), and publishes changed defaults', async (cold) => {
        qualifiedAccountsAvailable = true;
        // Drain the real bootstrap reads before seeding the saved Account projection.
        const { sync } = await import('@/sync/sync');
        await sync.refreshProfile();
        await refreshAuthenticatedServerFeaturesSnapshot({ serverId: runtime.serverId, credentials: runtime.credentials, force: true });
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            capabilities: { connectedServices: { ...createRootLayoutFeaturesResponse().capabilities.connectedServices,
                qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        rowStatus = 'present';
        content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
        const Wrapper = createIndexWrapper(null);
        const tool = { pluginId: 'acme.ledger', localId: 'ledger' };
        const savedProfile = AccountProfileSchema.parse({ id: 'account-a',
            connectedAccountsV4: [service, tool].map(service => ({ ref: { service, accountId: 'work' }, status: 'connected',
                authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                configurationReady: true, configurationRevision: null })),
        });
        storage.getState().applyProfile(savedProfile);
        let releaseRead!: () => void;
        const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
        beforeNextPurposeRead = () => readGate;
        const renderAccountMeta = vi.fn(() => null);
        const railProps = { labelsByKey: FILTER_ACTION_LABELS, selection: { kind: 'index' as const },
            present: filterActionPresent, identitiesHidden: false, onSetIdentitiesHidden: filterActionNoop,
            onConnect: filterActionNoop, onOpenIndex: filterActionNoop, onOpenService: filterActionNoop,
            onOpenAccount: filterActionNoop, onOpenPool: filterActionNoop, onOpenAgentSignIn: filterActionNoop,
            renderAccountMeta };
        let current!: ReturnType<typeof useConnectedServicesIndex>;
        let columnRenders = 0;
        function Column() {
            columnRenders += 1;
            current = useConnectedServicesIndex({ agents: 'cached' });
            return <ConnectedServicesRailView {...railProps} model={current.indexModel} />;
        }
        const screen = await renderScreen(<Column />, { wrapper: Wrapper });
        await act(async () => { storage.getState().applyProfile(savedProfile); });
        const scope = { serverId: runtime.serverId, accountId: 'account-a' };
        const toolSheet = () => current.indexModel.sheets.find(sheet => sheet.service.pluginId === tool.pluginId);
        try {
            await vi.waitFor(() => expect(current.indexModel.sheets).toHaveLength(2));
            expect(readPurposeCatalog().status).toBe('loading');
            if (cold) {
                expect(toolSheet()?.section).toBe('tools');
                return;
            }
            releaseRead();
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('ready'));
            await act(async () => { storage.getState().applyProfile(savedProfile); });
            expect(current.indexModel.sheets).toHaveLength(2);
            expect(renderAccountMeta.mock.calls.length).toBeGreaterThan(0);
            const held = current.indexModel;
            const heldRenders = columnRenders;
            renderAccountMeta.mockClear();
            for (let refresh = 0; refresh < 3; refresh += 1) {
                await act(async () => { await refreshConnectedAccountCatalog(scope, 'purposes'); });
            }
            expect(renderAccountMeta.mock.calls.length).toBe(0);
            expect(columnRenders).toBe(heldRenders);
            expect(current.indexModel).toBe(held);
            await act(async () => { beginConnectedAccountCatalogLoad(scope, 'purposes'); });
            expect(toolSheet()?.section).toBe('tools');
            expect(current.indexModel).toBe(held);
            await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes',
                { status: 'unavailable', reason: 'unreachable' }, true); });
            expect(toolSheet()?.section).toBe('tools');
            expect(current.indexModel).toBe(held);
            content = { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } };
            await act(async () => { await refreshConnectedAccountCatalog(scope, 'purposes'); });
            expect(current.indexModel.sheets.find(sheet => sheet.service.pluginId === service.pluginId)
                ?.rolesByAccountId.work.defaultFor).toEqual([]);
            expect(renderAccountMeta.mock.calls.length).toBeGreaterThan(0);
            expect(toolSheet()?.section).toBe('tools');
        } finally { releaseRead(); await screen.unmount(); }
    });

    it('applies scoped filter Actions to the real mounted Settings column without reads or persistence', async () => {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { invokeScopeAction } = await import('@/sync/ops/actions/scopeActionFamily');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const Wrapper = createIndexWrapper(null);
        const column = (visible: boolean) => <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}>
            <MountedFilterActionColumn />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(column(true), { wrapper: Wrapper });
        try {
            await act(async () => { storage.getState().applyProfile(AccountProfileSchema.parse({ id: 'account-a',
                connectedAccountsV4: ['work', 'personal'].map((accountId, index) => ({ ref: { service, accountId },
                    status: index === 0 ? 'connected' : 'needs_reauth', providerIdentity: { email: `${accountId}@example.test` },
                    authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationReady: true, configurationRevision: null })),
            })); });
            const rowId = (accountId: string) => `connected-services-rail:account:${service.pluginId}/${service.localId}:${accountId}`;
            await vi.waitFor(() => expect(screen.findHostByTestId(rowId('work'))).not.toBeNull());
            expect(screen.findHostByTestId(rowId('personal'))).not.toBeNull();
            const action = createDefaultActionExecutor();
            const target = { column: 'connected-services' as const, serverId: runtime.serverId, accountId: 'account-a' };
            const context = { surface: 'agent' as const, serverId: runtime.serverId };
            expect(await action.execute('settings.column.filter.get', target, context)).toMatchObject({ ok: true,
                result: { ...target, filters: {}, matchedCount: 2, coverage: 'complete' } });
            const reads = purposeReads;
            const rpcCount = machineRpc.mock.calls.length;
            const filters = { status: { include: ['needs_reauth'], exclude: [] } };
            await act(async () => {
                expect(await action.execute('settings.column.filter.set', { ...target, filters }, context))
                    .toEqual({ ok: true, result: { ok: true } });
            });
            expect(screen.findHostByTestId(rowId('work'))).toBeNull();
            expect(screen.findHostByTestId(rowId('personal'))).not.toBeNull();
            expect(await action.execute('settings.column.filter.get', target, context)).toMatchObject({ ok: true,
                result: { filters, matchedCount: 1, coverage: 'complete' } });
            expect(await action.execute('settings.column.filter.set', { ...target,
                filters: { foreign: { include: ['ignored'], exclude: [] } } }, context))
                .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
            expect(await action.execute('settings.column.filter.clear', { ...target, accountId: 'another-account' }, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            expect(await invokeScopeAction('settings.column.filter.clear', target, { serverId: 'another-home' }))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            expect(screen.findHostByTestId(rowId('work'))).toBeNull();
            expect(purposeReads).toBe(reads);
            expect(machineRpc.mock.calls.length).toBe(rpcCount);
            expect(mutations).toEqual([]);
            await screen.update(column(false));
            expect(await action.execute('settings.column.filter.get', target, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            await screen.update(column(true));
            expect(await action.execute('settings.column.filter.get', target, context))
                .toMatchObject({ ok: true, result: { filters } });
            // Reopening renews the column's existing source observation. Only Action work is read-free.
            const reopenedReads = purposeReads;
            const reopenedRpcCount = machineRpc.mock.calls.length;
            await act(async () => {
                expect(await action.execute('settings.column.filter.clear', target, context))
                    .toEqual({ ok: true, result: { ok: true } });
            });
            expect(screen.findHostByTestId(rowId('work'))).not.toBeNull();
            expect(purposeReads).toBe(reopenedReads);
            expect(machineRpc.mock.calls.length).toBe(reopenedRpcCount);
            expect(mutations).toEqual([]);
            // Two eligible instances may not silently choose whichever registered last.
            await screen.update(<>{column(true)}{column(true)}</>);
            expect(await action.execute('settings.column.filter.get', target, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            await screen.update(column(true));
            await act(async () => {
                expect(await action.execute('settings.column.filter.set', { ...target, filters }, context))
                    .toEqual({ ok: true, result: { ok: true } });
            });
            // A retained hook is not a saved filter: a different Account starts with its own draft.
            await act(async () => { await runtime.restoreRealm({ accountId: 'account-b' }); });
            await screen.update(column(true));
            const nextTarget = { ...target, accountId: 'account-b' };
            expect(await action.execute('settings.column.filter.get', nextTarget, context))
                .toMatchObject({ ok: true, result: { filters: {} } });
            expect(await action.execute('settings.column.filter.clear', target, context))
                .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            await act(async () => {
                retireActiveServerAccountScopeLifetime();
                expect(await invokeScopeAction('settings.column.filter.clear', nextTarget, context))
                    .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
            });
        } finally { await screen.unmount(); }
    });

    it('projects held Agent pool defaults separately from a pool choosing an account, without extra reads', async () => {
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const poolTarget = { kind: 'group' as const, service, groupId: 'codex-pool' };
        rowStatus = 'present';
        content = { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{
            purpose: { consumer, purpose: 'primary' }, target: poolTarget,
        }] } } };
        const hook = await mount('cached', null);
        try {
            await vi.waitFor(() => expect(readPurposeCatalog().status).toBe('ready'));
            await act(async () => { storage.getState().applyProfile(AccountProfileSchema.parse({ id: 'account-a',
                connectedAccountsV4: ['work', 'spare'].map(accountId => ({ ref: { service, accountId }, status: 'connected',
                    authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
                    configurationReady: true, configurationRevision: null })),
                connectedAccountGroupsV4: [{ v: 1, ref: { service, groupId: poolTarget.groupId }, incarnation: 'pool-life',
                    displayName: 'Codex pool', policy: {}, activeConnectedAccountId: 'work', generation: 1,
                    runtimeStateRevision: 0, state: {}, createdAt: 0, updatedAt: 0,
                    members: ['work', 'spare'].map((connectedAccountId, priority) => ({ v: 1, connectedAccountId,
                        priority, enabled: true, state: {}, createdAt: 0, updatedAt: 0 })) }],
            })); });
            const sheet = () => hook.getCurrent().indexModel.sheets.find(row => row.serviceKey === `${service.pluginId}/${service.localId}`);
            expect(sheet()?.pools[0]?.defaultFor).toContain('Codex');
            expect(sheet()?.rolesByAccountId.work).toEqual({ pools: [{ groupId: poolTarget.groupId, inUse: true }], defaultFor: [] });
            expect(sheet()?.rolesByAccountId.spare).toEqual({ pools: [{ groupId: poolTarget.groupId, inUse: false }], defaultFor: [] });
            const held = hook.getCurrent().indexModel;
            const reads = purposeReads;
            await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, firstName: 'Unrelated arrival' }); });
            expect(hook.getCurrent().indexModel).toBe(held);
            expect(purposeReads).toBe(reads);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(mutations).toEqual([]);
            // The pool's chosen member is not evidence that any Agent defaults to it.
            content = { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } };
            await act(async () => { await refreshConnectedAccountCatalog({ serverId: runtime.serverId, accountId: 'account-a' }, 'purposes'); });
            expect(sheet()?.pools[0]?.defaultFor).toEqual([]);
            expect(sheet()?.rolesByAccountId.work).toEqual({ pools: [{ groupId: poolTarget.groupId, inUse: true }], defaultFor: [] });
            content = { t: 'plain', v: { key: 'purposes', value: purposeValue } };
            await act(async () => { await refreshConnectedAccountCatalog({ serverId: runtime.serverId, accountId: 'account-a' }, 'purposes'); });
            expect(sheet()?.rolesByAccountId.work.defaultFor).toContain('Codex');
            expect(sheet()?.pools[0]?.defaultFor).toEqual([]);
            expect(purposeReads).toBe(reads + 2);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(mutations).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('names held gateway services and only Agents whose exact saved default selects that gateway', async () => {
        savedConnections = [ProviderConnectionV1Schema.parse({ ...gateway, purposeBindingDefaults: {
            'openai-upstream': { kind: 'account', account: { service, accountId: 'work' } },
        } })];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            const services = t('connectedServices.serviceNames.openaiCodex');
            expect(hook.getCurrent().gateways?.[0]?.summary).toBe(t('connectedServicesCollection.railGatewayServes', { services }));
            const opencode = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } });
            const codex = buildBackendTargetKeyV2({ kind: 'agent', identity: consumer });
            const unknown = buildBackendTargetKeyV2({ kind: 'agent', identity: { pluginId: 'acme.unknown', localId: 'agent' } });
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                providerDefaultModelSelectionsByAgentTargetKeyV1: ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse({
                    [opencode]: { v: 1, ref: { agentTargetKey: opencode, providerConnectionId: gateway.id, modelId: 'gpt-5' }, updatedAt: 1 },
                    [codex]: { v: 1, ref: { agentTargetKey: codex, providerConnectionId: 'pc_other', modelId: 'gpt-5' }, updatedAt: 1 },
                    [unknown]: { v: 1, ref: { agentTargetKey: unknown, providerConnectionId: gateway.id, modelId: 'gpt-5' }, updatedAt: 1 },
                }),
            } })); });
            const agents = hook.getCurrent().agentEntries.find(agent => agent.agentId === 'opencode')!.title;
            expect(hook.getCurrent().gateways?.[0]?.summary).toBe(t('connectedServicesCollection.railGatewayServesTo', { services, agents }));
            // The gateway's Used by names the same Agents, with their ids for their marks.
            expect(hook.getCurrent().gateways?.[0]?.agents).toEqual([{ agentId: 'opencode', title: agents }]);
            expect(machineRpc).not.toHaveBeenCalled();
            expect(providerCatalog).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('keeps gateway consumers targetable when the Machine catalog includes an unconfigured contribution', async () => {
        const dynamic = { pluginId: 'acme.agents', localId: 'opencode' };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 2, agentsById: {
            codex: { id: 'codex', identity: consumer, isBuiltIn: true, title: 'Codex' },
            'acme.agents/opencode': { id: 'acme.agents/opencode', identity: dynamic, isBuiltIn: false, title: 'Review agent' },
            'custom-acp': { id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
                isBuiltIn: true, title: 'Custom ACP' },
        } });
        machineRpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection } : { error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' });
        savedConnections = [ProviderConnectionV1Schema.parse({ ...gateway, purposeBindingDefaults: {
            'openai-upstream': { kind: 'account', account: { service, accountId: 'work' } },
        } })];
        const hook = await mount('load', 'm1', false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().agentEntries.some(agent => agent.title === 'Review agent')).toBe(true));
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            expect(hook.getCurrent().agentEntries.find(agent => agent.agentId === 'custom-acp'))
                .toMatchObject({ identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, backendTargetKey: null });
            const keys = [consumer, dynamic].map(identity => buildBackendTargetKeyV2({ kind: 'agent', identity }));
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                providerDefaultModelSelectionsByAgentTargetKeyV1: ProviderDefaultModelSelectionsByAgentTargetKeyV1Schema.parse(Object.fromEntries(keys.map(agentTargetKey => [agentTargetKey,
                    { v: 1, ref: { agentTargetKey, providerConnectionId: gateway.id, modelId: 'gpt-5' }, updatedAt: 1 }]))),
            } })); });
            expect(hook.getCurrent().gateways?.[0]?.summary).toBe(t('connectedServicesCollection.railGatewayServesTo', {
                services: t('connectedServices.serviceNames.openaiCodex'), agents: 'Codex · Review agent',
            }));
            expect(hook.getCurrent().gateways?.[0]?.agents.map(agent => agent.title)).toEqual(['Codex', 'Review agent']);
            const rpcCount = machineRpc.mock.calls.length;
            const providerReads = providerRowHomes.length;
            const heldGateways = hook.getCurrent().gateways;
            await act(async () => { storage.getState().applyProfile({ ...storage.getState().profile, firstName: 'Unrelated arrival' }); });
            expect(hook.getCurrent().gateways).toBe(heldGateways);
            expect(machineRpc.mock.calls).toHaveLength(rpcCount);
            expect(providerRowHomes).toHaveLength(providerReads);
        } finally { await hook.unmount(); }
    });
    it('counts added gateways from exact held connection sources, retaining unknown while the catalog loads', async () => {
        savedConnections = [gateway, ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_second' }), ProviderConnectionV1Schema.parse({ ...gateway, id: 'pc_local',
            source: { kind: 'contribution', contributionKey: 'happier.provider.ollama/ollama' } })];
        let release!: () => void;
        catalogReadGate = new Promise<void>(resolve => { release = resolve; });
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(providerRowHomes.length).toBeGreaterThan(0));
            expect(hook.getCurrent()).toHaveProperty('gatewayCountsByContributionKey', null);
            await act(async () => { release(); });
            await vi.waitFor(() => expect(hook.getCurrent()).toHaveProperty('gatewayCountsByContributionKey', {
                'happier.provider.cliproxyapi/cliproxyapi': 2,
            }));
            expect(providerCatalog).toBeNull();
        } finally { release(); await hook.unmount(); }
    });
    it('does no retained-page render work for unrelated Profile, Session, Machine and Gateway arrivals while hidden, and reopens current accounts', async () => {
        const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
        const { router } = await import('expo-router');
        const native = await import('react-native');
        vi.spyOn(native, 'useWindowDimensions').mockReturnValue({ width: 1440, height: 940, scale: 1, fontScale: 1 });
        const Wrapper = createIndexWrapper(null);
        let commits = 0;
        let indexRenders = 0;
        function IndexProbe() {
            useConnectedServicesIndex({ agents: 'load', gateways: true });
            indexRenders += 1;
            return null;
        }
        const content = <React.Profiler id="connected-services-retained" onRender={() => { commits += 1; }}>
            <ConnectedServicesSettingsLayout />
            <ConnectedServicesSettingsView />
        </React.Profiler>;
        let currentFocus = true;
        const page = (visible: boolean) => {
            currentFocus = visible;
            return <Wrapper><DestinationInstanceContext.Provider value={{ tabId: 'services-overview',
                ref: { kind: 'settings', params: { view: 'all' } }, pathname: '/settings/connected-services',
                focused: visible, isFocused: () => currentFocus, visible, navigation: router,
            }}>
                <PluginSurfaceFocusEligibilityProvider active={visible} presentationActive={visible}><IndexProbe />{content}</PluginSurfaceFocusEligibilityProvider>
            </DestinationInstanceContext.Provider></Wrapper>;
        };
        const screen = await renderScreen(page(true));
        await act(async () => { storage.getState().applyProfile(AccountProfileSchema.parse({ ...storage.getState().profile,
            connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'initial', status: 'connected', kind: 'oauth' }] }],
        })); });
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:initial')).not.toBeNull());
        await act(async () => {});
        const readPresentedModel = () => screen.tree.root.findAll(node => typeof node.props.renderAccount === 'function'
            && Array.isArray(node.props.model?.sheets))[0]?.props.model;
        await screen.update(page(false));
        const presentedModel = readPresentedModel();
        expect(presentedModel).toBeDefined();
        commits = 0;
        indexRenders = 0;
        const profileCommits: number[] = [];
        for (let arrival = 0; arrival < 3; arrival += 1) {
            const before = commits;
            await act(async () => {
                storage.getState().applyProfile({ ...storage.getState().profile, firstName: `Profile arrival ${arrival}` });
            });
            profileCommits.push(commits - before);
        }
        const beforeSession = commits;
        const arrival = createSessionFixture({ id: 'unrelated-session-arrival', serverId: runtime.serverId });
        await act(async () => { storage.getState().applySessions([arrival]); });
        const sessionCommits = commits - beforeSession;
        const beforeMachine = commits;
        await act(async () => {
            storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() + 1,
                metadataVersion: 2, metadata: { ...createMachineFixture().metadata!, displayName: 'Updated machine name' } })], true,
                { sourceServerId: runtime.serverId });
        });
        const machineCommits = commits - beforeMachine;
        const beforeGateway = commits;
        await act(async () => { beginProviderCatalogLoad({ serverId: runtime.serverId, accountId: 'account-a' }); });
        const gatewayCommits = commits - beforeGateway;
        const beforePurposes = commits;
        await act(async () => { beginConnectedAccountCatalogLoad({ serverId: runtime.serverId, accountId: 'account-a' }, 'purposes'); });
        const purposeCommits = commits - beforePurposes;
        const beforeInstallation = commits;
        await act(async () => { replacePluginAccountAvailabilityProjection({
            scope: { serverId: runtime.serverId, accountId: 'account-a' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [], inventoryComplete: true },
        }); });
        expect({ profileCommits, sessionCommits, machineCommits, gatewayCommits, purposeCommits, installationCommits: commits - beforeInstallation, indexRenders })
            .toEqual({ profileCommits: [0, 0, 0], sessionCommits: 0, machineCommits: 0, gatewayCommits: 0, purposeCommits: 0, installationCommits: 0, indexRenders: 0 });
        await act(async () => { storage.setState(state => ({ profile: AccountProfileSchema.parse({ ...state.profile,
            connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }] }],
        }) })); });
        // Suspense may commit its parked boundary; the actual index must keep its
        // last presented projection until reopen, not rebuild the hidden page.
        expect(readPresentedModel()).toBe(presentedModel);
        expect(indexRenders).toBeGreaterThan(0); // Positive control: the canonical held facts really changed.
        await screen.update(page(true));
        await vi.waitFor(() => expect(screen.findHostByTestId('connected-services-account:happier.agent.codex/openai-codex:work')).not.toBeNull());
        await screen.unmount();
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
    it('loads the selected Machine catalog for a cold Connect sheet and lists its daemon-only fixture', async () => {
        qualifiedAccountsAvailable = true;
        await refreshAuthenticatedServerFeaturesSnapshot({ serverId: runtime.serverId, credentials: runtime.credentials, force: true });
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
            capabilities: { connectedServices: { credentialDelete: { revisionGuard: true }, qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const fixtureService = { pluginId: 'qa.finish-e-cli-secret-configuration', localId: 'fixture' } as const;
        const fixtureDescriptor = {
            id: 'fixture', serviceId: 'fixture', pluginId: fixtureService.pluginId,
            title: 'FINISH-E-CLI disposable configuration', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'fixture', modes: [{ id: 'fixture', kind: 'manual', title: 'Disposable fixture',
                outcomeReconciliation: 'none', fields: [{ id: 'label', title: 'Fixture label', schema: { type: 'string' }, secret: false }],
                configuration: { scope: 'service', changeBehavior: 'refresh', fields: [{ id: 'dummy-secret', title: 'E6 dummy Secret',
                    schema: { type: 'string' }, secret: true, required: false }] } }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        machineRpc.mockImplementation(async ({ method }: { method: string }) => method.includes('contributionRegistryProjection.describe')
            ? { protocolVersion: 1, projection: PluginProjectionV2Schema.parse({
                ...PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {} }),
                familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'qa.finish-e-cli-secret-configuration/fixture': fixtureDescriptor } } },
            }) } : { error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' });
        let connectedAccountProjectionRevision = 0;
        const Wrapper = createIndexWrapper('m1', false, runtime.serverId, () => connectedAccountProjectionRevision);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the Connect sheet Account lifetime');
        const hook = await renderHook(() => ({
            model: useConnectAccountSheetModel({ intent: 'add' }, () => {}),
            projection: useDaemonMergedProjectionInputs({ machineId: 'm1', serverId: runtime.serverId, load: false,
                sections: ['agentsById', 'familiesById.connectedAccounts'] }),
        }), { wrapper: Wrapper });
        try {
            await vi.waitFor(() => expect(machineRpc).toHaveBeenCalled());
            await vi.waitFor(() => expect(hook.getCurrent().projection.inputs?.connectedAccountProjection?.kind).toBe('ready'));
            const acquired = hook.getCurrent().projection.inputs?.connectedAccountProjection;
            expect(acquired?.kind === 'ready' && acquired.descriptors.map(descriptor => descriptor.id)).toContain('fixture');
            const scopeKey = JSON.stringify([runtime.accountScope, 'm1']);
            const projection = advanceConnectedAccountDescriptorProjectionState(createConnectedAccountDescriptorProjectionLoadingState(scopeKey),
                { kind: 'ready', descriptors: acquired?.kind === 'ready' ? acquired.descriptors : [], conflicts: [] });
            installConnectedAccountDescriptorProjection(projection, lifetime);
            connectedAccountProjectionRevision += 1;
            await act(async () => { hook.rerender(); });
            await vi.waitFor(() => expect(hook.getCurrent().model.catalog.map(entry => entry.service)).toContainEqual(fixtureService));
        } finally { retireConnectedAccountDescriptorProjection(lifetime); await hook.unmount(); }
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
    it('opens a gateway draft from an empty Account without creating or approving a connection', async () => {
        savedConnections = [];
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().addGateway).toEqual(expect.any(Function)));
            let route: string | null = null;
            await act(async () => { route = await hook.getCurrent().addGateway!(); });
            expect(providerCatalog?.connections ?? []).toEqual([]);
            expect(mutations).toEqual([]);
            expect(route).toBe('/(app)/settings/connected-services/gateway?contributionKey=happier.provider.cliproxyapi%2Fcliproxyapi');
            expect(providerRevision).toBe(1);
            expect(hook.getCurrent().addGateway).toEqual(expect.any(Function));
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('offers an explicit additional gateway draft without treating an existing gateway as a singleton limit', async () => {
        const hook = await mount('cached', null, false, true);
        try {
            await vi.waitFor(() => expect(hook.getCurrent().gatewayCatalog?.status).toBe('ready'));
            expect(hook.getCurrent().addGateway).toEqual(expect.any(Function));
            let route: string | null = null;
            await act(async () => { route = await hook.getCurrent().addGateway!('happier.provider.cliproxyapi/cliproxyapi'); });
            expect(route).toBe('/(app)/settings/connected-services/gateway?contributionKey=happier.provider.cliproxyapi%2Fcliproxyapi');
            expect(hook.getCurrent().gatewayCatalog?.data?.connections).toEqual([gateway]);
            expect(providerRevision).toBe(1);
            expect(providerCatalog).toBeNull();
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { await hook.unmount(); }
    });
    it('knows external-only Account connections contain no gateways without requesting a Machine', async () => {
        const { gatewayPlacement: _placement, roleModels: _helpers, ...base } = gateway;
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
