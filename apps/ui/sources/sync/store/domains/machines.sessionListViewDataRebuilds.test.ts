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

function mockMachineDomainBoundaries(): void {
    vi.doMock('../sessionListCache', () => ({
        setActiveServerSessionListCache: (_cache: any, value: any) => ({ server_a: value }),
    }));
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server_a' }),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveMachineDisplayWarmCacheEntries: vi.fn(),
    }));
}

describe('machines domain: sessionListViewData rebuild gating', () => {
    it('keeps sessionListViewData reference stable for machine activity-only updates', async () => {
        const buildSessionListViewDataWithServerScope = vi.fn(() => [{ type: 'built' }]);
        vi.doMock('../buildSessionListViewDataWithServerScope', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../buildSessionListViewDataWithServerScope')>();
            return {
                ...actual,
                buildSessionListViewDataWithServerScope,
            };
        });
        mockMachineDomainBoundaries();

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
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
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
            machineDisplayById: {
                m1: {
                    id: 'm1',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Mac' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
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
        vi.doMock('../buildSessionListViewDataWithServerScope', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../buildSessionListViewDataWithServerScope')>();
            return {
                ...actual,
                buildSessionListViewDataWithServerScope,
            };
        });
        mockMachineDomainBoundaries();

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
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
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
            machineDisplayById: {
                m1: {
                    id: 'm1',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Mac' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
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

    it('rebuilds sessionListViewData when the reachable project-header machine display changes for stale metadata sessions', async () => {
        const buildSessionListViewDataWithServerScope = vi.fn(() => [{ type: 'built' }]);
        vi.doMock('../buildSessionListViewDataWithServerScope', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../buildSessionListViewDataWithServerScope')>();
            return {
                ...actual,
                buildSessionListViewDataWithServerScope,
            };
        });
        mockMachineDomainBoundaries();

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
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'stale.local' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
                s2: {
                    id: 's2',
                    seq: 1,
                    createdAt: 2,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    archivedAt: null,
                    metadata: { machineId: 'm-target', path: '/home/u/repo', homeDir: '/home/u', host: 'target.local' },
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
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'stale.local' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
                s2: {
                    id: 's2',
                    seq: 1,
                    createdAt: 2,
                    updatedAt: 2,
                    active: true,
                    activeAt: 2,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm-target', path: '/home/u/repo', homeDir: '/home/u', host: 'target.local' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            sessionListViewData: initialList,
            sessionListViewDataByServerId: {},
            machines: {
                'm-target': {
                    id: 'm-target',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { displayName: 'Target Mac', host: 'target.local' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
            },
            machineDisplayById: {
                'm-target': {
                    id: 'm-target',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Target Mac', host: 'target.local' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
            getProjectForSession: () => null,
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm-target',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'Rebound workstation', host: 'target.local' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initialList);
        expect(buildSessionListViewDataWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('rebuilds sessionListViewData when a reachable target machine display changes even if renderable metadata is stale', async () => {
        const buildSessionListViewDataWithServerScope = vi.fn(() => [{ type: 'built' }]);
        vi.doMock('../buildSessionListViewDataWithServerScope', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../buildSessionListViewDataWithServerScope')>();
            return {
                ...actual,
                buildSessionListViewDataWithServerScope,
            };
        });
        mockMachineDomainBoundaries();

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
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'stale.local' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1'
                    ? {
                        key: {
                            machineId: 'm-target',
                            path: '/home/u/repo',
                        },
                    }
                    : null,
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project',
                sessionListInactiveGroupingV1: 'project',
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'stale.local' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                },
            },
            sessionListViewData: initialList,
            sessionListViewDataByServerId: {},
            machines: {
                'm-target': {
                    id: 'm-target',
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
            machineDisplayById: {
                'm-target': {
                    id: 'm-target',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Mac' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm-target',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'Renamed live target' },
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initialList);
        expect(buildSessionListViewDataWithServerScope).toHaveBeenCalledTimes(1);
    });

    it('updates active server machine cache without leaking machines from other scopes', async () => {
        vi.doMock('../buildSessionListViewDataWithServerScope', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../buildSessionListViewDataWithServerScope')>();
            return {
                ...actual,
                buildSessionListViewDataWithServerScope: vi.fn(() => [{ type: 'built' }]),
            };
        });
        mockMachineDomainBoundaries();

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
            sessionListRenderables: {},
            sessionListViewData: [],
            sessionListViewDataByServerId: {},
            machines: {
                [activeMachine.id]: activeMachine,
                [remoteMachine.id]: remoteMachine,
            },
            machineDisplayById: {
                [activeMachine.id]: {
                    id: activeMachine.id,
                    updatedAt: activeMachine.updatedAt,
                    active: activeMachine.active,
                    activeAt: activeMachine.activeAt,
                    revokedAt: null,
                    metadataVersion: activeMachine.metadataVersion,
                    metadata: { displayName: 'Active' },
                },
                [remoteMachine.id]: {
                    id: remoteMachine.id,
                    updatedAt: remoteMachine.updatedAt,
                    active: remoteMachine.active,
                    activeAt: remoteMachine.activeAt,
                    revokedAt: null,
                    metadataVersion: remoteMachine.metadataVersion,
                    metadata: { displayName: 'Remote' },
                },
            },
            machineListByServerId: {
                server_a: [activeMachine],
            },
            machineListStatusByServerId: {
                server_a: 'idle',
            },
            profile: { id: 'account_a' },
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
