import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from '../../domains/server/serverProfiles';

const mmkvStore = new Map<string, string>();
const serverProfileMockState = vi.hoisted(() => ({
    profiles: [] as ServerProfile[],
}));

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
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mmkvStore.clear();
    serverProfileMockState.profiles = [];
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

function createServerProfile(params: Readonly<{
    id: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
}>): ServerProfile {
    return {
        id: params.id,
        name: params.id,
        serverUrl: `http://${params.id}.local`,
        serverIdentityId: params.serverIdentityId ?? null,
        legacyServerIds: params.legacyServerIds ?? [],
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
    };
}

function mockServerProfiles(profiles: readonly ServerProfile[]): void {
    serverProfileMockState.profiles = profiles.slice();
    vi.doMock('../../domains/server/serverProfiles', async (importOriginal) => {
        const { createServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
        return createServerProfilesModuleMock({
            importOriginal,
            overrides: {
                listServerProfiles: () => serverProfileMockState.profiles,
            },
        });
    });
}

function mockMachineDomainBoundaries(): void {
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server_a', serverUrl: 'http://server.local', generation: 0 }),
    }));
    mockServerProfiles([createServerProfile({ id: 'server_a' })]);
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveMachineDisplayWarmCacheEntries: vi.fn(),
        readPersistedMachineDisplayWarmCacheEntries: vi.fn(() => undefined),
    }));
}

function mockMachineDomainBoundariesForActiveServer(
    serverId: string,
    profiles: readonly ServerProfile[] = [
        createServerProfile({ id: 'server_a' }),
        createServerProfile({ id: 'server_b' }),
    ],
): void {
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId, serverUrl: `http://${serverId}.local`, generation: 0 }),
    }));
    mockServerProfiles(profiles);
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveMachineDisplayWarmCacheEntries: vi.fn(),
        readPersistedMachineDisplayWarmCacheEntries: vi.fn(() => undefined),
    }));
}

describe('machines domain: sessionListViewData rebuild gating', () => {
    it('does not let a late snapshot regress a newer machine activity update', async () => {
        vi.useFakeTimers();
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');
        const initialState = {
            sessions: {},
            settings: { groupInactiveSessionsByProject: false },
            sessionListRenderables: {},
            sessionListViewData: [],
            sessionListViewDataByServerId: {},
            machines: {},
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_a' },
        };
        const { get, domain } = createHarness(createMachinesDomain, initialState);
        const machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 200,
            active: true,
            activeAt: 200,
            revokedAt: null,
            metadata: { displayName: 'Mac' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };

        domain.applyMachines([machine] as any, true, { sourceServerId: 'server_a' });
        domain.replaceMachineDisplays([
            { ...get().machineDisplayById.m1, updatedAt: 300, active: false, activeAt: 100 },
        ], { sourceServerId: 'server_a' });

        expect(get().machineDisplayById.m1).toMatchObject({ active: true, activeAt: 200 });

        domain.applyMachines([{
            ...machine,
            updatedAt: 300,
            active: false,
            activeAt: 100,
            metadataVersion: 2,
            metadata: { displayName: 'Renamed Mac' },
        }] as any, true, { sourceServerId: 'server_a' });

        expect(get().machines.m1).toMatchObject({
            active: true,
            activeAt: 200,
            metadataVersion: 2,
            metadata: { displayName: 'Renamed Mac' },
        });
        expect(get().machineDisplayById.m1).toMatchObject({ active: true, activeAt: 200 });
        expect(get().machineListByServerId.server_a[0]).toMatchObject({ active: true, activeAt: 200 });

        domain.applyMachines([{
            ...machine,
            updatedAt: 400,
            active: false,
            activeAt: 400,
        }] as any, false, { sourceServerId: 'server_a' });

        expect(get().machines.m1).toMatchObject({ active: false, activeAt: 400 });
        expect(get().machineDisplayById.m1).toMatchObject({ active: false, activeAt: 400 });
        expect(get().machineListByServerId.server_a[0]).toMatchObject({ active: false, activeAt: 400 });
    });

    it('preserves machine records and coalesces warm-cache writes when incoming machines do not change', async () => {
        vi.useFakeTimers();
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');
        const { saveMachineDisplayWarmCacheEntries } = await import('../../domains/state/warmCachePersistence');
        const saveWarmCache = vi.mocked(saveMachineDisplayWarmCacheEntries);

        const machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            revokedAt: null,
            metadata: { displayName: 'Mac' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const display = {
            id: 'm1',
            updatedAt: 1,
            active: true,
            activeAt: 1,
            revokedAt: null,
            metadataVersion: 1,
            metadata: { displayName: 'Mac' },
        };
        const machinesRecord = { m1: machine };
        const displaysRecord = { m1: display };
        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
            },
            sessionListRenderables: {},
            sessionListViewData: [],
            sessionListViewDataByServerId: {},
            machines: machinesRecord,
            machineDisplayById: displaysRecord,
            machineListByServerId: { server_a: [machine] },
            machineListStatusByServerId: { server_a: 'idle' },
            profile: { id: 'account_a' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([{ ...machine } as any]);

        expect(get().machines).toBe(machinesRecord);
        expect(get().machineDisplayById).toBe(displaysRecord);
        expect(saveWarmCache).not.toHaveBeenCalled();

        domain.applyMachines([{ ...machine, activeAt: 2 } as any]);
        domain.applyMachines([{ ...machine, activeAt: 3 } as any]);

        expect(saveWarmCache).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_000);

        expect(saveWarmCache).toHaveBeenCalledTimes(1);
        expect(saveWarmCache.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
            m1: expect.objectContaining({ activeAt: 3 }),
        }));
    });

    it('keeps sessionListViewData reference stable for machine activity-only updates', async () => {
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

    it('rebuilds sessionListViewData with replacement context when machine records change', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const oldMachine = {
            id: 'm-old',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            revokedAt: null,
            replacedByMachineId: 'm-new',
            replacedAt: 10,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            metadata: { displayName: 'Old Mac', host: 'old.local', homeDir: '/Users/test' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const newMachine = {
            id: 'm-new',
            seq: 2,
            createdAt: 2,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            revokedAt: null,
            metadata: { displayName: 'New Mac', host: 'new.local', homeDir: '/Users/test' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const initialState = {
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    metadata: { machineId: 'm-old', path: '/Users/test/old-repo', homeDir: '/Users/test', host: 'old.local' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'offline',
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
                    active: false,
                    activeAt: 1,
                    archivedAt: null,
                    metadataVersion: 1,
                    agentStateVersion: 0,
                    metadata: { machineId: 'm-old', path: '/Users/test/old-repo', homeDir: '/Users/test', host: 'old.local' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'offline',
                },
            },
            sessionListViewData: null,
            sessionListViewDataByServerId: {},
            machines: { 'm-old': oldMachine },
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            getProjectForSession: (sessionId: string) =>
                sessionId === 's1' ? { key: { machineId: 'm-old', path: '/Users/test/old-repo' } } : null,
            profile: { id: 'account_a' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([oldMachine, newMachine] as any, true);

        expect(JSON.stringify(get().sessionListViewData)).toContain('m-new');
    });

    it('stores source-scoped machine snapshots without replacing the active server projection', async () => {
        mockMachineDomainBoundariesForActiveServer('server_b');

        const { createMachinesDomain } = await import('./machines');

        const activeMachine = {
            id: 'm-b',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            revokedAt: null,
            metadata: { displayName: 'Server B Machine' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };
        const staleMachine = {
            id: 'm-a',
            seq: 2,
            createdAt: 2,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            revokedAt: null,
            metadata: { displayName: 'Server A Machine' },
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
            machines: { 'm-b': activeMachine },
            machineDisplayById: {
                'm-b': {
                    id: 'm-b',
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    revokedAt: null,
                    metadataVersion: 1,
                    metadata: { displayName: 'Server B Machine' },
                },
            },
            machineListByServerId: {
                server_b: [activeMachine],
            },
            machineListStatusByServerId: {
                server_b: 'idle',
            },
            profile: { id: 'account_b' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([staleMachine] as any, true, { sourceServerId: 'server_a' });

        expect(Object.keys(get().machines)).toEqual(['m-b']);
        expect(get().machineListByServerId.server_b?.map((machine: any) => machine.id)).toEqual(['m-b']);
        expect(get().machineListByServerId.server_a?.map((machine: any) => machine.id)).toEqual(['m-a']);
        expect(get().machineListStatusByServerId.server_a).toBe('idle');
    });

    it('updates the active projection for equivalent profile and legacy server identifiers', async () => {
        mockMachineDomainBoundariesForActiveServer('identity_b', [
            createServerProfile({
                id: 'profile_b',
                serverIdentityId: 'identity_b',
                legacyServerIds: ['legacy_b'],
            }),
        ]);

        const { createMachinesDomain } = await import('./machines');

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
            machines: {},
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'account_b' },
        };

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm-profile',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                revokedAt: null,
                metadata: { displayName: 'Profile Machine' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ], true, { sourceServerId: 'profile_b' });

        expect(Object.keys(get().machines)).toEqual(['m-profile']);
        expect(get().machineListByServerId.profile_b?.map((machine: any) => machine.id)).toEqual(['m-profile']);

        domain.applyMachines([
            {
                id: 'm-legacy',
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                revokedAt: null,
                metadata: { displayName: 'Legacy Machine' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            } as any,
        ], true, { sourceServerId: 'legacy_b' });

        expect(Object.keys(get().machines)).toEqual(['m-legacy']);
        expect(get().machineListByServerId.legacy_b?.map((machine: any) => machine.id)).toEqual(['m-legacy']);
    });

    it('rebuilds sessionListViewData when project header machine display changes', async () => {
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
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'old-mbp' },
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
                    metadata: { machineId: 'm2', path: '/home/u/repo', homeDir: '/home/u', host: 'mbp' },
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
                    metadata: { machineId: 'm-stale', path: '/home/u/repo', homeDir: '/home/u', host: 'old-mbp' },
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
                    metadata: { machineId: 'm2', path: '/home/u/repo', homeDir: '/home/u', host: 'mbp' },
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
