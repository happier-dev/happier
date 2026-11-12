import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { StoreInstalledInput } from '../catalog/storeKinds';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useManagedInventory, summarizeInstalledFamilies } = await import('./useManagedInventory');
const { storage } = await import('@/sync/domains/state/storage');
const { refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
const { useMachinesNeedingAttention } = await import('@/components/machines/attention/useMachinesNeedingAttention');
const { useMcpServerMachineTests } = await import('@/components/settings/mcpServers/status/useMcpServerMachineTests');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
function Boundary({ children }: React.PropsWithChildren) { return <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary>; }

it('shares one admission across Installed and reports every cold family as loading until credentials settle', async () => {
    const home = await account.restore({ serverIdentityId: 'srv_inventory_cold', machines: [] });
    const scope = storage.getState().settingsScope!;
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: {
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } },
    } });
    const owner = await import('../catalog/storeAccountAdmission');
    const admission = vi.spyOn(owner, 'useInstalledScope');
    const frames: Array<ReturnType<typeof useManagedInventory>> = [];
    const hook = await renderHook(() => {
        const view = useManagedInventory({ scope, machine: null, projectKey: null, presented: true });
        frames.push(view);
        return view;
    }, { wrapper: Boundary });
    try {
        expect(frames[0]!.families).toHaveProperty('app', expect.objectContaining({ rows: [], coverage: 'loading' }));
        expect(Object.values(frames[0]!.families).every(family => family.coverage === 'loading')).toBe(true);
        expect(frames[0]!.operationalFamilies.watchedService.coverage).toBe('loading');
        expect(admission).toHaveBeenCalledTimes(frames.length);
        await vi.waitFor(() => expect(hook.getCurrent().families.mcpServer.coverage).not.toBe('loading'));
        expect(hook.getCurrent().families.mcpServer.coverage).toBe('available');
        expect(admission).toHaveBeenCalledTimes(frames.length);
    } finally { admission.mockRestore(); await hook.unmount(); }
});

it('admits the exact Machine from the real Installed URL before native detail acquisition and refuses malformed narrowing', async () => {
    const identity = 'srv_inventory_route';
    await account.restore({ serverIdentityId: identity, machines: [createMachineFixture({ id: 'exact', activeAt: Date.now() })] });
    const scope = storage.getState().settingsScope!;
    const detail = createInstalledPluginCapabilityFixture({ pluginId: 'example.route', title: 'Exact detail', version: '2.0.0' });
    rpc.intercept('capabilities.detect', () => ({ protocolVersion: 1, results: {
        'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [detail] } },
    } }));
    const { InstalledPage } = await import('./InstalledPage');
    const { inventoryMachineKey } = await import('./inventoryRows');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { resolveCompactAppDestinations, resolveDestinationRefFromHref } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: false, friends: false } });
    const target = resolveDestinationRefFromHref(catalog, '/plugins?view=installed')!;
    const tree = (filters: string) => <DestinationInstanceHost tabId="installed-route" ref={{ ...target, params: { ...target.params, filters } }}
        pathname="/plugins" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {}, setParams: () => {} }}>
        <InstalledPage />
    </DestinationInstanceHost>;
    const screen = await renderScreen(tree('{'));
    expect.soft(screen.findAllByTestId('store.installed.invalid').length).toBeGreaterThan(0);
    expect(rpc.state.requests).toHaveLength(0);
    const machine = { serverIdentityId: identity, machineId: 'exact' };
    await screen.update(tree(JSON.stringify({ machine: { include: [inventoryMachineKey(scope, machine)], exclude: [] } })));
    await vi.waitFor(() => expect(rpc.state.requests.map(request => [request.method, request.machineId, request.accountId]))
        .toEqual([['capabilities.detect', 'exact', scope.accountId]]));
});

afterEach(async () => { standardCleanup(); clearPluginAccountAvailabilityProjection(); await account.reset(); rpc.reset(); });

it('mounts Updates with only MCP, Skill, Agent and Plugin acquisition, preserving the native rows', async () => {
    const { ACP_CATALOG_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
    const origin = { kind: 'registry', provenance: { sourceId: 'registry:updates', sourceUrl: 'https://updates-registry.test',
        format: 'git', itemId: 'docs', importedAt: 1, ref: { kind: 'version', version: '1' } },
        upstream: { state: 'update_available', latest: { kind: 'version', version: '2' } } };
    const home = await createSeededSkillsHome('https://updates-demand.test', { skills: [{ id: 'review-changes' }],
        handleRequest: async path => path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1 ? Response.json({ status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'docs', name: 'docs', title: 'Docs MCP',
                transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, origin, createdAt: 1, updatedAt: 1 }] } } })
            : path === ACP_CATALOG_ROWS_ROUTE_V1 ? Response.json({ status: 'present', revision: 1,
                content: { t: 'plain', v: { v: 1, definitions: [{ id: 'docs', name: 'docs', title: 'Docs agent',
                    launch: { kind: 'command', command: 'docs', args: [] }, origin, createdAt: 1, updatedAt: 1 }] } } }) : null });
    const { storeKinds } = await import('../catalog/storeKinds');
    const watched = await import('./managedOperationalInventory');
    const attention = await import('./useManagedInventoryAttention');
    // Call-through instrumentation measures mounted demand; every internal hook still runs unchanged.
    const families = {
        app: vi.spyOn(storeKinds.app, 'useInstalled'),
        mcpServer: vi.spyOn(storeKinds.mcpServer, 'useInstalled'),
        skill: vi.spyOn(storeKinds.skill, 'useInstalled'),
        agent: vi.spyOn(storeKinds.agent, 'useInstalled'),
        provider: vi.spyOn(storeKinds.provider, 'useInstalled'),
        plugin: vi.spyOn(storeKinds.plugin, 'useInstalled'),
        software: vi.spyOn(storeKinds.software, 'useInstalled'),
    };
    const watch = vi.spyOn(watched, 'useManagedWatchedServices');
    const notices = vi.spyOn(attention, 'useManagedInventoryAttention');
    try {
        const { StoreUpdatesScreen } = await import('../updates/StoreUpdatesScreen');
        const screen = await renderScreen(<Boundary><StoreUpdatesScreen /></Boundary>);
        await vi.waitFor(() => expect(screen.findAllByTestId('store.updates.section.mcpServer').length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(screen.findAllByTestId('store.updates.section.agent').length).toBeGreaterThan(0));
        await vi.waitFor(() => expect(families.skill.mock.results.some(result => result.type === 'return'
            && result.value.rows.some(row => row.native.skillId === 'review-changes'))).toBe(true));
        expect(screen.findAllByTestId('store.updates').length).toBeGreaterThan(0);
        for (const kind of ['app', 'provider', 'software'] as const) expect(families[kind]).not.toHaveBeenCalled();
        expect(watch).not.toHaveBeenCalled();
        expect(notices).not.toHaveBeenCalled();
        for (const kind of ['mcpServer', 'skill', 'agent', 'plugin'] as const) {
            expect(families[kind]).toHaveBeenCalled();
            expect(families[kind]!.mock.results.every(result => result.type === 'return' && Array.isArray(result.value.rows))).toBe(true);
        }
        expect(rpc.state.requests).toHaveLength(0);
        await screen.unmount();
    } finally {
        for (const spy of Object.values(families)) spy.mockRestore();
        watch.mockRestore(); notices.mockRestore();
        await home.dispose();
    }
});

it('keeps Plugins loading, not failed, until the Account availability projection arrives', async () => {
    await account.restore({ serverIdentityId: 'srv_inventory_plugins_arrival', machines: [] });
    const scope = storage.getState().settingsScope!;
    await act(async () => { clearPluginAccountAvailabilityProjection(); });
    const hook = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    try {
        await flushHookEffects();
        expect(hook.getCurrent().families.plugin.coverage).toBe('loading');
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } }); });
        await vi.waitFor(() => expect(hook.getCurrent().families.plugin.coverage).not.toBe('loading'));
    } finally { await hook.unmount(); }
});

it('reports a missing held MCP secret through its canonical reference reader without material acquisition', async () => {
    const home = await account.restore({ serverIdentityId: 'srv_inventory_secret_attention', machines: [] });
    const scope = storage.getState().settingsScope!;
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: {
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, bindings: [], servers: [{
            id: 'needs-key', name: 'needs-key', transport: 'stdio', stdio: { command: 'server', args: [] },
            env: { TOKEN: { t: 'savedSecret', secretId: 'missing-token' } }, createdAt: 1, updatedAt: 1,
        }] } },
    } });
    const hook = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().attention).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'capability', native: expect.objectContaining({ kind: 'key' }) }),
    ])));
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('shares exact selected-Machine details across both doors and fences hidden, offline, foreign-Home and delayed answers', async () => {
    const identity = 'srv_inventory_demand';
    const machines = Array.from({ length: 101 }, (_, index) => createMachineFixture({ id: `target-${index}`, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } }));
    const home = await account.restore({ serverIdentityId: identity, machines });
    const scope = storage.getState().settingsScope!;
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    await act(async () => { await account.selectMachine(scope.serverId, 'target-1', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins); });
    const settings = storage.getState().settings;
    const a = createInstalledPluginCapabilityFixture({ pluginId: 'example.demand', title: 'A native detail', version: '2.0.0' });
    const b = createInstalledPluginCapabilityFixture({ pluginId: a.pluginId, title: 'B native detail', version: '3.0.0' });
    const response = (detail: typeof a) => ({ protocolVersion: 1, results: {
        'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [detail] } },
    } });
    const late = createDeferred<ReturnType<typeof response>>();
    let delayA = false;
    rpc.intercept('capabilities.detect', request => request.machineId === 'target-0'
        ? delayA ? late.promise : response(a) : response(b));
    let input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    let presented = true;
    const first = await renderHook(() => useManagedInventory({ ...input, presented }), { wrapper: Boundary });
    await vi.waitFor(() => expect(first.getCurrent().families.plugin.coverage).toBe('available'));
    await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2,
        intentReads: [], snapshots: [], inventoryComplete: true,
        materializations: [...machines.map(machine => ({ serverIdentityId: identity, machineId: machine.id })),
            { serverIdentityId: 'srv_foreign_inventory', machineId: 'target-0' }].map(target => ({ ...target,
            materializationId: `${target.serverIdentityId}/${target.machineId}`, pluginId: a.pluginId, version: '1.0.0',
            sourceClass: 'localPath', portableRelease: false, uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 })) } }); });
    expect(first.getCurrent().families.plugin.rows[0]).not.toHaveProperty('detail');
    expect(rpc.state.requests).toHaveLength(0);
    input = { ...input, machine: { serverIdentityId: identity, machineId: 'target-0' } };
    await first.rerender();
    await vi.waitFor(() => expect(first.getCurrent().families.plugin.rows[0]?.detail).toEqual(a));
    const second = await renderHook(() => useManagedInventory({ ...input, presented }), { wrapper: Boundary });
    await vi.waitFor(() => expect(second.getCurrent().families.plugin.rows[0]?.detail).toEqual(a));
    expect(rpc.state.requests.map(request => [request.method, request.machineId, request.accountId]))
        .toEqual([['capabilities.detect', 'target-0', scope.accountId]]);
    expect(second.getCurrent().families.plugin.rows[0]?.installations).toHaveLength(1);
    const { presentInventoryRow, inventoryMachineKey } = await import('./inventoryRows');
    const row = second.getCurrent().families.plugin.rows[0]!;
    expect(presentInventoryRow(row, input).machines).toEqual([input.machine]);
    expect(inventoryMachineKey(scope, input.machine!)).not.toBe(inventoryMachineKey(scope,
        { serverIdentityId: 'srv_foreign_inventory', machineId: 'target-0' }));
    const refresh = first.getCurrent().families.plugin.continuation!;
    presented = false;
    await first.rerender(); await second.rerender();
    await act(async () => { refresh(); });
    await flushHookEffects();
    expect(rpc.state.requests).toHaveLength(1);
    expect(first.getCurrent().families.plugin.continuation).toBeUndefined();
    await second.unmount();
    presented = true;
    await first.rerender();
    delayA = true;
    await act(async () => { first.getCurrent().families.plugin.continuation?.(); });
    await vi.waitFor(() => expect(rpc.state.requests).toHaveLength(2));
    input = { ...input, machine: { serverIdentityId: identity, machineId: 'target-1' } };
    await first.rerender();
    expect(first.getCurrent().families.plugin.rows[0]?.detail?.title).not.toBe(a.title);
    await vi.waitFor(() => expect(first.getCurrent().families.plugin.rows[0]?.detail).toEqual(b));
    await act(async () => { late.resolve(response({ ...a, title: 'Late A must stay A' })); });
    await flushHookEffects();
    expect(first.getCurrent().families.plugin.rows[0]?.detail).toEqual(b);
    expect(rpc.state.requests.map(request => request.machineId)).toEqual(['target-0', 'target-0', 'target-1']);
    await act(async () => { await account.publishMachines(home.serverId, machines.map(machine => machine.id === 'target-0'
        ? { ...machine, active: false, activeAt: 1 } : machine)); });
    const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    // A failed addressed transport is the native immediate-offline fact. A stale
    // HTTP activity timestamp cannot override the more recent successful reply.
    await act(async () => { recordMachineRequestFailed({ ...scope, machineId: 'target-0', observedAtMs: Date.now() + 1 }); });
    const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/executionTarget');
    expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: identity, machineId: 'target-0' }, { accountScope: scope })).toBeNull();
    input = { ...input, machine: { serverIdentityId: identity, machineId: 'target-0' } };
    await first.rerender();
    await flushHookEffects();
    expect(first.getCurrent().families.plugin.rows[0]?.installations[0]?.materialization.version).toBe('1.0.0');
    expect(first.getCurrent().families.plugin.continuation).toBeUndefined();
    expect(rpc.state.requests).toHaveLength(3);
    for (const machine of [{ serverIdentityId: 'srv_foreign_inventory', machineId: 'target-0' },
        { serverIdentityId: identity, machineId: 'missing' }, { serverIdentityId: 'srv_missing_identity', machineId: 'target-0' }]) {
        input = { ...input, machine };
        await first.rerender();
        expect(first.getCurrent().rows).toEqual([]);
        expect(first.getCurrent().coverage).toBe('unavailable');
    }
    expect(rpc.state.requests).toHaveLength(3);
    expect(storage.getState().settings).toBe(settings);
    await first.unmount();
});

it('does not mistake an available native refresh handle for incomplete membership', () => {
    let refreshes = 0;
    const refresh = () => { refreshes++; };
    expect(summarizeInstalledFamilies([{ rows: [], coverage: 'available', continuation: refresh }]))
        .toEqual({ coverage: 'complete', loading: false });
    expect(summarizeInstalledFamilies([{ rows: [], coverage: { partial: 'scope-retired' } }]))
        .toEqual({ coverage: 'partial', loading: false });
    expect(summarizeInstalledFamilies([{ rows: [], coverage: { unavailable: 'scope-retired' } }]))
        .toEqual({ coverage: 'unavailable', loading: false });
    expect(summarizeInstalledFamilies([{ rows: [], coverage: 'loading' }]))
        .toEqual({ coverage: 'partial', loading: true });
    expect(refreshes).toBe(0);
});

it('refuses ambiguous portable Home correspondence without reading either duplicate Machine', async () => {
    const identity = 'srv_inventory_ambiguous';
    const alias = 'srv_inventory_ambiguous_alias';
    await account.restore({ serverIdentityId: identity, machines: [createMachineFixture({ id: 'same-id', activeAt: Date.now() })] });
    const scope = storage.getState().settingsScope!;
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const { MMKV } = await import('react-native-mmkv');
    const { scopedStorageId, readStorageScopeFromEnv } = await import('@/utils/system/storageScope');
    const persisted = new MMKV({ id: scopedStorageId('server-profiles', readStorageScopeFromEnv()) });
    const original = persisted.getString('server-state-v1')!;
    const state: unknown = JSON.parse(original);
    if (!state || typeof state !== 'object') throw new Error('Expected fixture Home profile state');
    const profile = profiles.getServerProfileById(identity)!;
    // Genuine legacy persistence boundary: two distinct Homes retain one old
    // alias. Equal stable identities are correctly deduplicated by this owner.
    persisted.set('server-state-v1', JSON.stringify({ ...state, servers: {
        ...Object.fromEntries(profiles.listServerProfiles().map(profile => [profile.id, profile])),
        [profile.id]: { ...profile, legacyServerIds: [...(profile.legacyServerIds ?? []), alias] },
        'ambiguous-legacy-profile': { ...profile, id: 'ambiguous-legacy-profile', serverIdentityId: 'srv_inventory_other_legacy_home',
            homeConnectionDescriptor: undefined, serverUrl: 'https://duplicate-inventory.test', canonicalServerUrl: 'https://duplicate-inventory.test',
            legacyServerIds: [alias] },
    } }));
    try {
        expect(profiles.resolveServerProfileForPortableIdentity(alias).kind).toBe('ambiguous');
        const hook = await renderHook(() => useManagedInventory({ scope,
            machine: { serverIdentityId: alias, machineId: 'same-id' }, projectKey: null, presented: true }), { wrapper: Boundary });
        await flushHookEffects();
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().coverage).toBe('unavailable');
        expect(rpc.state.requests).toHaveLength(0);
        await hook.unmount();
    } finally { persisted.set('server-state-v1', original); }
});

it('composes the same admitted MCP for All and an exact Machine without native fleet work', async () => {
    const machines = Array.from({ length: 101 }, (_, index) => createMachineFixture({ id: `machine-${index}`, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } }));
    const home = await account.restore({ serverIdentityId: 'srv_inventory_two_doors', machines,
        catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
    const scope = storage.getState().settingsScope!;
    await publishMachineInventoryForTest(scope, machines.map(machine => createHydratedPlainMachineFixture({
        id: machine.id, accountId: scope.accountId, machine,
    })));
    let reads = 0;
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
        reads++;
        return { body: { status: 'present', revision: 1, content: { t: 'plain', v: { v: 1,
            servers: ['docs', 'off', 'exception'].map(id => ({ id, name: id, title: id === 'docs' ? 'Docs' : id,
                transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 1 })),
            bindings: [{ id: 'docs-everywhere', serverId: 'docs', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
                { id: 'exception-everywhere', serverId: 'exception', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 },
                { id: 'exception-codex', serverId: 'exception', enabled: false, agentId: 'codex',
                    target: { t: 'machine', machineId: 'machine-0' }, createdAt: 1, updatedAt: 1 }] } } } };
    } });
    let input: StoreInstalledInput = { scope, machine: null, projectKey: null };
    const all = await renderHook(() => useManagedInventory({ ...input, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(all.getCurrent().families.mcpServer.rows).toHaveLength(3));
    await vi.waitFor(() => expect(all.getCurrent().families.plugin.coverage).toBe('available'));
    await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], snapshots: [], inventoryComplete: true,
        materializations: [{ serverIdentityId: 'srv_inventory_two_doors', machineId: 'machine-0', materializationId: 'recorded-local',
            pluginId: 'example.managed', version: '1.2.3', sourceClass: 'localPath', portableRelease: false,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1 }] } }); });
    expect(all.getCurrent().rows.some(row => row.kind === 'mcpServer')).toBe(true);
    const native = all.getCurrent().families.mcpServer.rows[0]!;
    expect(all.getCurrent().rows).toContain(native);
    expect(all.getCurrent().rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'agent', subject: 'machineAgent', native: 'codex' }),
        expect.objectContaining({ kind: 'plugin', native: expect.objectContaining({ pluginId: 'example.managed',
            installations: [expect.objectContaining({ materialization: expect.objectContaining({ version: '1.2.3', sourceClass: 'localPath' }) })] }) }),
    ]));
    expect(all.getCurrent().attention.some(entry => entry.kind === 'capability' && entry.row?.kind === 'plugin')).toBe(false);
    expect(reads).toBe(1);
    expect(rpc.state.requests).toHaveLength(0);
    const selectedPlugin = createInstalledPluginCapabilityFixture({ pluginId: 'example.managed', title: 'Managed plugin', version: '1.2.3' });
    rpc.intercept('capabilities.detect', () => ({ protocolVersion: 1, results: {
        'tool.plugins': { ok: true, checkedAt: 1, data: { installedPlugins: [selectedPlugin] } },
    } }));
    input = { ...input, machine: { serverIdentityId: 'srv_inventory_two_doors', machineId: 'machine-0' } };
    const machine = await renderHook(() => useManagedInventory({ ...input, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(machine.getCurrent().rows.some(row => row.kind === 'mcpServer')).toBe(true));
    await vi.waitFor(() => expect(machine.getCurrent().families.plugin.rows[0]?.detail).toEqual(selectedPlugin));
    const scoped = machine.getCurrent().families.mcpServer.rows[0]!;
    expect(machine.getCurrent().families.mcpServer.rows.map(row => row.native.id)).toEqual(['docs']);
    expect(scoped.key).toBe(native.key);
    expect(scoped.native).toBe(native.native);
    expect(reads).toBe(1);
    expect(rpc.state.requests.map(request => [request.method, request.machineId])).toEqual([['capabilities.detect', 'machine-0']]);
    input = { ...input, machine: { serverIdentityId: 'srv_other_home', machineId: 'machine-0' } };
    await machine.rerender();
    expect(machine.getCurrent()).toMatchObject({ rows: [], coverage: 'unavailable' });
    expect(reads).toBe(1);
    expect(rpc.state.requests.map(request => [request.method, request.machineId])).toEqual([['capabilities.detect', 'machine-0']]);
    await machine.unmount();
    await all.unmount();
});

it('retains native partial and unavailable facts instead of classifying zero rows as confirmed empty', async () => {
    const machine = createMachineFixture({ id: 'complete-inventory', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
    const home = await account.restore({ serverIdentityId: 'srv_inventory_coverage', machines: [machine], catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
    const scope = storage.getState().settingsScope!;
    const answer = (servers: readonly unknown[]) => account.home.answer(home.serverId,
        `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, servers, bindings: [] } } } });
    answer([]);
    const hook = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().families.mcpServer.coverage).toBe('available'));
    expect(hook.getCurrent().families.mcpServer.rows).toEqual([]);
    answer([{ invalid: 'unreadable-neighbor' }]);
    await act(async () => { await refreshMcpServerCatalog(scope); });
    expect(hook.getCurrent().families.mcpServer).toMatchObject({ rows: [], coverage: { partial: { status: 'partial' } } });
    expect(hook.getCurrent().coverage).toBe('partial');
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { status: 403, body: { error: 'forbidden' } });
    await act(async () => { await refreshMcpServerCatalog(scope); });
    expect(hook.getCurrent().families.mcpServer.coverage).toMatchObject({ unavailable: { reason: 'forbidden' } });
    expect(hook.getCurrent().coverage).toBe('partial');
    await hook.unmount();
    await flushHookEffects();
    expect(rpc.state.requests).toHaveLength(0);
});

it('uses current native MCP and Machine attention, then removes conditions from source changes without writes or probes', async () => {
    const resources = MachinePublishedResourceSummaryV1Schema.parse({
        v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
        attention: { level: 'needs_you', reasons: [{ key: 'memory', metric: 'memory', kind: 'memory_pressure', since: 1,
            level: 'needs_you', pressure: 'critical', swapping: false }] },
    });
    const machine = createMachineFixture({ id: 'attention-machine', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } }, daemonState: { resources } });
    const home = await account.restore({ serverIdentityId: 'srv_inventory_conditions', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    observeMachinePresenceForTest(scope, [machine.id]);
    storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    let servers: readonly unknown[] = [{ id: 'oauth', name: 'oauth', transport: 'http', remote: {
        url: 'https://mcp.example.test', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }];
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { select: () => ({ body: {
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, servers, bindings: [] } },
    } }) });
    let nativeMachines: ReturnType<typeof useMachinesNeedingAttention> = [];
    const hook = await renderHook(() => {
        nativeMachines = useMachinesNeedingAttention();
        return useManagedInventory({ scope, machine: null, projectKey: null, presented: true });
    }, { wrapper: Boundary });
    await vi.waitFor(() => expect(nativeMachines).toEqual([expect.objectContaining({ machineId: machine.id })]));
    await vi.waitFor(() => expect(hook.getCurrent().attention.some(entry => entry.kind === 'capability' && entry.native.kind === 'signin')).toBe(true));
    await vi.waitFor(() => expect(hook.getCurrent().attention.some(entry => entry.kind === 'machine')).toBe(true));
    const attention = hook.getCurrent().attention.find(entry => entry.kind === 'machine');
    expect(attention).toMatchObject({ native: { machineId: machine.id }, href: expect.stringContaining(`/machines/${machine.id}`) });
    const settings = storage.getState().settings;
    servers = [];
    await act(async () => { await refreshMcpServerCatalog(scope); });
    await act(async () => { await account.publishMachines(home.serverId, [{ ...machine,
        daemonStateVersion: machine.daemonStateVersion + 1, daemonState: { resources: {
            ...resources, attention: { level: 'calm', reasons: [] },
        } } }]); });
    await vi.waitFor(() => expect(hook.getCurrent().attention).toEqual([]));
    expect(storage.getState().settings).toBe(settings);
    expect(rpc.state.requests).toHaveLength(0);
    await hook.unmount();
});

it('consumes real Skill library membership and keeps unrelated Artifact arrivals out of inventory publication', async () => {
    const home = await createSeededSkillsHome('https://inventory-skills.test', { skills: [{ id: 'review-changes' }] });
    const scope = storage.getState().settingsScope!;
    const hook = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().families.skill.rows.some(row => row.native.skillId === 'review-changes')).toBe(true));
        const row = hook.getCurrent().families.skill.rows.find(row => row.native.skillId === 'review-changes')!;
        expect(hook.getCurrent().rows).toContain(row);
        expect(hook.getCurrent().attention.some(entry => entry.kind === 'capability' && entry.row?.key === row.key)).toBe(false);
        const rows = hook.getCurrent().rows;
        const unrelated = Array.from({ length: 1000 }, (_, index) => ({ id: `document-${index}`, title: 'Unrelated document',
            header: { kind: 'markdown', title: 'Unrelated document' }, rawHeader: { kind: 'markdown', title: 'Unrelated document' },
            isDecrypted: true as const, ownerAccountId: scope.accountId, access: 'owner' as const, publicAudience: 'none' as const,
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
        await act(async () => { storage.getState().applyArtifacts(unrelated); });
        const beforeReads = home.requests.length;
        await act(async () => { storage.getState().updateArtifact({ ...unrelated[0]!, updatedAt: 2 }); });
        expect(hook.getCurrent().families.skill.rows.find(current => current.key === row.key)).toBe(row);
        expect(hook.getCurrent().rows).toBe(rows);
        expect(home.requests.length).toBe(beforeReads);
        expect(rpc.state.requests).toHaveLength(0);
    } finally { await hook.unmount(); await home.dispose(); }
});

it('joins a native held Test failure to current Machine presence without starting another Test', async () => {
    const machine = createMachineFixture({ id: 'tested-machine', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
    const home = await account.restore({ serverIdentityId: 'srv_inventory_held_test', machines: [machine], waivedActions: ['mcp.servers.test'] });
    const scope = storage.getState().settingsScope!;
    observeMachinePresenceForTest(scope, [machine.id]);
    storage.getState().applyMachines([machine], false, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [{ id: 'tested', name: 'tested', transport: 'stdio',
            stdio: { command: 'test-server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{
            id: 'test-on', serverId: 'tested', enabled: true, target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1,
        }] } } } });
    const hook = await renderHook(() => ({ test: useMcpServerMachineTests('tested'),
        inventory: useManagedInventory({ scope, machine: null, projectKey: null, presented: true }) }), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().inventory.families.mcpServer.rows).toHaveLength(1));
    expect(hook.getCurrent().inventory.attention).toEqual([]);
    // Only this explicit native Test intent may acquire a daemon result. The
    // synthetic Socket boundary refuses the test, which the real owner retains.
    await act(async () => { hook.getCurrent().test.run([machine.id]); });
    await vi.waitFor(() => expect(hook.getCurrent().test.results[machine.id]).toMatchObject({ ok: false }));
    await vi.waitFor(() => expect(hook.getCurrent().inventory.attention.some(entry => entry.kind === 'capability'
        && entry.native.kind === 'error')).toBe(true));
    const requests = rpc.state.requests.length;
    await hook.rerender();
    expect(rpc.state.requests).toHaveLength(requests);
    await hook.unmount();
});
