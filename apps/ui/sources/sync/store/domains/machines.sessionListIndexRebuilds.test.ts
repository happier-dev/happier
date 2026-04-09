import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveMachineSessionListIndexImpact } from './machines';
import { resolveMachineSessionListIndexImpact as resolveMachineSessionIndexImpactFromHelper } from './machineSessionListIndexImpact';
import type { MachineMetadata } from '../../domains/state/storageTypes';

const { mmkvStore, invalidateCachedTransferRoutesForMachineSpy } = vi.hoisted(() => ({
    mmkvStore: new Map<string, string>(),
    invalidateCachedTransferRoutesForMachineSpy: vi.fn(),
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
    vi.resetModules();
    vi.clearAllMocks();
    mmkvStore.clear();
    invalidateCachedTransferRoutesForMachineSpy.mockReset();
});

const ONLINE = 'online' as const;

const BASE_MACHINE_METADATA: MachineMetadata = {
    host: 'host.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0',
    happyHomeDir: '/home/u/.happy',
    homeDir: '/home/u',
};

function makeMachineMetadata(partial?: Partial<MachineMetadata>): MachineMetadata {
    return {
        ...BASE_MACHINE_METADATA,
        ...(partial ?? {}),
    };
}

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
    vi.doMock('../../domains/transfers/runtime/transferRouteCache', () => ({
        invalidateCachedTransferRoutesForMachine: (...args: unknown[]) => invalidateCachedTransferRoutesForMachineSpy(...args),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveMachineDisplayWarmCacheEntries: vi.fn(),
    }));
}

async function seedActiveServerSessionListIndex(initialState: any) {
    const { buildActiveServerSessionListIndex } = await import('../sessionListIndex/buildSessionListIndexWithServerScope');
    const seededIndex = buildActiveServerSessionListIndex({
        sessions: initialState.sessionListRenderables,
        sessionRecords: initialState.sessions,
        machines: initialState.machineDisplayById,
        machineRecords: initialState.machines,
        groupInactiveSessionsByProject: initialState.settings.groupInactiveSessionsByProject === true,
        activeGroupingV1: initialState.settings.sessionListActiveGroupingV1,
        inactiveGroupingV1: initialState.settings.sessionListInactiveGroupingV1,
        getProjectForSession: initialState.getProjectForSession,
        previousIndex: null,
    });
    initialState.sessionListIndexByServerId = {
        ...initialState.sessionListIndexByServerId,
        server_a: seededIndex,
    };
    return seededIndex;
}

describe('machines domain: sessionListIndex rebuild gating', () => {
    it('exports the machine session list index impact resolver from the domain entrypoint', () => {
        expect(resolveMachineSessionListIndexImpact).toBe(resolveMachineSessionIndexImpactFromHelper);
    });

    it('invalidates cached transfer routes when a machine daemonStateVersion advances', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'date' as const,
                sessionListInactiveGroupingV1: 'date' as const,
            },
            sessionListRenderables: {},
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: null,
                    metadataVersion: 0,
                    daemonState: { transfer: { supported: { import: true, export: true } } },
                    daemonStateVersion: 1,
                },
            },
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'profile-1' },
            getProjectForSession: () => null,
        };

        const { domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 0,
                daemonState: { transfer: { supported: { import: true, export: true } } },
                daemonStateVersion: 2,
            },
        ]);

        expect(invalidateCachedTransferRoutesForMachineSpy).toHaveBeenCalledWith({
            serverId: 'server_a',
            remoteMachineId: 'm1',
        });
    });

    it('invalidates cached transfer routes for the machine owning server when that server is not active', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'date' as const,
                sessionListInactiveGroupingV1: 'date' as const,
            },
            sessionListRenderables: {},
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                'm-remote': {
                    id: 'm-remote',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: null,
                    metadataVersion: 0,
                    daemonState: { transfer: { supported: { import: true, export: true } } },
                    daemonStateVersion: 1,
                },
            },
            machineDisplayById: {},
            machineListByServerId: {
                server_b: [
                    {
                        id: 'm-remote',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        active: true,
                        activeAt: 1,
                        metadata: null,
                        metadataVersion: 0,
                        daemonState: { transfer: { supported: { import: true, export: true } } },
                        daemonStateVersion: 1,
                    },
                ],
            },
            machineListStatusByServerId: {
                server_b: 'idle',
            },
            profile: { id: 'profile-1' },
            getProjectForSession: () => null,
        };

        const { domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm-remote',
                seq: 2,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 0,
                daemonState: { transfer: { supported: { import: true, export: true } } },
                daemonStateVersion: 2,
            },
        ]);

        expect(invalidateCachedTransferRoutesForMachineSpy).toHaveBeenCalledWith({
            serverId: 'server_b',
            remoteMachineId: 'm-remote',
        });
        expect(invalidateCachedTransferRoutesForMachineSpy).not.toHaveBeenCalledWith({
            serverId: 'server_a',
            remoteMachineId: 'm-remote',
        });
    });

    it('keeps the active-server sessionListIndex reference stable for machine activity-only updates', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'host-1' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'project' as const,
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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'host-1' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: {
                        host: 'host-1',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/home/u/.happy',
                        homeDir: '/home/u',
                        displayName: 'Mac',
                    },
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
                    metadata: { displayName: 'Mac', host: 'host-1', homeDir: '/home/u' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            getProjectForSession: () => null,
            profile: { id: 'account_a' },
        };

        const seededIndex = await seedActiveServerSessionListIndex(initialState);

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: initialState.machines.m1.metadata,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(get().sessionListIndexByServerId['server_a']).toBe(seededIndex);
    });

    it('tracks the active-server sessionListIndex in sessionListIndexByServerId when machines rebuild the session list', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'date' as const,
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
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            machines: {},
            machineDisplayById: {},
            machineListByServerId: {},
            machineListStatusByServerId: {},
            profile: { id: 'profile-1' },
            getProjectForSession: () => null,
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
                metadata: {
                    host: 'host-1',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    happyHomeDir: '/home/u/.happy',
                    homeDir: '/home/u',
                },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(Array.isArray(get().sessionListIndexByServerId['server_a'])).toBe(true);
        expect(get().sessionListIndexByServerId['server_a']?.length ?? 0).toBeGreaterThan(0);
    });

    it('rebuilds the active-server sessionListIndex when project header machine display changes', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'host-1' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'project' as const,
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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'host-1' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: {
                        host: 'host-1',
                        platform: 'darwin',
                        happyCliVersion: '0.0.0',
                        happyHomeDir: '/home/u/.happy',
                        homeDir: '/home/u',
                        displayName: 'Mac',
                    },
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
                    metadata: { displayName: 'Mac', host: 'host-1', homeDir: '/home/u' },
                },
            },
            machineListByServerId: {},
            machineListStatusByServerId: {},
            getProjectForSession: () => null,
            profile: { id: 'account_a' },
        };

        const seededIndex = await seedActiveServerSessionListIndex(initialState);

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: makeMachineMetadata({ displayName: 'New name', host: 'host-1', homeDir: '/home/u' }),
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(get().sessionListIndexByServerId['server_a']).not.toBe(seededIndex);
    });

    it('rebuilds the active-server sessionListIndex when a host-group project header subtitle changes', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'project' as const,
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
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: makeMachineMetadata({ displayName: 'Host A', host: 'host.local' }),
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
            getProjectForSession: () => null,
            profile: { id: 'account_a' },
        };

        const seededIndex = await seedActiveServerSessionListIndex(initialState);

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm1',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: makeMachineMetadata({ displayName: 'Host A (renamed)', host: 'host.local' }),
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(get().sessionListIndexByServerId['server_a']).not.toBe(seededIndex);
    });

    it('does not rebuild the active-server sessionListIndex when a non-referenced machine subtitle changes', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'project' as const,
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
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: makeMachineMetadata({ displayName: 'Host A', host: 'host.local' }),
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
                    metadata: makeMachineMetadata({ displayName: 'Other', host: 'other.local' }),
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
            getProjectForSession: () => null,
            profile: { id: 'account_a' },
        };

        const seededIndex = await seedActiveServerSessionListIndex(initialState);

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm2',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: makeMachineMetadata({ displayName: 'Other (updated)', host: 'other.local' }),
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(get().sessionListIndexByServerId['server_a']).toBe(seededIndex);
    });

    it('rebuilds the active-server sessionListIndex when project-group host headers depend on a different machine than the session machineId', async () => {
        mockMachineDomainBoundaries();

        const { createMachinesDomain } = await import('./machines');

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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'mbp' },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            settings: {
                groupInactiveSessionsByProject: true,
                sessionListActiveGroupingV1: 'project' as const,
                sessionListInactiveGroupingV1: 'project' as const,
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
                    metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u', host: 'mbp' },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online' as const,
                },
            },
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
            machines: {
                m1: {
                    id: 'm1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: makeMachineMetadata({ displayName: 'Personal', host: 'mbp' }),
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
                    metadata: makeMachineMetadata({ displayName: 'Work', host: 'mbp' }),
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
            getProjectForSession: () => null,
            profile: { id: 'account_a' },
        };

        const seededIndex = await seedActiveServerSessionListIndex(initialState);

        const { get, domain } = createHarness(createMachinesDomain, initialState);

        domain.applyMachines([
            {
                id: 'm2',
                seq: 1,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: makeMachineMetadata({ displayName: 'Work (updated)', host: 'mbp' }),
                metadataVersion: 2,
                daemonState: null,
                daemonStateVersion: 0,
            },
        ]);

        expect(get().sessionListIndexByServerId['server_a']).not.toBe(seededIndex);
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
            metadata: makeMachineMetadata({ displayName: 'Active' }),
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
            metadata: makeMachineMetadata({ displayName: 'Remote' }),
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const initialState = {
            sessions: {},
            settings: {
                groupInactiveSessionsByProject: false,
                sessionListActiveGroupingV1: 'date' as const,
                sessionListInactiveGroupingV1: 'date' as const,
            },
            sessionListRenderables: {},
            sessionListIndexByServerId: {},
            sessionListRowStateByServerId: {},
            concurrentSessionListCacheByServerId: {},
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
            },
        ]);

        const activeServerCache = get().machineListByServerId.server_a ?? [];
        expect(activeServerCache.map((machine: any) => machine.id)).toEqual(['m-active']);
    });
});
