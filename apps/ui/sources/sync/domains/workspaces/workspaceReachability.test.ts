import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { isWorkspaceScopeReachableFromState } from './workspaceReachability';

describe('workspaceReachability', () => {
    it('honors settled exact-machine absence instead of borrowing a stale active row', () => {
        const stale = createMachineFixture({ id: 'machine-gone', active: true, activeAt: Date.now() });
        const other = createMachineFixture({ id: 'machine-other', active: true, activeAt: Date.now() });
        expect(isWorkspaceScopeReachableFromState({
            isDataReady: true, machines: { [stale.id]: stale },
            machineListByServerId: { 'server-a': [other] }, machineListStatusByServerId: { 'server-a': 'idle' },
        }, { serverId: 'server-a', machineId: stale.id, rootPath: '/repo' }, 'server-a')).toBe(false);
    });

    it('requires the exact server-scoped machine to be currently online', () => {
        const activeMachine = { id: 'shared-machine', active: true, updatedAt: Date.now() };
        const offlineOtherServerMachine = { id: 'shared-machine', active: false, updatedAt: 0 };
        const state = {
            isDataReady: true,
            machines: { shared: activeMachine },
            machineListByServerId: { 'server-b': [offlineOtherServerMachine] },
        };

        expect(isWorkspaceScopeReachableFromState(state as never, {
            serverId: 'server-a',
            machineId: 'shared-machine',
            rootPath: '/repo',
        }, 'server-a')).toBe(true);
        expect(isWorkspaceScopeReachableFromState(state as never, {
            serverId: 'server-b',
            machineId: 'shared-machine',
            rootPath: '/repo',
        }, 'server-a')).toBe(false);
    });
});
