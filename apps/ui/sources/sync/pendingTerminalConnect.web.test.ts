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
    return await import('./pendingTerminalConnect.web');
}

describe('pendingTerminalConnect.web', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createLocalStorage());
    });

    afterEach(async () => {
        const { clearPendingTerminalConnect } = await importFreshWeb();
        clearPendingTerminalConnect();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('round-trips a pending terminal connect payload on web', async () => {
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
        expect(getPendingTerminalConnect()).toEqual({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });
    });

    it('expires stale pending payloads on web', async () => {
        const now = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const { setPendingTerminalConnect, getPendingTerminalConnect } = await importFreshWeb();
        setPendingTerminalConnect({
            publicKeyB64Url: 'abcDEF_123-zzz',
            serverUrl: 'https://stack.example.test',
        });

        vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        expect(getPendingTerminalConnect()).toBeNull();
    });
});
