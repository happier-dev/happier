import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }
    }

    return { MMKV };
});

import {
    clearWarmCacheAccountScope,
    loadMachineDisplayWarmCacheEntries,
    loadSessionListWarmCacheEntries,
    resolveWarmCacheAccountScope,
    saveMachineDisplayWarmCacheEntries,
    saveSessionListWarmCacheEntries,
    setWarmCacheAccountScope,
} from './warmCachePersistence';

describe('warmCachePersistence', () => {
    beforeEach(() => {
        store.clear();
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
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({ s1: { sessionId: 's1', metadataVersion: 'bad' } }),
        );
        store.set(
            'machine-display-warm-cache-v1:server-a:account-a',
            JSON.stringify({ m1: { machineId: 'm1', metadataVersion: 'bad' } }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({});
        expect(loadMachineDisplayWarmCacheEntries('server-a', 'account-a')).toEqual({});
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

    it('prefers the authenticated runtime account scope over stale persisted profile ids', () => {
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');

        setWarmCacheAccountScope('authenticated-account');
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('authenticated-account');

        clearWarmCacheAccountScope();
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');
    });
});
