import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

function createLocalStorage(): StorageLike {
    const map = new Map<string, string>();
    return {
        getItem: (key) => (map.has(key) ? map.get(key)! : null),
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

async function activateServer(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    upsertAndActivateServer({ serverUrl, source: 'manual', scope: 'device', replaceEquivalentStoredUrl: true });
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
        await activateServer('https://relay.example.test');

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

    it('round-trips a remote relay-host intent on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        await activateServer('https://relay.example.test');

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

    it('reads a legacy mmkv pending setup intent record on web', async () => {
        const record = JSON.stringify({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: null,
            createdAtMs: Date.now(),
        });
        globalThis.localStorage.setItem('mmkv.pending-setup-intent\\record', record);
        await activateServer('https://relay.example.test');

        const { getPendingSetupIntent } = await importFreshWeb();

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: null,
        });
    });
});
