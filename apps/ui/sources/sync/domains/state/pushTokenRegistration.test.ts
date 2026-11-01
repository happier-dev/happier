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

    it('migrates legacy lastExpoPushTokenV1 bytes into generation state on read', async () => {
        const { scopedStorageId } = await import('@/utils/system/storageScope');
        const legacyKey = `${scopedStorageId('push-token-registration', null)}:lastExpoPushTokenV1`;
        window.localStorage.setItem(legacyKey, 'ExponentPushToken[legacy]');

        const module = await import('./pushTokenRegistration');

        expect(module.loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[legacy]');
        expect(module.loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[legacy]',
            cleanupPending: null,
        });
        expect(module.loadExpoPushTokensToUnregister()).toEqual(['ExponentPushToken[legacy]']);
    });

    it('keeps the observed token and the cleanup-pending prior token together', async () => {
        const module = await import('./pushTokenRegistration');

        module.saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[new]',
            cleanupPending: 'ExponentPushToken[old]',
        });

        expect(module.loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[new]');
        expect(module.loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[new]',
            cleanupPending: 'ExponentPushToken[old]',
        });
        expect(module.loadExpoPushTokensToUnregister())
            .toEqual(['ExponentPushToken[new]', 'ExponentPushToken[old]']);
    });

    it('dedupes the unregister list when the pending token equals the current token', async () => {
        const module = await import('./pushTokenRegistration');

        module.saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[same]',
            cleanupPending: 'ExponentPushToken[same]',
        });

        expect(module.loadExpoPushTokensToUnregister()).toEqual(['ExponentPushToken[same]']);
    });

    it('clears the cleanup-pending prior token on a full-success commit', async () => {
        const module = await import('./pushTokenRegistration');

        module.saveExpoPushTokenGeneration({
            current: 'ExponentPushToken[new]',
            cleanupPending: 'ExponentPushToken[old]',
        });
        module.saveLastRegisteredExpoPushToken('ExponentPushToken[new]');

        expect(module.loadRegisteredExpoPushTokenState()).toEqual({
            current: 'ExponentPushToken[new]',
            cleanupPending: null,
        });
        expect(module.loadExpoPushTokensToUnregister()).toEqual(['ExponentPushToken[new]']);
    });

    it('drops an unreadable generation record instead of surfacing corrupt tokens', async () => {
        const { scopedStorageId } = await import('@/utils/system/storageScope');
        const generationKey = `${scopedStorageId('push-token-registration', null)}:expoPushTokenGenerationV1`;
        window.localStorage.setItem(generationKey, '{not-json');

        const module = await import('./pushTokenRegistration');

        expect(module.loadRegisteredExpoPushTokenState()).toEqual({ current: null, cleanupPending: null });
        expect(module.loadExpoPushTokensToUnregister()).toEqual([]);
    });
});
