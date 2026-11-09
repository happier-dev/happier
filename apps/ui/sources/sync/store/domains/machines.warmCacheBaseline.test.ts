import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { Machine, MachineMetadata } from '../../domains/state/storageTypes';
import type { StorageState } from '../types';
import type { createMachinesDomain, MachinesDomain } from './machines';

const { mmkvStore, mmkvWrites } = vi.hoisted(() => ({
    mmkvStore: new Map<string, string>(),
    mmkvWrites: [] as string[],
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return mmkvStore.get(key);
        }

        set(key: string, value: string) {
            mmkvWrites.push(key);
            mmkvStore.set(key, value);
        }

        delete(key: string) {
            mmkvStore.delete(key);
        }

        clearAll() {
            mmkvStore.clear();
        }

        getAllKeys() { return [...mmkvStore.keys()]; }
        trim() {}
    }

    return { MMKV };
});

// The native keystore boundary already contains a valid cache key this boot.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => 'ABCDEFGHIJKLMNOP',
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
}));

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mmkvStore.clear();
    mmkvWrites.length = 0;
});

let activeServerId = '';

const BASE_MACHINE_METADATA: MachineMetadata = {
    host: 'host.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0',
    happyHomeDir: '/home/u/.happy',
    homeDir: '/home/u',
    displayName: 'Dev box',
};

function makeMachine(overrides?: Partial<Machine>): Machine {
    return createMachineFixture({
        id: 'm-1',
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 10,
        metadataVersion: 1,
        metadata: BASE_MACHINE_METADATA,
        ...(overrides ?? {}),
    });
}

async function createHarness() {
    await loadMachineDomainAfterBoot();
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const active = await profiles.upsertServerProfile({ serverUrl: 'http://server-a.local' });
    await profiles.setServerProfileIdentityForUrl(active.serverUrl, 'srv_server_a');
    await profiles.setActiveServerId(active.id, { scope: 'device' });
    activeServerId = active.id;
    const { storage } = await import('@/sync/domains/state/storage');
    (await import('../../domains/state/warmCachePersistence')).setWarmCacheAccountScope('account-1');
    storage.setState({
        machines: {}, machineDisplayById: {}, machineListByServerId: {},
        profile: { ...storage.getState().profile, id: 'account-1' },
        profileScope: { serverId: activeServerId, accountId: 'account-1' },
    });
    return { get: storage.getState, domain: storage.getState(), profiles };
}

async function flushWarmCacheSave(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
}

async function loadMachineDomainAfterBoot() {
    const { prepareWarmCacheStorage } = await import('../../domains/state/warmCachePersistence');
    await prepareWarmCacheStorage();
    return await import('./machines');
}

function readPersistedMachineEntry(machineId: string): Record<string, unknown> | undefined {
    const raw = mmkvStore.get('machine-display-warm-cache-v1:srv_server_a:account-1');
    if (!raw) return undefined;
    return (JSON.parse(raw) as Record<string, Record<string, unknown>>)[machineId];
}

// Collect the real store graph before timing behavior assertions. The first
// cold transform is not part of a warm-cache persistence operation.
await loadMachineDomainAfterBoot();
await import('@/sync/domains/state/storage');

describe('machines domain: warm cache baseline', () => {
    it('publishes fresh display presence without resaving unchanged warm display facts', async () => {
        const { domain, get } = await createHarness();
        const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId });
        await flushWarmCacheSave();
        const cacheKey = 'machine-display-warm-cache-v1:srv_server_a:account-1';
        const writesBefore = mmkvWrites.filter(key => key === cacheKey).length;
        expect(writesBefore).toBeGreaterThan(0);
        vi.useFakeTimers();
        try {
            let scheduledTimers = 0;
            for (let index = 0; index < 5; index++) {
                const display = get().machineDisplayById['m-1']!;
                domain.replaceMachineDisplays([{ ...structuredClone(display), activeAt: 20 + index, updatedAt: 20 + index }]);
                expect(get().machineDisplayById['m-1']).toBe(display);
                expect(readMachineActivity(display).activeAt).toBe(20 + index);
                scheduledTimers += vi.getTimerCount();
                vi.runOnlyPendingTimers();
            }
            expect(mmkvWrites.filter(key => key === cacheKey).length - writesBefore).toBe(0);
            expect(scheduledTimers).toBe(0);
            const display = get().machineDisplayById['m-1']!;
            domain.replaceMachineDisplays([{ ...display, metadataVersion: 2,
                metadata: { ...display.metadata, displayName: 'Renamed display' } }]);
            vi.runOnlyPendingTimers();
            expect(mmkvWrites.filter(key => key === cacheKey).length - writesBefore).toBe(1);
            expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Renamed display');
            domain.replaceMachineDisplays([{ ...get().machineDisplayById['m-1']!, active: false, activeAt: 30 }]);
            vi.runOnlyPendingTimers();
            expect(mmkvWrites.filter(key => key === cacheKey).length - writesBefore).toBe(2);
            expect(readPersistedMachineEntry('m-1')?.active).toBe(false);
            domain.replaceMachineDisplays([]);
            vi.runOnlyPendingTimers();
            expect(readPersistedMachineEntry('m-1')).toBeUndefined();
        } finally {
            vi.runOnlyPendingTimers();
            vi.useRealTimers();
        }
    });

    it('preserves the persisted machine display name when a later apply carries no metadata', async () => {
        const { domain } = await createHarness();

        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId });
        await flushWarmCacheSave();
        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Dev box');

        // A machine row whose metadata could not be decrypted this round: the renderable
        // metadata goes null, and only the persisted baseline can keep the display name.
        domain.applyMachines([makeMachine({ metadata: null, updatedAt: 20, activeAt: 20 })], false, {
            sourceServerId: activeServerId,
        });
        await flushWarmCacheSave();

        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Dev box');
        expect(readPersistedMachineEntry('m-1')?.updatedAt).toBe(20);
    });

    it('adopts fresh metadata over the persisted baseline', async () => {
        const { domain } = await createHarness();

        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId });
        await flushWarmCacheSave();

        domain.applyMachines([makeMachine({
            metadata: { ...BASE_MACHINE_METADATA, displayName: 'Renamed box' },
            metadataVersion: 2,
            updatedAt: 30,
        })], false, { sourceServerId: activeServerId });
        await flushWarmCacheSave();

        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Renamed box');
    });

    it('persists non-active raw machine inventories under the canonical server identity', async () => {
        const { domain, get, profiles } = await createHarness();
        const other = await profiles.upsertServerProfile({ serverUrl: 'http://server-b.local' });
        await profiles.setServerProfileIdentityForUrl(other.serverUrl, 'srv_server_b');

        domain.applyMachines([makeMachine({
            id: 'machine-old',
            active: false,
            revokedAt: 40,
            replacedByMachineId: 'machine-new',
            replacedAt: 41,
            replacementReason: 'rotated',
        })], true, { sourceServerId: other.id, sourceAccountId: 'account-2' });
        await flushWarmCacheSave();

        expect(get().machines).toEqual({});
        expect(get().machineListByServerId[profiles.resolveServerProfileScopeIdForIdentifier(other.id)]).toHaveLength(1);
        expect(mmkvStore.get('machine-display-warm-cache-v1:srv_server_b:account-1')).toBeUndefined();
        const raw = mmkvStore.get('machine-display-warm-cache-v1:srv_server_b:account-2');
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

    it('does not borrow the focused Account for an unqualified secondary inventory', async () => {
        const { domain, profiles } = await createHarness();
        const other = await profiles.upsertServerProfile({ serverUrl: 'http://server-b.local' });
        await profiles.setServerProfileIdentityForUrl(other.serverUrl, 'srv_server_b');
        domain.applyMachines([makeMachine()], true, { sourceServerId: other.id });
        await flushWarmCacheSave();
        expect(mmkvStore.get('machine-display-warm-cache-v1:srv_server_b:account-1')).toBeUndefined();
    });

    it('does not persist a foreground inventory before its Account scope is available', async () => {
        const { domain } = await createHarness();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: null });
        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId });
        await flushWarmCacheSave();
        expect(mmkvStore.get('machine-display-warm-cache-v1:srv_server_a:account-1')).toBeUndefined();
    });

    it('persists foreground display rows for the proven scope rather than a retained profile id', async () => {
        const { domain } = await createHarness();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profile: { ...storage.getState().profile, id: 'retained-account' } });
        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId });
        await flushWarmCacheSave();
        expect(readPersistedMachineEntry('m-1')?.displayName).toBe('Dev box');
        expect(mmkvStore.get('machine-display-warm-cache-v1:srv_server_a:retained-account')).toBeUndefined();
    });

    it('refuses a same-Home inventory captured for a replaced Account', async () => {
        const { domain, get } = await createHarness();
        const before = get();
        domain.applyMachines([makeMachine()], true, { sourceServerId: activeServerId, sourceAccountId: 'retired-account' });
        await flushWarmCacheSave();
        expect(get()).toBe(before);
        expect(mmkvStore.get('machine-display-warm-cache-v1:srv_server_a:account-1')).toBeUndefined();
    });
});
