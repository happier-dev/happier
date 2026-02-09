import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

function installLocalStorage() {
    const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    const getItem = vi.fn((key: string) => store.get(key) ?? null);
    const setItem = vi.fn((key: string, value: string) => {
        store.set(key, value);
    });
    const removeItem = vi.fn((key: string) => {
        store.delete(key);
    });

    Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem, setItem, removeItem },
        configurable: true,
    });

    const restore = () => {
        if (previousDescriptor) {
            Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
            return;
        }
        // @ts-expect-error localStorage may not exist in this runtime.
        delete globalThis.localStorage;
    };

    return { restore };
}

describe('TokenStorage pending external connect (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;

    beforeEach(() => {
        vi.resetModules();
        restoreLocalStorage = installLocalStorage().restore;
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
    });

    it('round-trips pending external connect state', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        await expect((TokenStorage as any).getPendingExternalConnect()).resolves.toBeNull();
        await expect((TokenStorage as any).setPendingExternalConnect({ provider: 'github', returnTo: '/friends' })).resolves.toBe(true);
        await expect((TokenStorage as any).getPendingExternalConnect()).resolves.toEqual({ provider: 'github', returnTo: '/friends' });
        await expect((TokenStorage as any).clearPendingExternalConnect()).resolves.toBe(true);
        await expect((TokenStorage as any).getPendingExternalConnect()).resolves.toBeNull();
    });

    it('returns null for malformed pending external connect payloads', async () => {
        const { TokenStorage } = await import('./tokenStorage');
        ((localStorage as any).getItem as any).mockReturnValueOnce(JSON.stringify({ provider: 'github', returnTo: 123 }));

        await expect((TokenStorage as any).getPendingExternalConnect()).resolves.toBeNull();
    });
});
