import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

type StorageLike = {
    readonly length: number;
    getItem: (key: string) => string | null;
    key: (index: number) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

function createLocalStorage(options: Readonly<{
    failSet?: (key: string, value: string) => boolean;
    failRemove?: (key: string) => boolean;
}> = {}): StorageLike {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        getItem: (key) => (map.has(key) ? map.get(key)! : null),
        key: (index) => [...map.keys()][index] ?? null,
        setItem: (key, value) => {
            if (options.failSet?.(key, value)) throw new Error('set unavailable');
            map.set(key, value);
        },
        removeItem: (key) => {
            if (options.failRemove?.(key)) throw new Error('remove unavailable');
            map.delete(key);
        },
    };
}

async function importFreshWeb() {
    vi.resetModules();
    return await import('./pendingTerminalConnect.web');
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    await loadSyncSingletonForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { storage } = await import('@/sync/domains/state/storage');
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');

    const server = await upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    if (!scope) throw new Error('Expected Account scope');
    await switchConnectionToActiveServer();
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
}

describe('pendingTerminalConnect.web', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createLocalStorage());
        vi.stubGlobal('sessionStorage', createLocalStorage());
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFreshWeb();
        clearPendingTerminalConnect();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload on web', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();
        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            supportsTokenOnly: true,
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
            },
        });
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            supportsTokenOnly: true,
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: 1_900_000_000_000,
                expiresAtMs: 1_900_000_060_000,
            },
        });
    });

    it('captures before authentication and promotes into the hydrated account without extending its deadline', async () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();

        setPendingTerminalConnect({
            publicKeyB64Url: 'pre-auth-key',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: now,
                expiresAtMs: now + 60 * 60 * 1000,
            },
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000);
        setPendingTerminalConnect({
            publicKeyB64Url: 'pre-auth-key',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
            pairing: {
                secretB64Url: 'pairing-secret',
                createdAtMs: now,
                expiresAtMs: now + 60 * 60 * 1000,
            },
        });
        await activateServerAccount('https://stack.example.test', 'account-a');
        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        expect(getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'pre-auth-key' });

        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('does not promote a pre-auth capture to a different server or a later account', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();

        setPendingTerminalConnect({
            publicKeyB64Url: 'target-bound-key',
            serverUrl: 'https://server-b.example.test',
            serverIdentityId: 'srv_b',
        });
        await activateServerAccount('https://server-a.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toBeNull();

        await activateServerAccount('https://server-b.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'target-bound-key' });

        await activateServerAccount('https://server-b.example.test', 'account-b');
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps a failed promotion claimed to its first account across a module reload', async () => {
        vi.stubGlobal('localStorage', createLocalStorage({ failSet: (key) => key.includes(':v2:') }));
        const first = await importFreshWeb();
        first.setPendingTerminalConnect({
            publicKeyB64Url: 'claimed-key',
            serverUrl: 'https://claimed.example.test',
            serverIdentityId: 'srv_claimed',
        });
        await activateServerAccount('https://claimed.example.test', 'account-a');
        expect(first.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'claimed-key' });

        await activateServerAccount('https://claimed.example.test', 'account-b');
        first.retargetPendingTerminalConnectToServerUrl('https://claimed.example.test');
        const reloaded = await importFreshWeb();
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('invalidates an unclaimed persisted capture when persisting its account claim fails', async () => {
        vi.stubGlobal('localStorage', createLocalStorage({ failSet: (key) => key.includes(':v2:') }));
        vi.stubGlobal('sessionStorage', createLocalStorage({
            failSet: (_key, value) => value.includes('claimedScope'),
        }));
        const first = await importFreshWeb();
        first.setPendingTerminalConnect({
            publicKeyB64Url: 'claim-write-failed-key',
            serverUrl: 'https://claim-write-failed.example.test',
            serverIdentityId: 'srv_claim_write_failed',
        });
        await activateServerAccount('https://claim-write-failed.example.test', 'account-a');
        expect(first.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'claim-write-failed-key' });

        const reloaded = await importFreshWeb();
        await activateServerAccount('https://claim-write-failed.example.test', 'account-b');
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('expires an in-memory fallback after pre-auth persistence fails', async () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        vi.stubGlobal('sessionStorage', createLocalStorage({ failSet: () => true }));
        const pending = await importFreshWeb();
        pending.setPendingTerminalConnect({
            publicKeyB64Url: 'memory-expiry-key',
            serverUrl: 'https://memory-expiry.example.test',
            serverIdentityId: 'srv_memory_expiry',
        });
        await activateServerAccount('https://memory-expiry.example.test', 'account-a');
        expect(pending.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'memory-expiry-key' });

        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(pending.getPendingTerminalConnect()).toBeNull();
    });

    it('prefers a newer scoped request over an older same-account claimed fallback', async () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const firstTabSessionStorage = createLocalStorage();
        let failScopedWrites = true;
        const sharedLocalStorage = createLocalStorage({
            failSet: (key) => failScopedWrites && key.includes(':v2:'),
        });
        vi.stubGlobal('sessionStorage', firstTabSessionStorage);
        vi.stubGlobal('localStorage', sharedLocalStorage);
        const firstTab = await importFreshWeb();
        firstTab.setPendingTerminalConnect({
            publicKeyB64Url: 'older-claimed-key',
            serverUrl: 'https://freshness.example.test',
            serverIdentityId: 'srv_freshness',
        });
        await activateServerAccount('https://freshness.example.test', 'account-a');
        expect(firstTab.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'older-claimed-key' });

        vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        failScopedWrites = false;
        vi.stubGlobal('sessionStorage', createLocalStorage());
        const secondTab = await importFreshWeb();
        await activateServerAccount('https://freshness.example.test', 'account-a');
        secondTab.setPendingTerminalConnect({
            publicKeyB64Url: 'newer-scoped-key',
            serverUrl: 'https://freshness.example.test',
            serverIdentityId: 'srv_freshness',
        });

        vi.stubGlobal('sessionStorage', firstTabSessionStorage);
        expect(firstTab.getPendingTerminalConnect()).toMatchObject({ publicKeyB64Url: 'newer-scoped-key' });
    });

    it('retargets only an unclaimed pre-auth intent and preserves its original deadline', async () => {
        const now = 1_800_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const pending = await importFreshWeb();
        pending.setPendingTerminalConnect({
            publicKeyB64Url: 'retarget-key',
            serverUrl: 'https://old-target.example.test',
            serverIdentityId: 'srv_target',
        });

        await activateServerAccount('https://new-target.example.test', 'account-a');
        vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000);
        pending.retargetPendingTerminalConnectToServerUrl('https://new-target.example.test');
        expect(pending.getPendingTerminalConnect()).toMatchObject({
            publicKeyB64Url: 'retarget-key',
            serverUrl: 'https://new-target.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);
        expect(pending.getPendingTerminalConnect()).toBeNull();
    });

    it('leaves a cancellation tombstone when session-storage deletion fails', async () => {
        vi.stubGlobal('sessionStorage', createLocalStorage({ failRemove: () => true }));
        const first = await importFreshWeb();
        first.setPendingTerminalConnect({
            publicKeyB64Url: 'cancelled-key',
            serverUrl: 'https://cancelled.example.test',
            serverIdentityId: 'srv_cancelled',
        });
        first.clearPendingTerminalConnect();

        const reloaded = await importFreshWeb();
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('still deletes a cancelled pre-auth capture when the tombstone write fails', async () => {
        vi.stubGlobal('sessionStorage', createLocalStorage({ failSet: (_key, value) => value === '{}' }));
        const first = await importFreshWeb();
        first.setPendingTerminalConnect({
            publicKeyB64Url: 'cancelled-key',
            serverUrl: 'https://cancelled.example.test',
            serverIdentityId: 'srv_cancelled',
        });
        first.clearPendingTerminalConnect();

        const reloaded = await importFreshWeb();
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('tombstones an account-scoped approval when deletion fails', async () => {
        vi.stubGlobal('localStorage', createLocalStorage({ failRemove: (key) => key.includes(':v2:') }));
        const first = await importFreshWeb();
        await activateServerAccount('https://scoped-clear.example.test', 'account-a');
        first.setPendingTerminalConnect({
            publicKeyB64Url: 'scoped-clear-key',
            serverUrl: 'https://scoped-clear.example.test',
            serverIdentityId: 'srv_scoped_clear',
        });
        first.clearPendingTerminalConnect();

        const reloaded = await importFreshWeb();
        expect(reloaded.getPendingTerminalConnect()).toBeNull();
    });

    it('falls back safely when browser storage getters are unavailable', async () => {
        const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied'); } });
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('denied'); } });
        try {
            const pending = await importFreshWeb();
            expect(() => pending.setPendingTerminalConnect({
                publicKeyB64Url: 'memory-key',
                serverUrl: 'https://memory.example.test',
                serverIdentityId: 'srv_memory',
            })).not.toThrow();
            expect(() => pending.clearPendingTerminalConnect()).not.toThrow();
        } finally {
            if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
            if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
        }
    });

    it('expires stale pending payloads on web', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();
        await activateServerAccount('https://stack.example.test', 'account-a');
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
            serverIdentityId: 'srv_stack',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });

    it('keeps terminal connect payloads isolated by active account on web', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect, clearPendingTerminalConnect } = await importFreshWeb();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingTerminalConnect();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingTerminalConnect();
        expect(getPendingTerminalConnect()).toBeNull();
        setPendingTerminalConnect({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-b',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'key-a',
            serverUrl: 'https://shared.example.test',
            serverIdentityId: 'srv_shared',
        });
    });
});
