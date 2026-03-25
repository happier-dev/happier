import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => {
    throw new Error('MMKV should not be imported in web runtime');
});

describe('pushTokenRegistration', () => {
    beforeEach(() => {
        vi.resetModules();

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

    it('roundtrips token using localStorage on web without importing MMKV', async () => {
        const module = await import('./pushTokenRegistration');

        expect(module.loadLastRegisteredExpoPushToken()).toBeNull();
        module.saveLastRegisteredExpoPushToken('ExponentPushToken[abc]');
        expect(module.loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[abc]');

        module.clearLastRegisteredExpoPushToken();
        expect(module.loadLastRegisteredExpoPushToken()).toBeNull();
    });
});
