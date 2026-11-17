import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type MachinePoolPrivateViewV1, type MachinePoolViewV1 } from '@happier-dev/protocol/machines/pools/v1';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useTeamSharedMachinePools } = await import('./useTeamSharedMachinePools');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChangeWake } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { storage } = await import('@/sync/domains/state/storage');
const path = machinePoolActionEndpointPathV1('machines.pools.list');

const personalPool = {
    pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Personal', description: null,
        revision: 0, createdAt: 1, updatedAt: 1, members: [] },
    availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
} satisfies MachinePoolViewV1;

function sharedPool(teamId: string): MachinePoolPrivateViewV1 {
    return {
        sharedWithTeamScope: 'team',
        pool: { ...personalPool.pool, id: '00000000-0000-4000-8000-000000000002',
            audience: { kind: 'team', teamId }, name: { kind: 'available',
                label: { content: { t: 'plain', v: teamId }, recipientEnvelope: null } } },
        availability: personalPool.availability,
    };
}

beforeEach(async () => { resetTeamActionClientForTests(); await home.reset(); });
afterEach(async () => { standardCleanup(); resetTeamActionClientForTests(); await home.reset(); });

it('reads only the selected Team on demand and keeps the global Pool inventory intact', async () => {
    const serverId = await home.addHome({ name: 'Pool Home', serverUrl: 'https://team-pools.example.test',
        accountId: 'pool-reader', teamsEnabled: true, machinePoolsEnabled: true });
    const scope = { serverId, accountId: 'pool-reader' };
    storage.getState().beginMachinePoolAccountScope(serverId, scope.accountId);
    storage.getState().replaceMachinePools([personalPool], { sourceServerId: serverId, sourceAccountId: scope.accountId });
    const globalPools = storage.getState().machinePoolListByServerId[serverId];
    home.answer(serverId, path, { select: input => ({ body: { pools: [sharedPool(
        typeof input === 'object' && input !== null && 'sharedWithTeamId' in input
            ? String(input.sharedWithTeamId) : 'unscoped-pool',
    )] } }) });
    const screen = await renderHook((input: { enabled: boolean; teamId: string }) => useTeamSharedMachinePools({
        scope: { ...scope }, address: { serverId, teamId: input.teamId }, enabled: input.enabled,
    }), { initialProps: { enabled: false, teamId: 'team-alpha' } });
    expect(home.requestsFor(path)).toHaveLength(0);
    await screen.rerender({ enabled: true, teamId: 'team-alpha' });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(screen.getCurrent().rows.map(row => row.pool.name)).toEqual(['team-alpha']);
    expect(screen.getCurrent().rows[0].sharedWithTeamScope).toBe('team');
    expect(home.requestsFor(path).map(request => request.input)).toEqual([{ sharedWithTeamId: 'team-alpha' }]);
    expect(storage.getState().machinePoolListByServerId[serverId]).toBe(globalPools);
    expect(screen.getCurrent().hasMore).toBe(false);
    await act(async () => { await screen.getCurrent().loadMore(); });
    expect(home.requestsFor(path)).toHaveLength(1);
    const rows = screen.getCurrent().rows;
    await screen.rerender({ enabled: true, teamId: 'team-alpha' });
    expect(screen.getCurrent().rows).toBe(rows);
    await act(async () => {
        for (let settingsVersion = 1; settingsVersion <= 20; settingsVersion++) {
            publishHomeAccountChangeWake(serverId, { t: 'account-settings-changed', settingsVersion }, 'socket');
        }
    });
    expect(home.requestsFor(path)).toHaveLength(1);
    await act(async () => { publishHomeAccountChangeWake(serverId, {
        t: 'account-change', changeKinds: ['machinePool'], entityIds: [personalPool.pool.id],
    }, 'socket'); });
    await waitForHomeGovernance(() => expect(home.requestsFor(path)).toHaveLength(2));
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(screen.getCurrent().rows).toBe(rows);
    await screen.rerender({ enabled: true, teamId: 'team-beta' });
    await waitForHomeGovernance(() => expect(screen.getCurrent().rows.map(row => row.pool.name)).toEqual(['team-beta']));
    expect(storage.getState().machinePoolListByServerId[serverId]).toBe(globalPools);
    await screen.rerender({ enabled: false, teamId: 'team-beta' });
    expect(screen.getCurrent().rows).toEqual([]);
    await act(async () => { publishHomeAccountChangeWake(serverId, {
        t: 'account-change', changeKinds: ['machinePool'], entityIds: [personalPool.pool.id],
    }, 'socket'); });
    expect(home.requestsFor(path)).toHaveLength(3);
    await screen.rerender({ enabled: true, teamId: 'team-beta' });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(home.requestsFor(path)).toHaveLength(4);
    await act(async () => { await home.switchAccount(serverId, 'replacement-reader'); });
    await waitForHomeGovernance(() => expect(screen.getCurrent().rows).toEqual([]));
    expect(screen.getCurrent().isCurrent).toBe(false);
    expect(home.requestsFor(path)).toHaveLength(4);
});

it('does not dispatch a Team address belonging to another Home', async () => {
    const serverId = await home.addHome({ name: 'Pool scope', serverUrl: 'https://team-pool-scope.example.test',
        accountId: 'pool-reader', teamsEnabled: true, machinePoolsEnabled: true });
    const screen = await renderHook(() => useTeamSharedMachinePools({ scope: { serverId, accountId: 'pool-reader' },
        address: { serverId: 'another-home', teamId: 'team-alpha' }, enabled: true }));
    expect(screen.getCurrent().rows).toEqual([]);
    expect(screen.getCurrent().isCurrent).toBe(false);
    expect(home.requestsFor(path)).toHaveLength(0);
});
