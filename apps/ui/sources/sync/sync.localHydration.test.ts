import { beforeEach, describe, expect, it, vi } from 'vitest';

// The warm cache and settings persistence open MMKV; a Map is the storage boundary here.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
        trim() {}
    }
    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import {
    clearWarmCacheAccountScope,
    saveSessionListWarmCacheEntries,
    saveMachineDisplayWarmCacheEntries,
    type SessionListCacheEntryV1,
} from '@/sync/domains/state/warmCachePersistence';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { getServerProfileById, setActiveServerId, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';

function buildTokenWithSub(sub: string): string {
    const payload = encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64');
    return `hdr.${payload}.sig`;
}

function cacheEntry(sessionId: string, name: string): SessionListCacheEntryV1 {
    return {
        sessionId,
        metadataVersion: 2,
        agentStateVersion: 3,
        updatedAt: 20,
        createdAt: 10,
        active: false,
        activeAt: 20,
        archivedAt: null,
        pendingCount: 0,
        pendingVersion: 0,
        accessLevel: 'edit',
        canApprovePermissions: true,
        name,
        path: `/home/u/${name}`,
        homeDir: '/home/u',
        host: 'mbp',
        machineId: 'm1',
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
    } as SessionListCacheEntryV1;
}

describe('Sync local hydration (cache before transport)', () => {
    beforeEach(async () => {
        kvStore.clear();
        clearWarmCacheAccountScope();
        await prepareWarmCacheEncryptionKey();
    });

    it('hydrates alias-only Machine displays offline after the Home learns its portable identity', async () => {
        const serverUrl = 'http://localhost:53292';
        const profile = await upsertAndActivateServer({ serverUrl, scope: 'device' });
        const alias = profile.id;
        // The 0.2 writer saved the active id before portable identity discovery.
        saveMachineDisplayWarmCacheEntries(alias, 'account-warm', {
            offline: { machineId: 'offline', metadataVersion: 1, updatedAt: 20,
                active: false, activeAt: 10, revokedAt: null, displayName: 'Offline laptop' },
        });
        await setServerProfileIdentityForUrl(serverUrl, 'srv_warm_hydration');
        expect(getServerProfileById('srv_warm_hydration')?.id).toBe(alias);
        await setActiveServerId(alias, { scope: 'device' });
        expect(getActiveServerSnapshot().serverId).toBe('srv_warm_hydration');
        storage.getState().replaceMachineDisplays([]);
        const { syncHydrateLocalState } = await import('./syncEngine');
        syncHydrateLocalState({ token: buildTokenWithSub('account-warm'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }, {
            ...getActiveServerSnapshot(), serverId: 'srv_warm_hydration',
        });
        expect(storage.getState().machineDisplayById.offline?.metadata?.displayName).toBe('Offline laptop');
        expect(storage.getState().machineDisplayById.offline?.active).toBe(false);
        saveMachineDisplayWarmCacheEntries('srv_warm_hydration', 'account-warm', {
            portable: { machineId: 'portable', metadataVersion: 1, updatedAt: 30,
                active: false, activeAt: 10, revokedAt: null, displayName: 'Portable-key laptop' },
        });
        storage.getState().replaceMachineDisplays([]);
        syncHydrateLocalState({ token: buildTokenWithSub('account-warm'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }, {
            ...getActiveServerSnapshot(), serverId: alias,
        });
        expect(Object.keys(storage.getState().machineDisplayById).sort()).toEqual(['offline', 'portable']);
    });

    it('publishes the same Account/Home warm rows synchronously, before any transport exists', async () => {
        await upsertAndActivateServer({ serverUrl: 'http://localhost:53291', scope: 'tab' });
        const serverId = getActiveServerSnapshot().serverId;
        saveSessionListWarmCacheEntries(serverId, 'account-a', { s1: cacheEntry('s1', 'repo-a') });
        saveSessionListWarmCacheEntries(serverId, 'account-b', { s2: cacheEntry('s2', 'repo-b') });

        const credentials: AuthCredentials = {
            token: buildTokenWithSub('account-a'),
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        };
        const { syncHydrateLocalState } = await import('./syncEngine');

        // No await between the call and the assertion: an unreachable carrier or a
        // pending socket must not stand between the cache and the rendered list.
        syncHydrateLocalState(credentials, {
            serverId,
            serverUrl: getActiveServerSnapshot().serverUrl,
            generation: getActiveServerSnapshot().generation,
        });

        const state = storage.getState();
        expect(Object.keys(state.sessionListRowsByServerId[serverId] ?? {})).toEqual(['s1']);
        expect(state.ordinarySessionListMembershipByServerId[serverId]).toEqual(['s1']);
        expect(state.sessionListIndexByServerId[serverId]?.some((item) => (
            item.type === 'session' && item.sessionId === 's1'
        ))).toBe(true);
    });
});
