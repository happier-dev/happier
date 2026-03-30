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
});
