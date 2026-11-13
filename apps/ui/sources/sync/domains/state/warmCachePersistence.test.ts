import { beforeEach, describe, expect, it, vi } from 'vitest';

// One map per MMKV instance id: the warm cache lives in its own encrypted instance, separate from
// the shared `default` one that older builds wrote it into in plaintext.
const storesById = new Map<string, Map<string, string>>();

function storeFor(id: string): Map<string, string> {
    const existing = storesById.get(id);
    if (existing) return existing;
    const created = new Map<string, string>();
    storesById.set(id, created);
    return created;
}

vi.mock('react-native-mmkv', () => {
    class MMKV {
        private readonly values: Map<string, string>;

        constructor(config?: { id?: string }) {
            this.values = storeFor(config?.id ?? 'mmkv.default');
        }

        getString(key: string) {
            return this.values.get(key);
        }

        set(key: string, value: string) {
            this.values.set(key, value);
        }

        delete(key: string) {
            this.values.delete(key);
        }

        getAllKeys() {
            return [...this.values.keys()];
        }
    }

    return { MMKV };
});

import {
    clearWarmCacheAccountScope,
    loadMachineDisplayWarmCacheEntries,
    loadSessionListWarmCacheEntries,
    loadSessionOrganizationWarmCacheSnapshot,
    resolveWarmCacheAccountScope,
    saveMachineDisplayWarmCacheEntries,
    saveSessionListWarmCacheEntries,
    saveSessionOrganizationWarmCacheSnapshot,
    setWarmCacheAccountScope,
    WARM_CACHE_STORAGE_ID,
} from './warmCachePersistence';
import { prepareWarmCacheEncryptionKey } from './warmCacheEncryptionKey';

function store(): Map<string, string> {
    return storeFor(WARM_CACHE_STORAGE_ID);
}

const SESSION_LIST_WARM_CACHE_KEY = 'session-list-warm-cache-v3:server-a:account-a';
const LEGACY_SESSION_LIST_WARM_CACHE_KEYS = [
    'session-list-warm-cache-v1:server-a:account-a',
    'session-list-warm-cache-v2:server-a:account-a',
] as const;

describe('warmCachePersistence', () => {
    beforeEach(async () => {
        // Nothing reads or writes the cache until its at-rest key resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        // Clear the maps in place: the module caches its MMKV instance, which holds a reference to
        // the map it was constructed with, so dropping the registry entry would not reach it.
        for (const instanceStore of storesById.values()) instanceStore.clear();
        clearWarmCacheAccountScope();
    });

    it('roundtrips session list entries by server and account scope', () => {
        saveSessionListWarmCacheEntries('server-a', 'account-a', {
            s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                pendingCount: 1,
                pendingVersion: 4,
                accessLevel: 'edit',
                canApprovePermissions: true,
                name: 'Repo',
                summaryText: 'Summary',
                path: '/home/u/repo',
                homeDir: '/home/u',
                host: 'mbp',
                machineId: 'm1',
                hiddenSystemSession: false,
                hasPendingPermissionRequests: false,
                hasPendingUserActionRequests: true,
            },
        });

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
            }),
        });
        expect(loadSessionListWarmCacheEntries('server-b', 'account-a')).toEqual({});
        expect(loadSessionListWarmCacheEntries('server-a', 'account-b')).toEqual({});
    });

    it('drops invalid payloads safely', () => {
        store().set(
            SESSION_LIST_WARM_CACHE_KEY,
            JSON.stringify({ s1: { sessionId: 's1', metadataVersion: 'bad' } }),
        );
        store().set(
            'machine-display-warm-cache-v1:server-a:account-a',
            JSON.stringify({ m1: { machineId: 'm1', metadataVersion: 'bad' } }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
        expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({});
    });

    it('rejects an unsafe activity revision instead of corrupting ordering', () => {
        store().set(
            SESSION_LIST_WARM_CACHE_KEY,
            JSON.stringify({
                s1: {
                    sessionId: 's1',
                    seq: 1,
                    metadataVersion: 0,
                    agentStateVersion: 0,
                    updatedAt: 1,
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    archivedAt: null,
                    path: '',
                    runtimeActivityState: 'active',
                    runtimeActivityRevision: Number.MAX_SAFE_INTEGER + 1,
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
    });

    it('persists Runtime Activity only as an absent or complete validated tuple', () => {
        const baseEntry = {
            sessionId: 's1',
            seq: 1,
            metadataVersion: 0,
            agentStateVersion: 0,
            updatedAt: 1,
            createdAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            path: '',
        };

        store().set(
            SESSION_LIST_WARM_CACHE_KEY,
            JSON.stringify({
                s1: {
                    ...baseEntry,
                    runtimeActivityState: 'active',
                    runtimeActivityActiveCount: 1,
                    runtimeActivityObservedAt: 1_250,
                    runtimeActivityRevision: 17,
                },
            }),
        );
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1).toEqual(expect.objectContaining({
            runtimeActivityState: 'active',
            runtimeActivityActiveCount: 1,
            runtimeActivityObservedAt: 1_250,
            runtimeActivityRevision: 17,
        }));

        store().set(
            SESSION_LIST_WARM_CACHE_KEY,
            JSON.stringify({
                s1: {
                    ...baseEntry,
                    runtimeActivityState: 'active',
                    runtimeActivityRevision: 18,
                },
            }),
        );
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
    });

    it('retires incomplete v1 and v2 session-list caches instead of treating them as current metadata', () => {
        for (const legacyKey of LEGACY_SESSION_LIST_WARM_CACHE_KEYS) {
            store().set(legacyKey, JSON.stringify({
                s1: {
                    sessionId: 's1',
                    seq: 1,
                    metadataVersion: 14,
                    agentStateVersion: 1,
                    updatedAt: 2,
                    createdAt: 1,
                    active: false,
                    activeAt: 2,
                    archivedAt: null,
                    path: '/repo',
                    machineId: 'machine-1',
                    sessionOriginV1: null,
                    sessionRole: null,
                },
            }));
        }

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
        for (const legacyKey of LEGACY_SESSION_LIST_WARM_CACHE_KEYS) {
            expect(store().has(legacyKey)).toBe(false);
        }
    });

    it('roundtrips machine display entries by server and account scope', () => {
        saveMachineDisplayWarmCacheEntries('server-a', 'account-a', {
            m1: {
                machineId: 'm1',
                metadataVersion: 5,
                updatedAt: 22,
                active: true,
                activeAt: 22,
                revokedAt: null,
                displayName: 'Work Mac',
                host: 'mbp',
                homeDir: '/home/u',
            },
        });

        expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({
            m1: expect.objectContaining({
                machineId: 'm1',
                metadataVersion: 5,
                displayName: 'Work Mac',
            }),
        });
    });

    it('roundtrips the session organization snapshot by server and account scope', () => {
        const snapshot = {
            schemaVersion: 1 as const,
            version: 7,
            pins: [{ sessionId: 's1', sortKey: '00000001', pinnedAt: 10 }],
            folders: [{
                folderId: 'f1',
                folderKey: 'folder-key-1',
                parentFolderId: null,
                parentFolderKey: null,
                sortKey: '00000001',
                display: { t: 'plain' as const, v: { name: 'Work' } },
                archivedAt: null,
                createdAt: 1,
                updatedAt: 2,
            }],
            folderAssignments: [{ sessionId: 's1', folderId: 'f1' }],
            tags: [],
            tagAssignments: [],
            orderEntries: [
                { scopeKind: 'group' as const, scopeKey: 'pinned', itemKind: 'session' as const, itemKey: 's1', sortKey: '00000001' },
            ],
            labels: [],
        };

        saveSessionOrganizationWarmCacheSnapshot('server-a', 'account-a', snapshot);

        expect(loadSessionOrganizationWarmCacheSnapshot('server-a', 'account-a')).toEqual(snapshot);
        expect(loadSessionOrganizationWarmCacheSnapshot('server-a', 'other-account')).toBeNull();
        expect(loadSessionOrganizationWarmCacheSnapshot('server-b', 'account-a')).toBeNull();
    });

    it('drops an unparseable organization snapshot instead of repainting a corrupt organization', () => {
        saveSessionOrganizationWarmCacheSnapshot('server-a', 'account-a', {
            schemaVersion: 1,
            version: 7,
            pins: [],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        });
        const key = [...store().keys()].find((candidate) => candidate.includes('session-organization-warm-cache'));
        expect(key).toBeDefined();
        store().set(String(key), JSON.stringify({ schemaVersion: 1, version: 'not-a-version' }));

        expect(loadSessionOrganizationWarmCacheSnapshot('server-a', 'account-a')).toBeNull();
        expect(store().has(String(key))).toBe(false);
    });

    it('prefers the authenticated runtime account scope over stale persisted profile ids', () => {
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');

        setWarmCacheAccountScope('authenticated-account');
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('authenticated-account');

        clearWarmCacheAccountScope();
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');
    });
});
