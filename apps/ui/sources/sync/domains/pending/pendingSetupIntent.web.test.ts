import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

type StorageLike = {
    readonly length: number;
    getItem: (key: string) => string | null;
    key: (index: number) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

function createLocalStorage(): StorageLike {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        getItem: (key) => (map.has(key) ? map.get(key)! : null),
        key: (index) => Array.from(map.keys())[index] ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
}

async function importFreshWeb() {
    vi.resetModules();
    return await import('./pendingSetupIntent.web');
}

async function applyActiveServer(serverUrl: string) {
    // The app entry registers the real Sync runtime before Home switches.
    await loadSyncSingletonForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');

    const server = await upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    // The Account scope follows the applied Home, not only the selected profile. With the empty
    // credential store this runs the real connection owner without starting authenticated Sync or
    // issuing network requests (the composition `pendingQueueV2.testHelpers.ts` relies on).
    await switchConnectionToActiveServer();
    return server;
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');

    const server = await applyActiveServer(serverUrl);
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope(scope!);
}

async function activateServerWithoutAccount(serverUrl: string) {
    await applyActiveServer(serverUrl);
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().clearProfileScope();
}

describe('pendingSetupIntent.web', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createLocalStorage());
    });

    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFreshWeb();
        clearPendingSetupIntent();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('round-trips a pending setup intent payload on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        await activateServerAccount('https://relay.example.test', 'account-a');

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('expires and removes a web pending setup intent older than the TTL', async () => {
        const writtenAtMs = 1_700_000_000_000;
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(writtenAtMs);
        const { setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

        await activateServerAccount('https://relay.example.test', 'account-a');
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });
        expect(getPendingSetupIntent()).not.toBeNull();

        nowSpy.mockReturnValue(writtenAtMs + (24 * 60 * 60 * 1000) + 1);
        expect(getPendingSetupIntent()).toBeNull();

        nowSpy.mockReturnValue(writtenAtMs);
        const reloaded = await importFreshWeb();
        await activateServerAccount('https://relay.example.test', 'account-a');
        expect(reloaded.getPendingSetupIntent()).toBeNull();
    });

    it('returns a stable pending setup intent reference while the serialized web record is unchanged', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        await activateServerAccount('https://relay.example.test', 'account-a');
        clearPendingSetupIntent();

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        const first = getPendingSetupIntent();
        const second = getPendingSetupIntent();

        expect(first).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(second).toBe(first);

        setPendingSetupIntent({ branch: 'thisComputer', phase: 'post_auth', relayUrl: 'https://relay.example.test' });
        const updated = getPendingSetupIntent();
        expect(updated?.phase).toBe('post_auth');
        expect(updated).not.toBe(first);
        expect(getPendingSetupIntent()).toBe(updated);
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('notifies subscribers when pending setup intent storage changes on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent } = await importFreshWeb();
        const { subscribePendingSetupIntent } = await import('./pendingSetupIntent.shared');
        const listener = vi.fn();

        await activateServerAccount('https://relay.example.test', 'account-a');
        const unsubscribe = subscribePendingSetupIntent(listener);

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });
        clearPendingSetupIntent();
        unsubscribe();

        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('round-trips a remote relay-host intent on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        await activateServerAccount('https://relay.example.test', 'account-a');

        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteRelayHost',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
            machineId: 'machine-remote-1',
            remoteSetupIntent: 'remoteRelayHost',
        });
    });

    it.each(['pending-setup-intent-record', 'mmkv.pending-setup-intent\\record'])(
        'keeps the snapshot and original expiry when adopting legacy key %s on web',
        async (legacyKey) => {
            const writtenAtMs = 1_700_000_000_000;
            const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(writtenAtMs + 60_000);
            const record = JSON.stringify({
                branch: 'thisComputer',
                phase: 'dismissed',
                relayUrl: null,
                createdAtMs: writtenAtMs,
            });
            // An empty first legacy key is absent, so the MMKV-compatible fallback still adopts.
            globalThis.localStorage.setItem('pending-setup-intent-record', '');
            globalThis.localStorage.setItem(legacyKey, record);
            const { getPendingSetupIntent } = await importFreshWeb();
            const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
            await upsertAndActivateServer({ serverUrl: 'https://relay.example.test', source: 'manual', scope: 'device' });

            const first = getPendingSetupIntent();
            expect(first).toEqual({
                branch: 'thisComputer',
                phase: 'dismissed',
                relayUrl: null,
            });
            expect(getPendingSetupIntent()).toBe(first);
            expect(globalThis.localStorage.getItem(legacyKey)).toBeNull();

            nowSpy.mockReturnValue(writtenAtMs + (24 * 60 * 60 * 1000) + 1);
            expect(getPendingSetupIntent()).toBeNull();
        },
    );

    it('round-trips a pending setup intent before an account scope exists on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

        await activateServerWithoutAccount('https://relay.example.test');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
    });

    it('keeps an unauthenticated pending setup intent readable after account scope appears on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

        await activateServerWithoutAccount('https://relay.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        const beforeAuth = getPendingSetupIntent();
        await activateServerAccount('https://relay.example.test', 'account-a');

        const adopted = getPendingSetupIntent();
        expect(adopted).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(adopted).toBe(beforeAuth);
        expect(getPendingSetupIntent()).toBe(adopted);
    });

    it('debug-logs and drops an unauthenticated pending setup intent when auth lands on a different relay URL on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

        await activateServerWithoutAccount('https://relay-a.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay-a.example.test/',
        });

        await activateServerAccount('https://relay-b.example.test', 'account-a');

        expect(getPendingSetupIntent()).toBeNull();
        expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('[pendingSetupIntent] dropped server-scoped setup intent'));

        await activateServerWithoutAccount('https://relay-a.example.test');
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('keeps setup intent payloads isolated by active account on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent, clearPendingSetupIntent } = await importFreshWeb();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
            remoteSetupIntent: 'remoteMachine',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
            remoteSetupIntent: 'remoteMachine',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });
    });
    it('hands a Home-scoped intent to the first account that reads it, never to the next account on web', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFreshWeb();

        await activateServerWithoutAccount('https://shared.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        expect(getPendingSetupIntent()).toBeNull();

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingSetupIntent()?.phase).toBe('dismissed');
    });
});
