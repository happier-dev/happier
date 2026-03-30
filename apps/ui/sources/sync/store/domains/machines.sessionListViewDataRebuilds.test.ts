import { afterEach, describe, expect, it, vi } from 'vitest';

const mmkvStore = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }

        set(key: string, value: string) {
            mmkvStore.set(key, value);
        }

        delete(key: string) {
            mmkvStore.delete(key);
        }
    }

    return { MMKV };
});

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mmkvStore.clear();
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
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server_a', serverUrl: 'http://server.local', generation: 0 }),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveMachineDisplayWarmCacheEntries: vi.fn(),
    }));
}

describe('machines domain: sessionListViewData rebuild gating', () => {
    it('keeps sessionListViewData reference stable for machine activity-only updates', async () => {
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
    });

    it('rebuilds sessionListViewData when project header machine display changes', async () => {
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
    });

    it('rebuilds sessionListViewData when a host-group project header subtitle changes', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialList = [{ type: 'initial' }];
        const initialState = {
            sessions: {},
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
                    metadata: { machineId: 'm1', host: 'host.local', path: '/home/u/repo', homeDir: '/home/u' },
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
                    metadata: { displayName: 'Host A', host: 'host.local' },
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
                    metadata: { displayName: 'Host A', host: 'host.local' },
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
                metadata: { displayName: 'Host A (renamed)', host: 'host.local' },
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initialList);
    });

    it('does not rebuild sessionListViewData when a non-referenced machine subtitle changes', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialList = [{ type: 'initial' }];
        const initialState = {
            sessions: {},
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
                    metadata: { machineId: 'm1', host: 'host.local', path: '/home/u/repo', homeDir: '/home/u' },
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
                    metadata: { displayName: 'Host A', host: 'host.local' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
                m2: {
                    id: 'm2',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { displayName: 'Other', host: 'other.local' },
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
                    metadata: { displayName: 'Host A', host: 'host.local' },
                },
                m2: {
                    id: 'm2',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Other', host: 'other.local' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm2',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'Other (updated)', host: 'other.local' },
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).toBe(initialList);
    });

    it('rebuilds sessionListViewData when project-group host headers depend on a different machine than the session machineId', async () => {
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
                    metadata: { displayName: 'Personal', host: 'mbp' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                },
                m2: {
                    id: 'm2',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: { displayName: 'Work', host: 'mbp' },
                    metadataVersion: 2,
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
                    metadata: { displayName: 'Personal', host: 'mbp' },
                },
                m2: {
                    id: 'm2',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 2,
                    metadata: { displayName: 'Work', host: 'mbp' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm2',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: { displayName: 'Work (updated)', host: 'mbp' },
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ]);

        expect(get().sessionListViewData).not.toBe(initialList);
    });

    it('updates active server machine cache without leaking machines from other scopes', async () => {
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
