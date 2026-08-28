import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        machineAdministrationSelectionsV1: {
            targetsByKey: Record<string, { serverIdentityId: string; machineId: string }>;
            pluginExecutionOriginsByPluginId: Record<string, never>;
        };
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

const profileB = {
    id: 'local-b',
    name: 'Server B',
    serverUrl: 'https://b.example.test',
    serverIdentityId: 'srv_server_b',
    legacyServerIds: ['legacy-b'],
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
};

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [profileB],
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
        const profileByIdentifier: Readonly<Record<string, string>> = {
            'local-a': 'local-a',
            'local-b': 'local-b',
            'legacy-b': 'local-b',
            srv_server_b: 'local-b',
        };
        return profileByIdentifier[String(left)] === profileByIdentifier[String(right)];
    },
    resolveServerProfileForPortableIdentity: (serverIdentityId: string) => (
        serverIdentityId === 'srv_server_b'
            ? { kind: 'resolved', serverIdentityId, profile: profileB }
            : { kind: 'missing', serverIdentityId }
    ),
}));

vi.mock('@/sync/store/hooks', () => ({
    useIsDataReady: () => false,
    useMachineListStatusByServerId: () => ({}),
    useMachineRecordListsByServerId: () => ({}),
    useMachineRecordValues: () => [],
    useProfile: () => ({ id: 'account-1' }),
    useActiveServerAccountScope: () => ({ serverId: runtime.activeServerId, accountId: 'account-1' }),
    useSettingMutable: () => [{ targetsByKey: {}, pluginExecutionOriginsByPluginId: {} }, vi.fn()],
    useSetting: () => ({ targetsByKey: {}, pluginExecutionOriginsByPluginId: {} }),
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
                machineAdministrationSelectionsV1: {
                    targetsByKey: {},
                    pluginExecutionOriginsByPluginId: {},
                },
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
            serverId: 'local-b',
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
        runtime.activeServerId = 'local-b';
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
    it('uses canonical profile equivalence for portable, local, and legacy identifiers', async () => {
        const { doesMachineAdministrationTargetMatchActiveAccount } = await import('./useTargetSelection');
        const target = { serverIdentityId: 'srv_server_b', machineId: 'machine-b' };

        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'local-b',
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'legacy-b',
        })).toBe(true);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target,
            activeAccountServerId: 'local-a',
        })).toBe(false);
        expect(doesMachineAdministrationTargetMatchActiveAccount({
            target: null,
            activeAccountServerId: 'local-b',
        })).toBe(false);
    });
});
