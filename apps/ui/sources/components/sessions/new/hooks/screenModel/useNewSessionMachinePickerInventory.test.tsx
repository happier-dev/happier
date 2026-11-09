import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveNewSessionMachinePickerHistory } from '@/components/sessions/new/modules/newSessionPlacementSources';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetMachinePoolSyncRuntimeForTests } from '@/sync/engine/machines/machinePoolSyncRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';

import { useNewSessionMachinePickerInventory, type NewSessionMachinePickerInventory } from './useNewSessionMachinePickerInventory';

afterEach(() => {
    standardCleanup();
    resetRuntimeFetch();
    resetServerFeaturesClientForTests();
    resetMachinePoolSyncRuntimeForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('mounted New Session machine inventory', () => {
    it('keeps closed chrome quiet and opens current Home inventories without subscribing its parent', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        const own = createMachineFixture({ id: 'own-machine' });
        const foreign = Array.from({ length: 100 }, (_, index) => createMachineFixture({ id: `foreign-${index}` }));
        const inventory: NewSessionMachinePickerInventory = {
            allowedServerIds: [serverId, 'foreign-home'], activeServerId: serverId,
            targetServerId: 'foreign-home', recentMachinePaths: [{ machineId: foreign[0]!.id, path: '/repo' }],
            favoriteMachineIds: [foreign[0]!.id],
        };
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        let parentRenders = 0;
        let detailRenders = 0;
        let current: ReturnType<typeof useNewSessionMachinePickerInventory> = {
            groups: [], poolGroups: [], recentMachines: [], favoriteMachineItems: [],
        };
        function OpenInventory() {
            detailRenders += 1;
            current = useNewSessionMachinePickerInventory(inventory);
            return null;
        }
        function Chrome({ open }: Readonly<{ open: boolean }>) {
            parentRenders += 1;
            return open ? <OpenInventory /> : null;
        }
        try {
            storage.setState({ machines: { [own.id]: own }, machineListByServerId: {
                [serverId]: [own], 'foreign-home': foreign,
            }, machineListStatusByServerId: { [serverId]: 'idle', 'foreign-home': 'idle' } });
            const screen = await renderScreen(<Chrome open={false} />);
            const closedBaseline = parentRenders;
            for (let arrival = 1; arrival <= 3; arrival += 1) {
                const renamed = { ...foreign[0]!, metadataVersion: arrival + 1,
                    metadata: { ...foreign[0]!.metadata!, displayName: `Foreign ${arrival}` } };
                await act(async () => storage.setState({ machineListByServerId: {
                    [serverId]: [{ ...own, updatedAt: arrival + 10 }], 'foreign-home': [renamed, ...foreign.slice(1)],
                } }));
            }
            expect(parentRenders - closedBaseline).toBe(0);
            expect(detailRenders).toBe(0);
            await screen.update(<Chrome open />);
            expect(current!.groups[1]!.machines).toHaveLength(100);
            expect(current!.recentMachines[0]!.metadata?.displayName).toBe('Foreign 3');
            const openBaseline = parentRenders;
            const renamedOwn = { ...own, metadata: { ...own.metadata!, displayName: 'Current own' } };
            const renamedForeign = { ...foreign[0]!, metadata: { ...foreign[0]!.metadata!, displayName: 'Current foreign' } };
            await act(async () => storage.setState({ machines: { [own.id]: renamedOwn }, machineListByServerId: {
                [serverId]: [renamedOwn], 'foreign-home': [renamedForeign, ...foreign.slice(1)],
            } }));
            expect(parentRenders - openBaseline).toBe(0);
            expect(current!.groups[0]!.machines[0]!.metadata?.displayName).toBe('Current own');
            expect(current!.favoriteMachineItems[0]!.metadata?.displayName).toBe('Current foreign');
            const addedOwn = createMachineFixture({ id: 'added-own' });
            const addedForeign = createMachineFixture({ id: 'added-foreign' });
            await act(async () => storage.setState({ machines: { [own.id]: renamedOwn, [addedOwn.id]: addedOwn },
                machineListByServerId: { [serverId]: [renamedOwn, addedOwn], 'foreign-home': [renamedForeign, addedForeign] } }));
            expect(current!.groups[0]!.machines.map(machine => machine.id)).toEqual([own.id, addedOwn.id]);
            expect(current!.groups[1]!.machines.map(machine => machine.id)).toEqual([foreign[0]!.id, addedForeign.id]);
            await act(async () => storage.setState({ machineListByServerId: { [serverId]: [renamedOwn, addedOwn], 'foreign-home': [] } }));
            expect(current!.groups[1]!.machines).toEqual([]);
            expect(current!.recentMachines).toEqual([]);
            expect(current!.favoriteMachineItems).toEqual([]);
            await screen.update(<Chrome open={false} />);
            const retiredBaseline = detailRenders;
            await act(async () => storage.setState({ machineListByServerId: { [serverId]: [own], 'foreign-home': foreign } }));
            expect(detailRenders).toBe(retiredBaseline);
            await screen.update(<Chrome open />);
            expect(current!.groups[1]!.machines).toHaveLength(100);
            await screen.unmount();
        } finally { storage.setState(previous, true); }
    });

    it('keeps Pool rows and recovery status fresh through the same mounted inventory owner', async () => {
        const previous = storage.getState();
        const serverId = (await upsertAndActivateServer({
            serverUrl: 'https://new-session-picker-inventory.test', name: 'Picker Home',
        })).id;
        const features = buildServerFeaturesResponse();
        const enabledFeatures = { ...features, features: { ...features.features,
            machines: { ...features.features.machines, pools: { enabled: true } },
        } };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'picker-account' })).toString('base64')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(enabledFeatures)));
        resetServerFeaturesClientForTests();
        await getServerFeaturesSnapshot({ serverId, force: true });
        const pool: MachinePoolViewV1 = {
            pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Development', description: null,
                revision: 1, createdAt: 1, updatedAt: 1, members: [] },
            availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
        };
        setRuntimeFetch(async (url) => {
            if (String(url).endsWith('/v1/features')) return Response.json(enabledFeatures);
            if (String(url).endsWith('/v1/account/encryption')) return Response.json({ mode: 'plain', updatedAt: 1 });
            if (String(url).endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 0 });
            return Response.json({ pools: [pool] });
        });
        retireActiveServerAccountScopeLifetime();
        const inventory: NewSessionMachinePickerInventory = { allowedServerIds: [serverId], activeServerId: serverId,
            targetServerId: serverId, recentMachinePaths: [], favoriteMachineIds: [] };
        try {
            storage.setState({ profileScope: { serverId, accountId: 'picker-account' },
                settingsScope: { serverId, accountId: 'picker-account' }, machines: {},
                machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' },
                machinePoolListByServerId: {}, machinePoolListStatusByServerId: {}, machinePoolAccountIdByServerId: {},
            });
            const hook = await renderHook(() => useNewSessionMachinePickerInventory(inventory));
            await vi.waitFor(() => expect(hook.getCurrent().poolGroups[0]).toMatchObject({
                serverId, projectionReady: true, pools: [pool],
            }));
            const renamed = { ...pool, pool: { ...pool.pool, revision: 2, name: 'Renamed Pool' } };
            await act(async () => storage.getState().patchMachinePool(renamed, {
                sourceServerId: serverId, sourceAccountId: 'picker-account',
            }));
            expect(hook.getCurrent().poolGroups[0]!.pools[0]!.pool.name).toBe('Renamed Pool');
            await act(async () => storage.getState().setMachinePoolListStatus(serverId, 'error'));
            expect(hook.getCurrent().poolGroups[0]).toMatchObject({ status: 'error', projectionReady: false, pools: [renamed] });
            await act(async () => storage.getState().removeMachinePool(pool.pool.id, {
                sourceServerId: serverId, sourceAccountId: 'picker-account',
            }));
            expect(hook.getCurrent().poolGroups[0]!.pools).toEqual([]);
            await hook.unmount();
        } finally { storage.setState(previous, true); }
    });

    it('keeps the same history rows across a re-render with unchanged inventory', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const machines = [createMachineFixture({ id: 'kept-a' }), createMachineFixture({ id: 'kept-b' })];
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(null);
        act(() => storage.setState({ machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' } }));
        const inventory: NewSessionMachinePickerInventory = {
            allowedServerIds: [serverId], activeServerId: serverId, targetServerId: serverId,
            recentMachinePaths: [{ machineId: 'kept-a', path: '/repo' }], favoriteMachineIds: ['kept-b'],
        };
        const hook = await renderHook(() => useNewSessionMachinePickerInventory(inventory));
        const first = hook.getCurrent();
        await hook.rerender();
        expect(hook.getCurrent().recentMachines).toBe(first.recentMachines);
        expect(hook.getCurrent().favoriteMachineItems).toBe(first.favoriteMachineItems);
        await hook.unmount();
    });

    it('preserves remembered order, dedupes paths and omits retired Machines from picker history', () => {
        const a = createMachineFixture({ id: 'a' });
        const b = createMachineFixture({ id: 'b' });
        expect(resolveNewSessionMachinePickerHistory({ machines: [a, b], favoriteMachineIds: ['b', 'a'], recentMachinePaths: [
            { machineId: 'b', path: '/first' }, { machineId: 'missing', path: '/retired' },
            { machineId: 'b', path: '/second' }, { machineId: 'a', path: '/third' },
        ] })).toEqual({ recentMachines: [b, a], favoriteMachineItems: [a, b] });
    });
});
