import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvCtor = vi.fn(() => {
    throw new Error('MMKV should not be constructed in web runtime');
});

vi.mock('react-native-mmkv', () => ({
    MMKV: mmkvCtor,
}));

describe('pushTokenRegistration', () => {
    beforeEach(() => {
        vi.resetModules();
        mmkvCtor.mockClear();

        vi.stubGlobal('window', {});
        vi.stubGlobal('document', {});

        const store = new Map<string, string>();
        const localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => {
                store.set(String(key), String(value));
            },
            removeItem: (key: string) => {
                store.delete(String(key));
            },
        };
        vi.stubGlobal('localStorage', localStorage);
        (globalThis.window as any).localStorage = localStorage;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('roundtrips token using localStorage on web without constructing MMKV', async () => {
        const module = await import('./pushTokenRegistration');

        expect(module.loadLastRegisteredExpoPushToken()).toBeNull();
        module.saveLastRegisteredExpoPushToken('ExponentPushToken[abc]');
        expect(module.loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[abc]');

        module.clearLastRegisteredExpoPushToken();
        expect(module.loadLastRegisteredExpoPushToken()).toBeNull();

        expect(mmkvCtor).not.toHaveBeenCalled();
    });
});
