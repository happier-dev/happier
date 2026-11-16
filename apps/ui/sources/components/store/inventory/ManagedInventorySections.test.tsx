import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ManagedInventorySectionsState, ManagedInventoryDraft, ManagedInventoryGroupBy } from './ManagedInventorySections';
import type { ManagedInventoryField } from './inventoryRows';
import type { SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { InstalledScreen } = await import('./InstalledScreen');
const { MachineManagedInventorySection } = await import('@/components/machines/page/MachineManagedInventorySection');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { inventoryMachineKey } = await import('./inventoryRows');
const fields = Object.fromEntries(['kind', 'status', 'machine', 'project'].map(id =>
    [id, { label: id, icon: 'circle-half' as const, valueLabel: (value: string) => value }])) as Record<ManagedInventoryField, SettingsColumnFilterField>;

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('keeps one Collection and exact two-door homes through human/agent intersections, independent clear and regrouping', async () => {
    const providers = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: ['pc_a', 'pc_b'].map(id => ({ v: 1, id, source: { kind: 'contribution', contributionKey: 'example.provider/unavailable-source' },
            role: 'named', displayName: 'Shared tool', displayNameMode: 'custom', deployment: { kind: 'external' },
            revision: 1, createdAt: 1, updatedAt: 1 })), machineGrants: ['a', 'b'].map(machineId => ({ v: 1,
                connectionId: `pc_${machineId}`, machineId, endpointSetFingerprint: 'retained', connectionSecurityFingerprint: 'retained', confirmedAt: 1 })) });
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } }));
    const home = await account.restore({ serverIdentityId: 'srv_inventory_collection', machines, catalog: providers });
    const scope = storage.getState().settingsScope!;
    await publishMachineInventoryForTest(scope, machines.map(machine => createHydratedPlainMachineFixture({
        id: machine.id, accountId: scope.accountId, machine,
    })));
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [{ id: 'docs', name: 'docs', title: 'Shared docs', transport: 'stdio',
            stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'docs-on', serverId: 'docs',
                enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] } } } });
    const target = { serverIdentityId: 'srv_inventory_collection', machineId: 'a' };
    let current!: ManagedInventorySectionsState;
    let machine!: ManagedInventorySectionsState;
    let draft!: ManagedInventoryDraft;
    let groupBy: ManagedInventoryGroupBy = 'kind';
    function Page() {
        const [query, setQuery] = React.useState('');
        const [filters, setFilters] = React.useState<ManagedInventoryDraft['filters']>({});
        const [openKey, setOpenKey] = React.useState<string | null>(null);
        draft = { query, setQuery, filters, setFilters };
        return <><InstalledScreen query={{ scope, machine: null, projectKey: null, presented: true }} draft={draft}
            fields={fields} groupBy={groupBy} openKey={openKey} onOpenChange={setOpenKey}>{state => { current = state; return null; }}</InstalledScreen>
            <MachineManagedInventorySection query={{ scope, machine: target, projectKey: null, presented: true }}
                groupBy="kind" openKey={null} onOpenChange={() => {}}>{state => { machine = state; return null; }}</MachineManagedInventorySection></>;
    }
    const view = () => <PluginSurfaceFocusEligibilityProvider active><Page /></PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(view());
    await vi.waitFor(() => expect(current.rows.filter(row => row.kind === 'provider')).toHaveLength(2));
    expect(current.families.find(family => family.kind === 'provider')?.result.coverage).toBe('available');
    expect(current.families.find(family => family.kind === 'provider')?.result.continuation).toBeUndefined();
    await vi.waitFor(() => expect(machine.rows.some(row => row.kind === 'mcpServer')).toBe(true));
    const docs = current.rows.find(row => row.kind === 'mcpServer')!;
    expect(machine.presentations.get(docs.key)?.home).toEqual(current.presentations.get(docs.key)?.home);
    expect(current.presentations.get(docs.key)?.home).toEqual({ href: '/settings/mcp/docs', scope });
    const settings = storage.getState().settings;
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
    const actionTarget = { column: 'store' as const, ...scope };
    const set = (filters: ManagedInventoryDraft['filters'], searchQuery?: string) => executor.execute('settings.column.filter.set',
        { ...actionTarget, filters, ...(searchQuery === undefined ? {} : { searchQuery }) }, context);
    const condition = (value: string) => ({ include: [value], exclude: [] });
    await act(async () => { draft.setQuery('Shared'); });
    await vi.waitFor(() => expect(current.rows).toHaveLength(3));
    expect(await executor.execute('settings.column.filter.get', actionTarget, context)).toMatchObject({ ok: true,
        result: { searchQuery: 'Shared', matchedCount: 3 } });
    const selected = { kind: condition('provider'), status: condition('sourceUnavailable'),
        machine: condition(inventoryMachineKey(scope, target)) };
    await act(async () => { expect(await set(selected)).toMatchObject({ ok: true }); });
    expect(current.rows).toHaveLength(1);
    expect(current.rows[0]).toMatchObject({ kind: 'provider', native: { id: 'pc_a' } });
    await act(async () => { expect(await set({ ...selected, project: condition('unrelated-project') })).toMatchObject({ ok: true }); });
    expect(current.rows).toHaveLength(0);
    await act(async () => { expect(await set(selected)).toMatchObject({ ok: true }); });
    const viewport = current.collection.viewport('list'); viewport.offsetRef.current = 240;
    await act(async () => { current.collection.actions.open(current.rows[0]!.key); });
    const openKey = current.collection.openKey;
    groupBy = 'machine';
    await act(async () => { screen.update(view()); });
    expect(current.collection.openKey).toBe(openKey);
    expect(current.collection.viewport('list')).toBe(viewport);
    expect(viewport.offsetRef.current).toBe(240);
    expect(current.rows).toHaveLength(1);
    const { machine: _machine, ...withoutMachine } = selected;
    await act(async () => { expect(await set(withoutMachine)).toMatchObject({ ok: true }); });
    expect(current.rows).toHaveLength(2);
    expect(draft.query).toBe('Shared');
    await act(async () => { expect(await executor.execute('settings.column.filter.clear', actionTarget, context)).toMatchObject({ ok: true }); });
    expect(draft.filters).toEqual({});
    expect(draft.query).toBe('Shared');
    expect(current.rows).toHaveLength(3);
    expect(storage.getState().settings).toBe(settings);
    // The selected Machine door demands native Plugin details once; All and filter changes do no fleet work.
    expect(rpc.state.requests.map(request => ({ method: request.method, machineId: request.machineId })))
        .toEqual([{ method: 'capabilities.detect', machineId: target.machineId }]);
});

it('filters native capability conditions and Machine attention through the mounted draft without counting attention twice', async () => {
    const resources = MachinePublishedResourceSummaryV1Schema.parse({ v: 1, vitals: { state: 'reporting' },
        host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'needs_you', reasons: [{
            key: 'memory', metric: 'memory', kind: 'memory_pressure', since: 1, level: 'needs_you', pressure: 'critical', swapping: false,
        }] } });
    const machine = createMachineFixture({ id: 'needs-memory', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } }, daemonState: { resources } });
    const home = await account.restore({ serverIdentityId: 'srv_inventory_filter_attention', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    observeMachinePresenceForTest(scope, [machine.id]);
    storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
            url: 'https://mcp.example.test', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }],
            bindings: [{ id: 'oauth-on', serverId: 'oauth', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }] } } } });
    let current!: ManagedInventorySectionsState;
    function Page() {
        const [query, setQuery] = React.useState('');
        const [filters, setFilters] = React.useState<ManagedInventoryDraft['filters']>({});
        return <InstalledScreen query={{ scope, machine: null, projectKey: null, presented: true }}
            draft={{ query, setQuery, filters, setFilters }} fields={fields} groupBy="kind" openKey={null} onOpenChange={() => {}}>
            {state => { current = state; return null; }}
        </InstalledScreen>;
    }
    await renderScreen(<PluginSurfaceFocusEligibilityProvider active><Page /></PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(current.attention.some(entry => entry.kind === 'capability' && entry.native.kind === 'signin')).toBe(true));
    const executor = createDefaultActionExecutor();
    const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId };
    const actionTarget = { column: 'store' as const, ...scope };
    const condition = (value: string) => ({ include: [value], exclude: [] });
    await act(async () => { expect(await executor.execute('settings.column.filter.set', { ...actionTarget,
        filters: { status: condition('signin') } }, context)).toMatchObject({ ok: true }); });
    expect(current.rows.map(row => row.kind)).toEqual(['mcpServer']);
    expect(current.attention.map(entry => entry.kind)).toEqual(['capability']);
    expect(await executor.execute('settings.column.filter.get', actionTarget, context)).toMatchObject({ ok: true, result: { matchedCount: 1 } });
    await act(async () => { expect(await executor.execute('settings.column.filter.set', { ...actionTarget,
        filters: { machine: condition(inventoryMachineKey(scope, { serverIdentityId: 'srv_inventory_filter_attention', machineId: machine.id })) } }, context))
        .toMatchObject({ ok: true }); });
    expect(current.attention.some(entry => entry.kind === 'machine')).toBe(true);
    expect(rpc.state.requests).toHaveLength(0);
});

it('lets All follow the native Skills continuation on intent while preserving the filtered Collection and retiring hidden demand', async () => {
    const home = await createSeededSkillsHome('https://inventory-all-continuation.test', { skills: [{ id: 'review' }] });
    const frontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const create = frontDoor.createFrontDoorActionExecute;
    let listings = 0;
    let settled = 0;
    // Observe real ingress without replacing admission, reads or classification.
    const observation = vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
        const execute = create(...args);
        return Object.assign((...invocation: Parameters<typeof execute>) => {
            if (invocation[0] === 'skills.list') listings++;
            return execute(...invocation).finally(() => { if (invocation[0] === 'skills.list') settled++; });
        }, { prepare: execute.prepare, confirmed: execute.confirmed });
    });
    const scope = storage.getState().settingsScope!;
    let presented = true;
    let groupBy: ManagedInventoryGroupBy = 'kind';
    let current!: ManagedInventorySectionsState;
    function Page() {
        const [query, setQuery] = React.useState('review');
        const [filters, setFilters] = React.useState<ManagedInventoryDraft['filters']>({ kind: { include: ['skill'], exclude: [] } });
        return <InstalledScreen query={{ scope, machine: null, projectKey: null, presented }}
            draft={{ query, setQuery, filters, setFilters }} fields={fields} groupBy={groupBy} openKey={null} onOpenChange={() => {}}>
            {state => { current = state; return null; }}
        </InstalledScreen>;
    }
    const screen = await renderScreen(<Page />);
    const catalogReads = () => home.requests.filter(request => request.path === '/v1/account/entity-rows/prompt-library'
        && request.method === 'GET').length;
    try {
        await vi.waitFor(() => expect(current.rows.some(row => row.kind === 'skill' && row.native.skillId === 'review')).toBe(true));
        await vi.waitFor(() => expect(settled).toBe(1));
        expect(listings).toBe(1);
        const initialReads = catalogReads();
        const family = current.families.find(family => family.kind === 'skill')!;
        expect(family.result.continuation).toBeTypeOf('function');
        const viewport = current.collection.viewport('list');
        viewport.offsetRef.current = 180;
        groupBy = 'project';
        await act(async () => { screen.update(<Page />); });
        await flushHookEffects();
        expect(catalogReads()).toBe(initialReads);
        expect(listings).toBe(1);
        // This is the native handle handed to the All control's existing render slot.
        await act(async () => { family.result.continuation?.(); });
        await vi.waitFor(() => expect(settled).toBe(2));
        expect(listings).toBe(2);
        await flushHookEffects();
        expect(current.rows.map(row => row.kind === 'skill' ? row.native.skillId : row.kind)).toEqual(['review']);
        expect(current.collection.viewport('list')).toBe(viewport);
        expect(viewport.offsetRef.current).toBe(180);
        presented = false;
        await act(async () => { screen.update(<Page />); });
        const reads = home.requests.length;
        await act(async () => { family.result.continuation?.(); });
        await flushHookEffects();
        expect(home.requests.slice(reads)).toEqual([]);
        expect(listings).toBe(2);
        expect(current.families.find(family => family.kind === 'skill')?.result.continuation).toBeUndefined();
    } finally { observation.mockRestore(); await screen.unmount(); await home.dispose(); }
});
