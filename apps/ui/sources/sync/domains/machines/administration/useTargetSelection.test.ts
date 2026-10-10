import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptHomeProfile, type ServerProfile } from '@/sync/domains/server/serverProfiles';

type TestMachine = {
    id: string;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    revokedAt: number | null;
    replacedByMachineId?: string | null;
    metadataVersion: number;
    metadata: null;
};

type TestStoreState = {
    isDataReady: boolean;
    machines: Record<string, TestMachine>;
    machineListByServerId: Record<string, TestMachine[]>;
    machineListStatusByServerId: Record<string, 'idle' | 'loading' | 'signedOut' | 'error'>;
    settings: {
        machineAdministrationTargetsLocalV1: Record<string, { serverIdentityId: string; machineId: string }>;
    };
};

const runtime = vi.hoisted(() => ({
    activeServerId: 'local-a',
    state: {} as unknown as TestStoreState,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    storage: { getState: () => runtime.state },
}));

vi.mock('@/sync/domains/state/warmCachePersistence', () => ({
    loadMachineDisplayWarmCacheEntries: () => ({}),
}));

vi.mock('@/sync/domains/machines/useMachineInventorySnapshots', () => ({
    useAllProfileMachineInventorySnapshots: () => [],
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: runtime.activeServerId, serverUrl: '', generation: 1 }),
}));

let profileB: ServerProfile;
beforeEach(async () => {
    const url = 'https://administration-inventory-owner.example.test';
    profileB = await adoptHomeProfile({ descriptor: {
        v: 1, homeServerIdentityId: 'srv_server_b', canonicalServerUrl: url,
        revision: 1, endpoints: [{ kind: 'https', url }],
    }, source: 'manual' });
    expect(profileB.id).not.toBe('srv_server_b');
});

vi.mock('@/sync/store/hooks', () => ({
    useIsDataReady: () => false,
    useMachineListStatusByServerId: () => ({}),
    useMachineRecordListsByServerId: () => ({}),
    useMachineRecordValues: () => [],
    useProfile: () => ({ id: 'account-1' }),
    useActiveServerAccountScope: () => ({ serverId: runtime.activeServerId, accountId: 'account-1' }),
    useSetting: () => ({}),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: runtime.activeServerId, serverUrl: '', generation: 1 }),
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 1,
}));

function machine(id: string, active: boolean): TestMachine {
    return {
        id,
        createdAt: 1,
        updatedAt: 100,
        active,
        activeAt: active ? Date.now() : 0,
        revokedAt: null,
        metadataVersion: 1,
        metadata: null,
    };
}

describe('machine administration selection revision', () => {
    it('advances monotonically across A-to-B-to-A', async () => {
        const { advanceMachineAdministrationSelectionRevision } = await import('./useTargetSelection');
        const targetA = { serverIdentityId: 'server-a', machineId: 'machine-a' };
        const targetB = { serverIdentityId: 'server-b', machineId: 'machine-b' };
        const initial = { selectionKey: 'relay', target: targetA, revision: 0 };
        const selectedB = advanceMachineAdministrationSelectionRevision(initial, 'relay', targetB);
        const selectedAAgain = advanceMachineAdministrationSelectionRevision(selectedB, 'relay', targetA);

        expect(selectedB.revision).toBe(1);
        expect(selectedAAgain.revision).toBe(2);
    });
});

describe('resolveFreshMachineAdministrationExecutionTarget', () => {
    beforeEach(() => {
        runtime.activeServerId = 'local-a';
        runtime.state = {
            isDataReady: true,
            machines: { duplicate: machine('machine-b', true) },
            machineListByServerId: {
                'srv_server_b': [machine('machine-b', true)],
            },
            machineListStatusByServerId: { 'srv_server_b': 'idle' },
            settings: {
                machineAdministrationTargetsLocalV1: {},
            },
        };
    });

    it('resolves only the exact fresh non-active server row', async () => {
        const { resolveFreshMachineAdministrationExecutionTarget } = await import('./useTargetSelection');

        const result = resolveFreshMachineAdministrationExecutionTarget({
            serverIdentityId: 'srv_server_b',
            machineId: 'machine-b',
        });

        expect(result).toEqual(expect.objectContaining({
            kind: 'resolved',
            serverId: profileB.id,
            machine: runtime.state.machineListByServerId['srv_server_b'][0],
        }));
    });

    it('fails closed when the exact row is stale, offline, or replaced', async () => {
        const { resolveFreshMachineAdministrationExecutionTarget } = await import('./useTargetSelection');
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-b' };

        runtime.state.machineListStatusByServerId['srv_server_b'] = 'error';
        expect(resolveFreshMachineAdministrationExecutionTarget(target)).toBeNull();

        runtime.state.machineListStatusByServerId['srv_server_b'] = 'idle';
        runtime.state.machineListByServerId['srv_server_b'][0].active = false;
        runtime.state.machineListByServerId['srv_server_b'][0].activeAt = 0;
        expect(resolveFreshMachineAdministrationExecutionTarget(target)).toBeNull();

        runtime.state.machineListByServerId['srv_server_b'][0] = {
            ...machine('machine-b', true),
            replacedByMachineId: 'machine-c',
        };
        expect(resolveFreshMachineAdministrationExecutionTarget(target)).toBeNull();
    });

    it('does not revive a stale scoped row when the active inventory is authoritatively empty', async () => {
        const { resolveFreshMachineAdministrationExecutionTarget } = await import('./useTargetSelection');
        runtime.activeServerId = profileB.id;
        runtime.state.machines = {};
        runtime.state.machineListByServerId['srv_server_b'] = [machine('machine-b', true)];
        runtime.state.machineListStatusByServerId['srv_server_b'] = 'error';

        expect(resolveFreshMachineAdministrationExecutionTarget({
            serverIdentityId: 'srv_server_b',
            machineId: 'machine-b',
        })).toBeNull();
    });
});

describe('doesMachineAdministrationTargetMatchActiveAccount', () => {
    it('uses real profile equivalence for portable and device-local identifiers', async () => {
        const { doesMachineAdministrationTargetMatchActiveAccount } = await import('./useTargetSelection');
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-b' };

        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: profileB.id,
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'srv_server_b',
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'local-a',
        })).toBe(false);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target: null,
            activeAccountServerId: profileB.id,
        })).toBe(false);
    });
});
