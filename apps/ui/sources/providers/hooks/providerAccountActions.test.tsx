import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

installSettingsViewCommonModuleMocks({ storage: 'real' });
// Machine transport is a genuine boundary. No Account operation may reach it.
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
const account = createProviderSettingsAccountHarness();
beforeAll(loadSyncSingletonForTests);
afterEach(async () => { standardCleanup(); await account.reset(); machineRpcWithServerScope.mockReset(); });

function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}

describe('Account Provider UI actions without a machine', () => {
    it('initializes a fresh Account catalog through its existing observer before reading sources', async () => {
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
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections).toEqual([]));
        expect(catalog).not.toBeNull();
        const [{ getProviderCatalogSnapshot }, { getActiveServerAccountScope }] = await Promise.all([
            import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        expect(getProviderCatalogSnapshot(getActiveServerAccountScope())).toMatchObject({ status: 'ready', revision: 1 });
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
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const ready = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(ready.getCurrent().ready).toBe(true));
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="codex" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        const nativeModel = getAgentStaticModels('codex')[0]!;
        expect(screen.getTextContent()).toContain(nativeModel.name || nativeModel.id);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models-source-visibility:pc_account')).not.toBeNull());
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
        expect(catalog.manualModelsByConnectionId.pc_account).toMatchObject([{ id: 'added-model' }]);
        await hook.unmount();
        const reopened = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().data?.connections[0]?.displayName).toBe('Renamed source'));
        const writer = await renderHook(() => useProviderConnectionMutation({ resolveTarget, serverId, refresh: async () => { await reopened.getCurrent().refresh(); } }));
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
        const { serverId } = await account.restore({ catalog,
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
        const hook = await renderHook(() => useProviderConnectionModelsSection({
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
        const hook = await renderHook(() => useProviderConnectionModelsSection({
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
});
