import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import type { ManagedInventoryQuery } from './useManagedInventory';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { useManagedInventory } = await import('./useManagedInventory');
const { presentInventoryRow } = await import('./inventoryRows');
const { machinePageHref } = await import('@/components/machines/page/machinePageHref');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } = await import('@happier-dev/protocol/deployments/healthCheckV1');
function Boundary({ children }: React.PropsWithChildren) { return <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary>; }
function watchesField(serviceWatchesV1: unknown) {
    return MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata!, serviceWatchesV1 }).serviceWatchesV1!;
}

afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it('consumes only recorded watches as configured subjects across both doors without native discovery', async () => {
    const identity = 'srv_inventory_recorded_watches';
    const watches = watchesField({ v: 1, watches: [{ v: 1, watchId: 'adopted-native', name: 'Database watch',
        adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'opaque-native-id', lifecyclePurpose: 'infrastructure' }] });
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, serviceWatchesV1: watches } }));
    await account.restore({ serverIdentityId: identity, machines });
    const scope = storage.getState().settingsScope!;
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toHaveLength(2));
    expect(hook.getCurrent().rows.filter(row => row.kind === 'watchedService')).toHaveLength(2);
    const native = hook.getCurrent().operationalFamilies.watchedService.rows[0]!;
    expect(presentInventoryRow(native, query).home.href).toBe(machinePageHref({ door: 'rail', target: { serverId: scope.serverId, machineId: 'a' },
        tab: { id: 'services', page: 'service', service: watches.watches[0]!.watchId } }));
    // Configuration is not a native observation. Opening All starts no list, discovery, logs or control Action.
    expect(native).not.toHaveProperty('state');
    expect(rpc.state.requests).toHaveLength(0);
    query = { ...query, machine: { serverIdentityId: identity, machineId: 'b' } };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows.map(row => row.machineId)).toEqual(['b']);
    query = { ...query, projectKey: 'unproven-project' };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows).toEqual([]);
    query = { ...query, projectKey: null, presented: false };
    await act(async () => { await hook.rerender(); });
    expect(rpc.state.requests.filter(request => request.method !== 'capabilities.detect')).toHaveLength(0);
});

it('keeps watch content unchanged for heartbeat and unrelated metadata, then publishes changed watch configuration', async () => {
    const watches = watchesField({ v: 1, watches: [{ v: 1, watchId: 'recorded-service', name: 'Database',
        adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'native-database', lifecyclePurpose: 'infrastructure' }] });
    const machine = createMachineFixture({ id: 'watched-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, serviceWatchesV1: watches } });
    await account.restore({ serverIdentityId: 'srv_inventory_watch_locality', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const admittedMachine = storage.getState().machines[machine.id]!;
    const query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toHaveLength(1));
    await flushHookEffects();
    const before = hook.getCurrent().operationalFamilies.watchedService.rows;
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, activeAt: machine.activeAt + 1,
        metadataVersion: machine.metadataVersion + 1, metadata: { ...machine.metadata!, displayName: 'Renamed Machine' } }], false,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await flushHookEffects();
    expect(hook.getCurrent().operationalFamilies.watchedService.rows).toBe(before);
    const changed = watchesField({ ...watches, watches: [{ ...watches.watches[0]!, name: 'Updated database' }] });
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, metadataVersion: machine.metadataVersion + 2,
        metadata: { ...machine.metadata!, serviceWatchesV1: changed } }], false,
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows[0]?.native.name).toBe('Updated database'));
    expect(rpc.state.requests).toHaveLength(0);
    // An owner withdrawal is not another kind of unchanged content.
    await act(async () => { storage.getState().applyMachines([{ ...admittedMachine, metadataVersion: machine.metadataVersion + 3, revokedAt: 1 }], false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.watchedService.rows).toEqual([]));
});

function setupField(sources: readonly unknown[]) {
    return MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata!,
        setup: { version: 1, revision: 1, exclusions: [], sources } }).setup!;
}
const healthCheckSummary = (id: string, enabled = true) => createAutomationDefinitionSummary({ id, name: `Check ${id}`, description: null, enabled,
    targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
    triggers: [{ id: `33333333-3333-4333-8333-33333333333${id}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
        eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' }, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null }] } as never);

it('lists each attached preset as Setup on its Machine, including one that has never run, without a Software duplicate for direct installs', async () => {
    const identity = 'srv_inventory_setup';
    const setup = setupField([
        { kind: 'bundledPreset', ref: { pluginId: 'happier.machine.recipes', localId: 'web-host', revision: '1' }, setup: { items: [] } },
        { kind: 'direct', setup: { toolchain: { adapterId: 'mise', config: '[tools]' } } },
    ]);
    const machine = createMachineFixture({ id: 'setup-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] }, setup } });
    await account.restore({ serverIdentityId: identity, machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.setup.rows).toHaveLength(1));
    expect(hook.getCurrent().operationalFamilies.setup.coverage).toBe('available');
    const row = hook.getCurrent().operationalFamilies.setup.rows[0]!;
    expect(row).toMatchObject({ kind: 'setup', machineId: 'setup-machine' });
    expect(row.source.kind).toBe('bundledPreset');
    expect(presentInventoryRow(row, query).home.href).toBe(machinePageHref({ door: 'rail', target: { serverId: scope.serverId, machineId: 'setup-machine' }, tab: { id: 'setup' } }));
    expect(hook.getCurrent().rows.some(candidate => candidate.kind === 'setup')).toBe(true);
    expect(rpc.state.requests).toHaveLength(0);
});

it('lists saved Checks from Automation summaries, keeps never-run and off subjects, and does not place them on a selected Machine', async () => {
    await account.restore({ serverIdentityId: 'srv_inventory_checks', machines: [] });
    const scope = storage.getState().settingsScope!;
    await act(async () => { storage.setState({ automations: { a: healthCheckSummary('a'), b: healthCheckSummary('b', false) }, isDataReady: true, automationDefinitionNextCursor: null }); });
    let query: ManagedInventoryQuery = { scope, machine: null, projectKey: null, presented: true };
    const hook = await renderHook(() => useManagedInventory(query), { wrapper: Boundary });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toHaveLength(2));
    expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toBe('available');
    const row = hook.getCurrent().operationalFamilies.configuredCheck.rows.find(candidate => candidate.automationId === 'b')!;
    const presented = presentInventoryRow(row, query);
    expect(presented.facts.title).toBe('Check b');
    expect(presented.facts.status).toBe('off');
    expect(presented.home.href).toBe('/automations/b');
    await act(async () => { storage.setState({ automationDefinitionNextCursor: 'more' }); });
    await vi.waitFor(() => expect(hook.getCurrent().operationalFamilies.configuredCheck.coverage).toEqual({ partial: 'automation_page' }));
    query = { ...query, machine: { serverIdentityId: 'srv_inventory_checks', machineId: 'unknown' } };
    await hook.rerender();
    expect(hook.getCurrent().operationalFamilies.configuredCheck.rows).toEqual([]);
    await hook.unmount();
});
