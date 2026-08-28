import { describe, expect, it, vi, afterEach } from 'vitest';

import { createServerProfilesModuleMock } from '@/dev/testkit/mocks/serverProfiles';
import type { Machine, MachineMetadata } from '../../domains/state/storageTypes';

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString() {
            return undefined;
        }

        set() {}

        delete() {}
    }

    return { MMKV };
});

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

const BASE_MACHINE_METADATA = {
    host: 'host.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0',
    happyHomeDir: '/home/u/.happy',
    homeDir: '/home/u',
    displayName: 'Dev box',
} as MachineMetadata;

function makeMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'm-1',
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 10,
        metadataVersion: 1,
        metadata: BASE_MACHINE_METADATA,
        ...(overrides ?? {}),
    } as Machine;
}

function createHarness(createMachinesDomain: any) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        machines: {},
        profile: { id: 'account-1' },
        settings: {
            groupInactiveSessionsByProject: false,
            sessionListActiveGroupingV1: undefined,
            sessionListInactiveGroupingV1: undefined,
            sessionListSectionModeV1: undefined,
        },
    };
    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };
    const domain = createMachinesDomain({ get, set } as any);
    state = { ...state, ...domain };
    return { get, domain };
}

async function loadMachinesDomain() {
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: 'server_a', serverUrl: 'http://server.local', generation: 0 }),
    }));
    vi.doMock('../../domains/server/serverProfiles', () => createServerProfilesModuleMock({
        profiles: [{ id: 'server_a', name: 'server_a', serverUrl: 'http://server_a.local' }],
    }));
    vi.doMock('../../domains/transfers/runtime/transferRouteCache', () => ({
        invalidateCachedTransferRoutesForMachine: vi.fn(),
    }));
    const { createMachinesDomain } = await import('./machines');
    const revision = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
    return { createMachinesDomain, revision };
}

describe('machines domain: contribution projection currentness', () => {
    it('advances the projection revision for exactly the scopes whose daemon state advanced', async () => {
        const { createMachinesDomain, revision } = await loadMachinesDomain();
        const { domain } = createHarness(createMachinesDomain);
        const scope = { machineId: 'm-1', serverId: 'server_a' } as const;
        const otherScope = { machineId: 'm-2', serverId: 'server_a' } as const;

        domain.applyMachines([makeMachine({ daemonStateVersion: 4 })], true, { sourceServerId: 'server_a' });
        const afterFirst = revision.getMachineContributionRegistryProjectionRevision(scope);
        const otherAfterFirst = revision.getMachineContributionRegistryProjectionRevision(otherScope);

        // A replaced or restarted daemon is a different projection endpoint, so
        // every consumer of this machine's projection must re-describe.
        domain.applyMachines([makeMachine({ daemonStateVersion: 5, updatedAt: 20 })], false, {
            sourceServerId: 'server_a',
        });

        expect(revision.getMachineContributionRegistryProjectionRevision(scope)).toBe(afterFirst + 1);
        expect(revision.getMachineContributionRegistryProjectionRevision(otherScope)).toBe(otherAfterFirst);
    });

    it('leaves the projection revision alone for an equal or stale daemon state', async () => {
        const { createMachinesDomain, revision } = await loadMachinesDomain();
        const { domain } = createHarness(createMachinesDomain);
        const scope = { machineId: 'm-1', serverId: 'server_a' } as const;

        domain.applyMachines([makeMachine({ daemonStateVersion: 5 })], true, { sourceServerId: 'server_a' });
        const baseline = revision.getMachineContributionRegistryProjectionRevision(scope);

        domain.applyMachines([makeMachine({ daemonStateVersion: 5, updatedAt: 21 })], false, {
            sourceServerId: 'server_a',
        });
        domain.applyMachines([makeMachine({ daemonStateVersion: 4, updatedAt: 22 })], false, {
            sourceServerId: 'server_a',
        });

        expect(revision.getMachineContributionRegistryProjectionRevision(scope)).toBe(baseline);
    });
});

describe('machines domain: presence currentness', () => {
    it('does not let a late snapshot regress a newer machine activity update', async () => {
        const { createMachinesDomain } = await loadMachinesDomain();
        const { get, domain } = createHarness(createMachinesDomain);

        domain.applyMachines([
            makeMachine({ active: true, activeAt: 200, updatedAt: 200 }),
        ], true, { sourceServerId: 'server_a' });

        domain.replaceMachineDisplays([
            makeMachine({ active: false, activeAt: 100, updatedAt: 300 }),
        ], { sourceServerId: 'server_a' });

        expect(get().machineDisplayById['m-1']).toMatchObject({ active: true, activeAt: 200 });

        domain.applyMachines([
            makeMachine({
                active: false,
                activeAt: 100,
                updatedAt: 300,
                metadataVersion: 2,
                metadata: { ...BASE_MACHINE_METADATA, displayName: 'Renamed dev box' },
            }),
        ], true, { sourceServerId: 'server_a' });

        expect(get().machines['m-1']).toMatchObject({
            active: true,
            activeAt: 200,
            metadataVersion: 2,
            metadata: { displayName: 'Renamed dev box' },
        });
        expect(get().machineDisplayById['m-1']).toMatchObject({ active: true, activeAt: 200 });
        expect(get().machineListByServerId.server_a[0]).toMatchObject({ active: true, activeAt: 200 });

        domain.applyMachines([
            makeMachine({ active: false, activeAt: 400, updatedAt: 400 }),
        ], false, { sourceServerId: 'server_a' });

        expect(get().machines['m-1']).toMatchObject({ active: false, activeAt: 400 });
        expect(get().machineDisplayById['m-1']).toMatchObject({ active: false, activeAt: 400 });
        expect(get().machineListByServerId.server_a[0]).toMatchObject({ active: false, activeAt: 400 });
    });
});
