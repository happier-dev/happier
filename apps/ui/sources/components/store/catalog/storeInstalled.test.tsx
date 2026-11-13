import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, createMachineFixture, createRenderCommitCounter, flushHookEffects, renderHook, standardCleanup,
    useRenderCommitCounter } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability';
import type { StoreInstalledInput } from './storeKinds';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storeKinds } = await import('./storeKinds');
const { useInstalledScope } = await import('./storeAccountAdmission');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
const { getMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { getProviderCatalogSnapshot } = await import('@/sync/store/settings/providerCatalogSnapshot');
const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
const { refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    standardCleanup();
    clearPluginAccountAvailabilityProjection();
    await account.reset();
    rpc.reset();
});

it('uses the registry outcome when a bundled Agent has no packaged description', async () => {
    const { getResolvedAgentCatalogEntries } = await import('@/agents/backendCatalog/agentCatalogProjection');
    const entry = getResolvedAgentCatalogEntries({ enabledAgentIds: [] })[0]!;
    for (const subtitle of [entry.title, `${entry.title} CLI`]) {
        expect(storeKinds.agent.summary({ ...entry, subtitle }).description).toBeNull();
    }
    expect(storeKinds.agent.summary({ ...entry, registryDescription: 'Works with your existing account' }).description)
        .toBe('Works with your existing account');
});

it('groups each Agent once with all proven Machine memberships and preserves the row on equal inventory', async () => {
    const { createSkillsSurfaceHarness } = await import('@/dev/testkit/harness/skillsSurfaceHarness');
    const home = await createSkillsSurfaceHarness('https://store-agent-memberships.test');
    onTestFinished(() => home.dispose());
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['claude', 'codex'] } } }));
    const scope = home.scope;
    await act(async () => { storage.getState().applyMachines(machines, true,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    let input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const hook = await renderHook(() => storeKinds.agent.useInstalled(input, { presented: true }, useInstalledScope(input)));
    await vi.waitFor(() => expect(hook.getCurrent().rows.filter(row => row.subject === 'machineAgent')).toHaveLength(2));
    const rows = hook.getCurrent().rows;
    const codex = rows.find(row => row.subject === 'machineAgent' && row.native === 'codex');
    expect(codex).toMatchObject({ machineIds: ['a', 'b'] });
    await act(async () => { storage.getState().applyMachines(machines.map(machine => ({ ...machine, metadataVersion: machine.metadataVersion + 1,
        metadata: { ...machine.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['claude', 'codex'] } } })), false,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await flushHookEffects();
    expect(hook.getCurrent().rows).toBe(rows);
    input = { ...input, machine: { serverIdentityId: scope.serverId, machineId: 'b' } };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().rows).toHaveLength(2));
    expect(hook.getCurrent().rows.find(row => row.native === 'codex')).toMatchObject({ key: codex!.key,
        machineIds: ['b'] });
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('does not re-project any Installed family for another Home record while a relevant Machine change reaches its consumer', async () => {
    const machine = createMachineFixture({ id: 'selected-home', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
    // Match the 138-Machine inventory census used by the native projection cost contract.
    const siblings = Array.from({ length: 137 }, (_, index) => createMachineFixture({ id: `held-sibling-${index}` }));
    await account.restore({ serverIdentityId: 'srv_installed_locality', machines: [machine, ...siblings] });
    const scope = storage.getState().settingsScope!;
    const foreign = await account.home.addHome({ name: 'Other inventory Home', serverUrl: 'https://other-inventory.test',
        serverIdentityId: 'srv_installed_other', accountId: 'other', currentAccount: true, active: false });
    const inventoryOwner = await import('@/sync/domains/machines/machineInventorySnapshots');
    const projection = vi.spyOn(inventoryOwner, 'resolveAllProfileMachineInventorySnapshots');
    const input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const demand = { presented: true };
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        const admitted = useInstalledScope(input);
        return {
        mcpServer: storeKinds.mcpServer.useInstalled(input, demand, admitted), skill: storeKinds.skill.useInstalled(input, demand, admitted),
        agent: storeKinds.agent.useInstalled(input, demand, admitted), provider: storeKinds.provider.useInstalled(input, demand, admitted),
        plugin: storeKinds.plugin.useInstalled(input, demand, admitted), software: storeKinds.software.useInstalled(input, demand, admitted),
    }; });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().agent.rows.some(row => row.subject === 'machineAgent' && row.native === 'codex')).toBe(true));
        await vi.waitFor(() => expect(Object.values(hook.getCurrent()).every(family => family.coverage !== 'loading')).toBe(true));
        await flushHookEffects();
        const before = hook.getCurrent();
        projection.mockClear();
        counter.reset();
        for (let index = 0; index < 3; index++) {
            await act(async () => { storage.getState().applyMachines([createMachineFixture({ id: `foreign-record-${index}` })], false,
                { sourceServerId: foreign, sourceAccountId: 'other' }); });
        }
        await flushHookEffects();
        expect(projection).toHaveBeenCalledTimes(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        for (const kind of Object.keys(before) as Array<keyof typeof before>) expect(hook.getCurrent()[kind]).toBe(before[kind]);
        await act(async () => { storage.getState().applyMachines([{ ...machine, metadataVersion: machine.metadataVersion + 1,
            metadata: { ...machine.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['claude'] } } }, ...siblings], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
        await vi.waitFor(() => expect(hook.getCurrent().agent.rows.some(row => row.subject === 'machineAgent' && row.native === 'claude')).toBe(true));
        expect(hook.getCurrent().agent.rows.some(row => row.subject === 'machineAgent' && row.native === 'codex')).toBe(false);
        expect(rpc.state.requests).toHaveLength(0);
    } finally { projection.mockRestore(); await hook.unmount(); }
});

it('ignores unrelated reachability pushes and preserves selected-Machine execution admission updates', async () => {
    const selected = createMachineFixture({ id: 'selected-reachability', active: true, activeAt: Date.now() });
    const sibling = createMachineFixture({ id: 'sibling-reachability', active: true, activeAt: Date.now() });
    await account.restore({ serverIdentityId: 'srv_installed_reachability', machines: [selected, sibling] });
    const scope = storage.getState().settingsScope!;
    const foreign = await account.home.addHome({ name: 'Other reachability Home', serverUrl: 'https://other-reachability.test',
        serverIdentityId: 'srv_foreign_reachability', accountId: scope.accountId, currentAccount: true, active: false });
    const { useInstalledMachines } = await import('./storeInstalled');
    const { recordMachineRequestFailed, recordMachineRequestSucceeded } = await import('@/sync/domains/machines/reachability/machineReachability');
    const inventoryOwner = await import('@/sync/domains/machines/machineInventorySnapshots');
    const projection = vi.spyOn(inventoryOwner, 'resolveAllProfileMachineInventorySnapshots');
    const input: StoreInstalledInput = { scope, machine: { serverIdentityId: scope.serverId, machineId: selected.id }, projectKey: null };
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useInstalledMachines(input, { presented: true }, scope);
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().snapshot).toMatchObject({ executionEligibleMachineIds: [selected.id] }));
        await flushHookEffects();
        projection.mockClear();
        counter.reset();
        await act(async () => {
            recordMachineRequestFailed({ ...scope, machineId: sibling.id });
            recordMachineRequestFailed({ serverId: foreign, accountId: scope.accountId, machineId: selected.id });
        });
        expect(projection).toHaveBeenCalledTimes(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => { recordMachineRequestFailed({ ...scope, machineId: selected.id }); });
        expect(hook.getCurrent().snapshot).toMatchObject({ executionEligibleMachineIds: [] });
        await act(async () => { recordMachineRequestSucceeded({ ...scope, machineId: selected.id }); });
        expect(hook.getCurrent().snapshot).toMatchObject({ executionEligibleMachineIds: [selected.id] });
        expect(rpc.state.requests).toHaveLength(0);
    } finally { projection.mockRestore(); await hook.unmount(); }
});

it('replaces zero Installed MCP rows for equal refresh and exactly one for a changed catalog item', async () => {
    const home = await account.restore({ serverIdentityId: 'srv_store_row_identity', machines: [] });
    const scope = storage.getState().settingsScope!;
    let title = 'First';
    let revision = 1;
    let reads = 0;
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
        reads++;
        return { body: { status: 'present', revision, content: { t: 'plain', v: { v: 1, bindings: [],
            servers: ['first', 'unchanged'].map(id => ({ id, name: id, title: id === 'first' ? title : 'Unchanged',
                transport: 'stdio', stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 })) } } } };
    } });
    const input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const hook = await renderHook(() => storeKinds.mcpServer.useInstalled(input, { presented: true }, useInstalledScope(input)));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().rows).toHaveLength(2));
        await flushHookEffects();
        const before = hook.getCurrent().rows;
        const initialReads = reads;
        await act(async () => { await refreshMcpServerCatalog(scope); });
        expect(reads - initialReads).toBe(1);
        expect(hook.getCurrent().rows.filter((row, index) => row !== before[index])).toHaveLength(0);
        title = 'Changed';
        revision++;
        await act(async () => { await refreshMcpServerCatalog(scope); });
        expect(hook.getCurrent().rows[0]?.native.title).toBe('Changed');
        expect(hook.getCurrent().rows.filter((row, index) => row !== before[index])).toHaveLength(1);
    } finally { await hook.unmount(); }
});

it('keeps exact-Machine recorded inventory unchanged when a sibling record changes', async () => {
    const selected = createMachineFixture({ id: 'selected-record' });
    const sibling = createMachineFixture({ id: 'sibling-record' });
    await account.restore({ serverIdentityId: 'srv_installed_exact', machines: [selected, sibling] });
    const scope = storage.getState().settingsScope!;
    // Publish from admitted rows: fixture seeds lack the HTTP ingress's storage/key authority fields.
    const admittedSelected = storage.getState().machines[selected.id]!;
    const admittedSibling = storage.getState().machines[sibling.id]!;
    const { useInstalledMachines } = await import('./storeInstalled');
    const inventoryOwner = await import('@/sync/domains/machines/machineInventorySnapshots');
    const projection = vi.spyOn(inventoryOwner, 'resolveAllProfileMachineInventorySnapshots');
    const input: StoreInstalledInput = { scope, machine: { serverIdentityId: scope.serverId, machineId: selected.id }, projectKey: null };
    const hook = await renderHook(() => useInstalledMachines(input, { presented: true }, scope));
    try {
        await vi.waitFor(() => expect(hook.getCurrent().machines.map(machine => machine.id)).toEqual([selected.id]));
        await flushHookEffects();
        const before = hook.getCurrent();
        projection.mockClear();
        await act(async () => { storage.getState().applyMachines([admittedSelected, { ...admittedSibling,
            metadataVersion: sibling.metadataVersion + 1, metadata: { ...sibling.metadata!, displayName: 'Changed sibling' } }], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
        await flushHookEffects();
        expect(projection).toHaveBeenCalledTimes(0);
        expect(hook.getCurrent().snapshot).toBe(before.snapshot);
        expect(hook.getCurrent().machines).toBe(before.machines);
        await act(async () => { storage.getState().applyMachines([{ ...admittedSelected,
            metadataVersion: selected.metadataVersion + 1, metadata: { ...selected.metadata!, displayName: 'Changed selected' } }, admittedSibling], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
        await vi.waitFor(() => expect(hook.getCurrent().machines[0]?.metadata?.displayName).toBe('Changed selected'));
        expect(rpc.state.requests).toHaveLength(0);
    } finally { projection.mockRestore(); await hook.unmount(); }
});

it('demands one daemon detail only for the explicit selected Machine and follows native refresh only on intent', async () => {
    rpc.reset();
    const machines = ['selected', 'other'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
    await account.restore({ serverIdentityId: 'srv_store_selected_details', machines });
    const scope = storage.getState().settingsScope!;
    const detail = createInstalledPluginCapabilityFixture({ pluginId: 'example.installed', title: 'Daemon detail', version: '2.0.0' });
    rpc.intercept('capabilities.detect', () => ({ protocolVersion: 1, results: {
        'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [detail] } },
    } }));
    const materialization = (machineId: string): PluginMachineMaterializationV1 => ({
        serverIdentityId: 'srv_store_selected_details', machineId, materializationId: `installed-${machineId}`,
        pluginId: detail.pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
    });
    let input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    let presented = true;
    const hook = await renderHook(() => storeKinds.plugin.useInstalled(input, { presented }, useInstalledScope(input)));
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toBe('available'));
    await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2,
        intentReads: [], materializations: machines.map(machine => materialization(machine.id)), snapshots: [], inventoryComplete: true } }); });
    expect(hook.getCurrent().rows).toHaveLength(1);
    expect(rpc.state.requests).toHaveLength(0);
    input = { ...input, machine: { serverIdentityId: 'srv_store_selected_details', machineId: 'selected' } };
    await hook.rerender();
    await vi.waitFor(() => expect(rpc.state.requests.filter(request => request.method === 'capabilities.detect')).toHaveLength(1));
    await vi.waitFor(() => expect(hook.getCurrent().rows[0]).toMatchObject({ detail }));
    const { presentInventoryRow } = await import('../inventory/inventoryRows');
    expect(presentInventoryRow(hook.getCurrent().rows[0]!, input).facts.title).toBe('Daemon detail');
    expect(rpc.state.requests.map(request => request.machineId)).toEqual(['selected']);
    expect(rpc.state.requests[0]?.accountId).toBe(scope.accountId);
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const { usePluginsAdministrationTarget } = await import('@/components/settings/plugins/model/usePluginsAdministrationTarget');
    await act(async () => { await account.selectMachine(scope.serverId, 'selected', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins); });
    const administration = await renderHook(() => usePluginsAdministrationTarget());
    await vi.waitFor(() => expect(administration.getCurrent().installedPlugins).toEqual([detail]));
    expect(rpc.state.requests).toHaveLength(1);
    await administration.unmount();
    const refresh = hook.getCurrent().continuation;
    expect(refresh).toBeTypeOf('function');
    const unchangedRows = hook.getCurrent().rows;
    await hook.rerender();
    await flushHookEffects();
    expect(rpc.state.requests).toHaveLength(1);
    expect(hook.getCurrent().rows).toBe(unchangedRows);
    await act(async () => { refresh?.(); });
    await vi.waitFor(() => expect(rpc.state.requests).toHaveLength(2));
    presented = false;
    await hook.rerender();
    await act(async () => { refresh?.(); });
    expect(rpc.state.requests).toHaveLength(2);
    input = { ...input, machine: null };
    presented = true;
    await hook.rerender();
    expect(hook.getCurrent().rows[0]).not.toHaveProperty('detail');
    expect(hook.getCurrent().continuation).toBeUndefined();
    expect(rpc.state.requests).toHaveLength(2);
    await hook.unmount();
});

it('exposes the real Skills retry without following it on open, and retires its hidden callback', async () => {
    const { createSeededSkillsHome } = await import('@/dev/testkit/harness/skillsSurfaceHarness');
    const home = await createSeededSkillsHome('https://installed-skills-continuation.test', {
        skills: [{ id: 'review', text: '---\nname: review\ndescription: Fixture review\n---\n\nReview changes.\n' }],
    });
    const frontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const create = frontDoor.createFrontDoorActionExecute;
    let listings = 0;
    let settled = 0;
    // Count real Action ingress; admission, catalog and transport remain real.
    const observation = vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
        const execute = create(...args);
        return Object.assign((...invocation: Parameters<typeof execute>) => {
            if (invocation[0] === 'skills.list') listings++;
            return execute(...invocation).finally(() => { if (invocation[0] === 'skills.list') settled++; });
        }, { prepare: execute.prepare, confirmed: execute.confirmed });
    });
    const scope = storage.getState().settingsScope!;
    let presented = true;
    const hook = await renderHook(() => {
        const input = { scope, machine: null, projectKey: null };
        return storeKinds.skill.useInstalled(input, { presented }, useInstalledScope(input));
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().rows.some(row => row.native.skillId === 'review')).toBe(true));
        const initial = listings;
        const retry = hook.getCurrent().continuation;
        expect(retry).toBeTypeOf('function');
        await hook.rerender();
        await flushHookEffects();
        expect(listings).toBe(initial);
        await act(async () => { retry?.(); });
        await vi.waitFor(() => expect(listings).toBe(initial + 1));
        await vi.waitFor(() => expect(settled).toBe(initial + 1));
        await flushHookEffects();
        presented = false;
        await hook.rerender();
        const reads = home.requests.length;
        await act(async () => { retry?.(); });
        await flushHookEffects();
        expect(home.requests.slice(reads)).toEqual([]);
        expect(listings).toBe(initial + 1);
        expect(hook.getCurrent().continuation).toBeUndefined();
    } finally { observation.mockRestore(); await hook.unmount(); await home.dispose(); }
});

it('keeps all five native families cold while hidden or Home-mismatched, then admits their real catalog results', async () => {
    const machine = createMachineFixture({ id: 'same-id', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 2, installedAgentIds: ['codex'] } } });
    const providers = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [{
        v: 1, id: 'pc_saved', source: { kind: 'contribution', contributionKey: 'example.provider/unavailable-source' },
        role: 'named', displayName: 'Saved connection', displayNameMode: 'custom', deployment: { kind: 'external' },
        revision: 1, createdAt: 1, updatedAt: 1,
    }] });
    const home = await account.restore({ serverIdentityId: 'srv_store_families', machines: [machine], catalog: providers });
    const scope = storage.getState().settingsScope!;
    let mcpReads = 0;
    let acpReads = 0;
    let providerReads = 0;
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
        mcpReads += 1;
        return { body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1,
            servers: [{ id: 'saved-mcp', name: 'saved', transport: 'stdio', stdio: { command: 'server', args: [] },
                env: {}, createdAt: 1, updatedAt: 1 }, { invalid: 'independent-row' }], bindings: [] } } } };
    } });
    account.home.answer(home.serverId, `GET ${ACP_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
        acpReads += 1;
        return { body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } } };
    } });
    account.home.answer(home.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: () => {
        providerReads += 1;
        return { body: { status: 'present', revision: 1, content: { t: 'plain', v: providers } } };
    } });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
        intentReads: [], materializations: [], snapshots: [], inventoryComplete: true } });
    let presented = false;
    let input: StoreInstalledInput = { scope, machine: { serverIdentityId: 'srv_another_home', machineId: 'same-id' }, projectKey: null };
    const hook = await renderHook(() => {
        const admitted = useInstalledScope(input);
        return {
            mcp: storeKinds.mcpServer.useInstalled(input, { presented }, admitted), skills: storeKinds.skill.useInstalled(input, { presented }, admitted),
            agents: storeKinds.agent.useInstalled(input, { presented }, admitted), providers: storeKinds.provider.useInstalled(input, { presented }, admitted),
            plugins: storeKinds.plugin.useInstalled(input, { presented }, admitted),
        };
    });
    await flushHookEffects();
    expect({ mcpReads, acpReads, providerReads }).toEqual({ mcpReads: 0, acpReads: 0, providerReads: 0 });
    expect(rpc.state.requests).toHaveLength(0);
    presented = true;
    await hook.rerender();
    await flushHookEffects();
    for (const family of Object.values(hook.getCurrent())) {
        expect(family).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
    }
    expect({ mcpReads, acpReads, providerReads }).toEqual({ mcpReads: 0, acpReads: 0, providerReads: 0 });
    expect(rpc.state.requests).toHaveLength(0);
    input = { ...input, machine: null };
    await hook.rerender();
    await vi.waitFor(() => expect(hook.getCurrent().providers.coverage).toBe('available'));
    await vi.waitFor(() => expect(hook.getCurrent().mcp.rows).toHaveLength(1));
    expect(hook.getCurrent().mcp.coverage).toMatchObject({ partial: { status: 'partial',
        diagnostics: [{ path: 'servers[1]', reason: 'invalid-stored-content' }] } });
    expect(hook.getCurrent().mcp.rows[0]?.native).toBe(getMcpServerCatalogSnapshot(scope).value?.servers[0]);
    expect(hook.getCurrent().providers.rows[0]?.native).toBe(getProviderCatalogSnapshot(scope)?.data?.connections[0]);
    expect(hook.getCurrent().providers.rows.map(row => row.native.id)).toEqual(['pc_saved']);
    expect(hook.getCurrent().plugins).toMatchObject({ rows: [], coverage: 'available' });
    expect(hook.getCurrent().agents.rows).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'agent', subject: 'machineAgent', native: 'codex', machineIds: ['same-id'],
    })]));
    expect({ mcpReads, acpReads, providerReads }).toEqual({ mcpReads: 1, acpReads: 1, providerReads: 1 });
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('distinguishes confirmed-empty from native failure and withdraws a retired Account without a replacement read', async () => {
    const scope = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [] });
    let reads = 0;
    account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { select: () => {
        reads += 1;
        return { body: { status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    } });
    let input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const hook = await renderHook(() => storeKinds.provider.useInstalled(input, { presented: true }, useInstalledScope(input)));
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'available' }));
    account.home.answer(scope.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { status: 403, body: { error: 'forbidden' } });
    await act(async () => { await refreshProviderCatalog(scope); });
    expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: { unavailable: { status: 'unavailable', reason: 'forbidden' } } });
    expect(hook.getCurrent().coverage).toEqual({ unavailable: getProviderCatalogSnapshot(scope)?.catalog });
    input = { ...input, scope: { ...scope, accountId: 'retired-account' } };
    await hook.rerender();
    expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
    expect(reads).toBe(1);
    input = { ...input, scope: null };
    await hook.rerender();
    expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('keeps native Plugin partial rows and isolates two Homes sharing a Machine id', async () => {
    const machine = createMachineFixture({ id: 'same-id', activeAt: Date.now() });
    await account.restore({ serverIdentityId: 'srv_store_plugin_a', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const materialization = (serverIdentityId: string): PluginMachineMaterializationV1 => ({
        serverIdentityId, machineId: 'same-id', materializationId: `local-${serverIdentityId}`, pluginId: 'example.installed',
        version: '1.0.0', sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: 1,
    });
    const partial = { scope, snapshot: { availabilityCursor: 2, intentReads: [],
        materializations: [materialization('srv_store_plugin_a'), materialization('srv_store_plugin_b')],
        snapshots: [], inventoryComplete: false } };
    const selectedPlugin = createInstalledPluginCapabilityFixture({ pluginId: 'example.installed', version: '1.0.0' });
    rpc.intercept('capabilities.detect', () => ({ protocolVersion: 1, results: {
        'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [selectedPlugin] } },
    } }));
    let input: StoreInstalledInput = { scope, projectKey: null,
        machine: { serverIdentityId: 'srv_store_plugin_a', machineId: 'same-id' } };
    const hook = await renderHook(() => storeKinds.plugin.useInstalled(input, { presented: true }, useInstalledScope(input)));
    // Let real Sync finish its initial native census before publishing the subsequent partial
    // census. Otherwise two fixture producers race and the bootstrap legitimately wins.
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toBe('available'));
    await act(async () => { replacePluginAccountAvailabilityProjection(partial); });
    expect(hook.getCurrent().coverage).toMatchObject({ partial: { kind: 'available' } });
    const native = readPluginAccountAvailability(scope).readInstalledPlugins();
    expect(native.kind).toBe('available');
    if (native.kind !== 'available') throw new Error('Expected admitted native inventory');
    expect(hook.getCurrent().coverage).toEqual({ partial: native });
    expect(hook.getCurrent().rows[0]?.native).toBe(native.plugins[0]);
    expect(hook.getCurrent().rows[0]?.installations.map(row => row.materialization.serverIdentityId)).toEqual(['srv_store_plugin_a']);
    await vi.waitFor(() => expect(hook.getCurrent().rows[0]?.detail).toEqual(selectedPlugin));
    expect(rpc.state.requests.map(request => [request.method, request.machineId])).toEqual([['capabilities.detect', 'same-id']]);
    input = { ...input, projectKey: 'a-project-with-a-checkout' };
    await hook.rerender();
    expect(hook.getCurrent().rows).toEqual([]);
    expect(hook.getCurrent().coverage).toEqual({ partial: native });
    input = { ...input, projectKey: null };
    input = { ...input, machine: { serverIdentityId: 'srv_store_plugin_b', machineId: 'same-id' } };
    await hook.rerender();
    expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: { unavailable: 'scope-retired' } });
    expect(rpc.state.requests.map(request => [request.method, request.machineId])).toEqual([['capabilities.detect', 'same-id']]);
    await hook.unmount();
});

it('narrows saved Providers by native Machine grants and keeps Account-only subjects out of a Project filter', async () => {
    const providers = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: ['pc_selected', 'pc_other', 'pc_account'].map(id => ({ v: 1, id,
            source: { kind: 'contribution', contributionKey: 'example.provider/unavailable-source' }, role: 'named',
            displayName: id, displayNameMode: 'custom', deployment: { kind: 'external' }, revision: 1, createdAt: 1, updatedAt: 1 })),
        machineGrants: [{ v: 1, connectionId: 'pc_selected', machineId: 'selected', endpointSetFingerprint: 'retained-endpoints',
            connectionSecurityFingerprint: 'retained-security', confirmedAt: 1 },
        { v: 1, connectionId: 'pc_other', machineId: 'other', endpointSetFingerprint: 'retained-endpoints',
            connectionSecurityFingerprint: 'retained-security', confirmedAt: 1 }],
        accountGrants: [{ v: 1, connectionId: 'pc_account', connectionSecurityFingerprint: 'retained-security', confirmedAt: 1 }],
    });
    await account.restore({ serverIdentityId: 'srv_store_provider_placements', catalog: providers,
        machines: [createMachineFixture({ id: 'selected' }), createMachineFixture({ id: 'other' })] });
    const scope = storage.getState().settingsScope!;
    let input: StoreInstalledInput = { scope, projectKey: null,
        machine: { serverIdentityId: 'srv_store_provider_placements', machineId: 'selected' } };
    const hook = await renderHook(() => storeKinds.provider.useInstalled(input, { presented: true }, useInstalledScope(input)));
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toBe('available'));
    expect(hook.getCurrent().rows.map(row => row.native.id)).toEqual(['pc_selected']);
    input = { ...input, projectKey: 'a-project-with-a-checkout' };
    await hook.rerender();
    expect(hook.getCurrent()).toMatchObject({ rows: [], coverage: 'available' });
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('retains native incomplete Home inventory coverage even when the Plugin census is complete', async () => {
    await account.restore({ serverIdentityId: 'srv_store_pending_inventory', machines: [createMachineFixture({ id: 'pending' })] });
    const scope = storage.getState().settingsScope!;
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
        intentReads: [], materializations: [], snapshots: [], inventoryComplete: true } });
    await act(async () => { storage.setState({ machineListStatusByServerId: Object.fromEntries(
        Object.keys(storage.getState().machineListByServerId).map(serverId => [serverId, 'loading' as const]),
    ) }); });
    const input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const hook = await renderHook(() => storeKinds.plugin.useInstalled(input, { presented: true }, useInstalledScope(input)));
    await vi.waitFor(() => expect(hook.getCurrent().coverage).toMatchObject({ partial: { kind: 'resolved', inventoryStatus: 'loading' } }));
    expect(hook.getCurrent().rows).toEqual([]);
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});
