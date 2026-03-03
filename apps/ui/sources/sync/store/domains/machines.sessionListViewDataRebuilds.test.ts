import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function createHarness(createMachinesDomain: any, initialState: any) {
    let state: any = initialState;

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMachinesDomain({ get, set } as any);
    return { get, domain };
}

describe('machines domain: sessionListViewData rebuild gating', () => {
    it('keeps sessionListViewData reference stable for machine activity-only updates', async () => {
        const buildSessionListViewDataWithServerScope = vi.fn(() => [{ type: 'built' }]);
        vi.doMock('../buildSessionListViewDataWithServerScope', () => ({
            buildSessionListViewDataWithServerScope,
        }));
        vi.doMock('../sessionListCache', () => ({
            setActiveServerSessionListCache: (_cache: any, value: any) => ({ server_a: value }),
        }));
        vi.doMock('../../domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server_a' }),
        }));

        const { createMachinesDomain } = await import('./machines');

        const initialList = [{ type: 'initial' }];
        const initialState = {
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'project',
            },
            sessionListViewData: initialList,
            sessionListViewDataByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { displayName: 'Mac' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'Mac' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).toBe(initialList);
        expect(buildSessionListViewDataWithServerScope).toHaveBeenCalledTimes(0);
    });

    it('rebuilds sessionListViewData when project header machine display changes', async () => {
        const buildSessionListViewDataWithServerScope = vi.fn(() => [{ type: 'built' }]);
        vi.doMock('../buildSessionListViewDataWithServerScope', () => ({
            buildSessionListViewDataWithServerScope,
        }));
        vi.doMock('../sessionListCache', () => ({
            setActiveServerSessionListCache: (_cache: any, value: any) => ({ server_a: value }),
        }));
        vi.doMock('../../domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server_a' }),
        }));

        const { createMachinesDomain } = await import('./machines');

        const initialList = [{ type: 'initial' }];
        const initialState = {
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'project',
            },
            sessionListViewData: initialList,
            sessionListViewDataByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { displayName: 'Mac' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'New name' },
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initialList);
        expect(buildSessionListViewDataWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('updates active server machine cache without leaking machines from other scopes', async () => {
        vi.doMock('../buildSessionListViewDataWithServerScope', () => ({
            buildSessionListViewDataWithServerScope: vi.fn(() => [{ type: 'built' }]),
        }));
        vi.doMock('../sessionListCache', () => ({
            setActiveServerSessionListCache: (_cache: any, value: any) => ({ server_a: value }),
        }));
        vi.doMock('../../domains/server/serverRuntime', () => ({
            getActiveServerSnapshot: () => ({ serverId: 'server_a' }),
        }));

        const { createMachinesDomain } = await import('./machines');

        const activeMachine = {
            id: 'm-active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: { displayName: 'Active' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const remoteMachine = {
            id: 'm-remote',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: { displayName: 'Remote' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'date',
                sessionListInactiveGroupingV1: 'date',
            },
            sessionListViewData: [],
            sessionListViewDataByServerId: {},
            machines: {
                [activeMachine.id]: activeMachine,
                [remoteMachine.id]: remoteMachine,
            },
            machineListByServerId: {
                server_a: [activeMachine],
            },
            machineListStatusByServerId: {
                server_a: 'idle',
            },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                ...activeMachine,
                updatedAt: 2,
            } as any,
        ]);

        const activeServerCache = get().machineListByServerId.server_a ?? [];
        expect(activeServerCache.map((machine: any) => machine.id)).toEqual(['m-active']);
    });
});
