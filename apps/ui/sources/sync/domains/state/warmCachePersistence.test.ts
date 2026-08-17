import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const getString = vi.fn((key: string) => store.get(key));
const set = vi.fn((key: string, value: string) => {
    store.set(key, value);
});
const deleteKey = vi.fn((key: string) => {
    store.delete(key);
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return getString(key);
        }

        set(key: string, value: string) {
            set(key, value);
        }

        delete(key: string) {
            deleteKey(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        trim() {}
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
    scheduleWarmCacheBootHydration,
    setWarmCacheAccountScope,
} from './warmCachePersistence';
import { prepareWarmCacheEncryptionKey } from './warmCacheEncryptionKey';

describe('warmCachePersistence', () => {
    beforeEach(async () => {
        // Nothing reads or writes the cache until its at-rest key resolves, exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        store.clear();
        getString.mockClear();
        set.mockClear();
        deleteKey.mockClear();
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
                keepVisibleWhenInactive: true,
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
                keepVisibleWhenInactive: true,
            }),
        });
        expect(loadSessionListWarmCacheEntries('server-b', 'account-a')).toEqual({});
        expect(loadSessionListWarmCacheEntries('server-a', 'account-b')).toEqual({});
    });

    it('persists canonical external-session agent identity without providerId', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                updatedAt: 20,
                createdAt: 10,
                active: true,
                activeAt: 20,
                archivedAt: null,
                path: '/home/u/repo',
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'codexHome', home: 'user' },
                },
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a').s1?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        });
    });

    it('rehydrates rollback eligibility from persisted session list entries', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
                s1: {
                    sessionId: 's1',
                    metadataVersion: 2,
                    agentStateVersion: 3,
                    updatedAt: 20,
                    createdAt: 10,
                    active: true,
                    activeAt: 20,
                    archivedAt: null,
                    path: '/home/u/repo',
                    rollbackEligibleTurnStarts: [2, 8],
                },
            }),
        );

        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                rollbackEligibleTurnStarts: [2, 8],
            }),
        });
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
                replacedByMachineId: 'm2',
                replacedAt: 23,
                replacementReason: 'reinstalled',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
                lockedReason: 'decryption_failed',
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
                replacedByMachineId: 'm2',
                replacedAt: 23,
                replacementReason: 'reinstalled',
                replacementSource: 'automatic',
                replacementActorUserId: 'user-1',
                lockedReason: 'decryption_failed',
            }),
        });
    });

    it('skips identical warm-cache writes for session list entries', () => {
        const entries = {
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
                accessLevel: 'edit' as const,
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
        };

        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);
        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);

        expect(set).toHaveBeenCalledTimes(1);
        expect(loadSessionListWarmCacheEntries('server-a', 'account-a')).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
            }),
        });
    });

    it('skips re-serializing the same warm-cache object twice for session list entries', () => {
        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const entries = {
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
                accessLevel: 'edit' as const,
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
        };

        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);
        saveSessionListWarmCacheEntries('server-a', 'account-a', entries);

        expect(stringifySpy).toHaveBeenCalledTimes(1);
        expect(set).toHaveBeenCalledTimes(1);
        stringifySpy.mockRestore();
    });

    it('does not delete absent warm-cache entries when saving an empty session list', () => {
        const keysSpy = vi.spyOn(Object, 'keys');

        saveSessionListWarmCacheEntries('server-a', 'account-a', {});

        expect(deleteKey).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
        expect(keysSpy).not.toHaveBeenCalled();
        keysSpy.mockRestore();
    });

    it('prefers the authenticated runtime account scope over stale persisted profile ids', () => {
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');

        setWarmCacheAccountScope('authenticated-account');
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('authenticated-account');

        clearWarmCacheAccountScope();
        expect(resolveWarmCacheAccountScope('persisted-account')).toBe('persisted-account');
    });

    it('reuses shared empty objects for empty warm-cache loads', () => {
        const keysSpy = vi.spyOn(Object, 'keys');

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-b', 'account-b');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-b', 'account-b');

        expect(firstSessionLoad).toEqual(secondSessionLoad);
        expect(firstMachineLoad).toEqual(secondMachineLoad);
        expect(firstSessionLoad).toBe(firstMachineLoad);
        expect(firstSessionLoad).toEqual({});
        expect(firstMachineLoad).toEqual({});
        expect(keysSpy).not.toHaveBeenCalled();
        keysSpy.mockRestore();
    });

    it('reuses shared empty objects when legacy persisted warm-cache payloads are empty objects', () => {
        store.set('session-list-warm-cache-v1:server-a:account-a', '{}');
        store.set('machine-display-warm-cache-v1:server-a:account-a', '{}');

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');

        expect(firstSessionLoad).toBe(secondSessionLoad);
        expect(firstMachineLoad).toBe(secondMachineLoad);
        expect(firstSessionLoad).toEqual({});
        expect(firstMachineLoad).toEqual({});
    });

    it('reuses loaded warm-cache objects for repeated non-empty loads', () => {
        store.set(
            'session-list-warm-cache-v1:server-a:account-a',
            JSON.stringify({
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
            }),
        );
        store.set(
            'machine-display-warm-cache-v1:server-a:account-a',
            JSON.stringify({
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
            }),
        );

        const firstSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const secondSessionLoad = loadSessionListWarmCacheEntries('server-a', 'account-a');
        const firstMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');
        const secondMachineLoad = loadMachineDisplayWarmCacheEntries('server-a', 'account-a');

        expect(firstSessionLoad).toBe(secondSessionLoad);
        expect(firstMachineLoad).toBe(secondMachineLoad);
        expect(firstSessionLoad).toEqual({
            s1: expect.objectContaining({
                sessionId: 's1',
                metadataVersion: 2,
                agentStateVersion: 3,
                name: 'Repo',
            }),
        });
        expect(firstMachineLoad).toEqual({
            m1: expect.objectContaining({
                machineId: 'm1',
                metadataVersion: 5,
                displayName: 'Work Mac',
            }),
        });
    });

    it('defers boot hydration work and completes through the deterministic fallback', async () => {
        vi.useFakeTimers();
        const previousRequestIdleCallback = globalThis.requestIdleCallback;
        const previousCancelIdleCallback = globalThis.cancelIdleCallback;
        const idleCallbacks: Array<() => void> = [];
        const cancelIdleCallback = vi.fn();
        Object.defineProperty(globalThis, 'requestIdleCallback', {
            configurable: true,
            value: vi.fn((callback: () => void) => {
                idleCallbacks.push(callback);
                return 7;
            }),
        });
        Object.defineProperty(globalThis, 'cancelIdleCallback', {
            configurable: true,
            value: cancelIdleCallback,
        });

        try {
            const task = vi.fn();
            const scheduled = scheduleWarmCacheBootHydration(task, { fallbackDelayMs: 50 });

            expect(task).not.toHaveBeenCalled();
            expect(idleCallbacks).toHaveLength(1);

            await Promise.resolve();
            vi.advanceTimersByTime(49);
            expect(task).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            await scheduled.done;

            expect(task).toHaveBeenCalledTimes(1);
            expect(cancelIdleCallback).toHaveBeenCalledWith(7);
        } finally {
            Object.defineProperty(globalThis, 'requestIdleCallback', {
                configurable: true,
                value: previousRequestIdleCallback,
            });
            Object.defineProperty(globalThis, 'cancelIdleCallback', {
                configurable: true,
                value: previousCancelIdleCallback,
            });
            vi.useRealTimers();
        }
    });
});
