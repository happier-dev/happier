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
