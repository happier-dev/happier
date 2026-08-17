import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerProfilesModuleMock } from '@/dev/testkit/mocks/serverProfiles';
import type { Machine, MachineMetadata } from '../../domains/state/storageTypes';

const { mmkvStore } = vi.hoisted(() => ({
    mmkvStore: new Map<string, string>(),
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
});

const MACHINE_WARM_CACHE_KEY = 'machine-display-warm-cache-v1:server_a:account-1';

const BASE_MACHINE_METADATA: MachineMetadata = {
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

function mockMachineDomainBoundaries(options?: Readonly<{
    activeServerId?: string;
    profiles?: ReadonlyArray<Readonly<{
        id: string;
        name?: string;
        serverUrl: string;
        serverIdentityId?: string | null;
        legacyServerIds?: readonly string[];
    }>>;
}>): void {
    const activeServerId = options?.activeServerId ?? 'server_a';
    const profiles = options?.profiles ?? [{ id: 'server_a', name: 'server_a', serverUrl: 'http://server_a.local' }];
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({ serverId: activeServerId, serverUrl: 'http://server.local', generation: 0 }),
    }));
    vi.doMock('../../domains/server/serverProfiles', () => createServerProfilesModuleMock({
        profiles,
    }));
    vi.doMock('../../domains/transfers/runtime/transferRouteCache', () => ({
        invalidateCachedTransferRoutesForMachine: vi.fn(),
    }));
}

async function flushWarmCacheSave(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
}

function readPersistedMachineEntry(machineId: string): Record<string, unknown> | undefined {
    const raw = mmkvStore.get(MACHINE_WARM_CACHE_KEY);
    if (!raw) return undefined;
    return (JSON.parse(raw) as Record<string, Record<string, unknown>>)[machineId];
}

describe('machines domain: warm cache baseline', () => {
    it('preserves the persisted machine display name when a later apply carries no metadata', async () => {
        mockMachineDomainBoundaries();
        const { createMachinesDomain } = await import('./machines');
        const { domain } = createHarness(createMachinesDomain);

        domain.applyMachines([makeMachine()], true, { sourceServerId: 'server_a' });
        await flushWarmCacheSave();
        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Dev box');

        // A machine row whose metadata could not be decrypted this round: the renderable
        // metadata goes null, and only the persisted baseline can keep the display name.
        domain.applyMachines([makeMachine({ metadata: null, updatedAt: 20, activeAt: 20 })], false, {
            sourceServerId: 'server_a',
        });
        await flushWarmCacheSave();

        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Dev box');
        expect(readPersistedMachineEntry('m-1')?.updatedAt).toBe(20);
    });

    it('adopts fresh metadata over the persisted baseline', async () => {
        mockMachineDomainBoundaries();
        const { createMachinesDomain } = await import('./machines');
        const { domain } = createHarness(createMachinesDomain);

        domain.applyMachines([makeMachine()], true, { sourceServerId: 'server_a' });
        await flushWarmCacheSave();

        domain.applyMachines([makeMachine({
            metadata: { ...BASE_MACHINE_METADATA, displayName: 'Renamed box' } as MachineMetadata,
            metadataVersion: 2,
            updatedAt: 30,
        })], false, { sourceServerId: 'server_a' });
        await flushWarmCacheSave();

        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Renamed box');
    });

    it('persists non-active raw machine inventories under the canonical server identity', async () => {
        mockMachineDomainBoundaries({
            activeServerId: 'srv_server_a',
            profiles: [
                {
                    id: 'local-a',
                    serverIdentityId: 'srv_server_a',
                    serverUrl: 'http://server-a.local',
                },
                {
                    id: 'local-b',
                    serverIdentityId: 'srv_server_b',
                    legacyServerIds: ['legacy-b'],
                    serverUrl: 'http://server-b.local',
                },
            ],
        });
        const { createMachinesDomain } = await import('./machines');
        const { domain, get } = createHarness(createMachinesDomain);

        domain.applyMachines([makeMachine({
            id: 'machine-old',
            active: false,
            revokedAt: 40,
            replacedByMachineId: 'machine-new',
            replacedAt: 41,
            replacementReason: 'rotated',
        })], true, { sourceServerId: 'local-b' });
        await flushWarmCacheSave();

        expect(get().machines).toEqual({});
        expect(get().machineListByServerId['local-b']).toHaveLength(1);
        const raw = mmkvStore.get('machine-display-warm-cache-v1:srv_server_b:account-1');
        expect(raw).toBeDefined();
        expect(JSON.parse(raw ?? '{}')).toMatchObject({
            'machine-old': {
                machineId: 'machine-old',
                revokedAt: 40,
                replacedByMachineId: 'machine-new',
                replacedAt: 41,
                replacementReason: 'rotated',
            },
        });
    });
});
