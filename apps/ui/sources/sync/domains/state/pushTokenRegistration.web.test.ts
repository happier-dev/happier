import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvCtor = vi.fn(() => {
    throw new Error('MMKV should not be constructed on web');
});

vi.mock('react-native-mmkv', () => ({
    MMKV: mmkvCtor,
}));

function createLocalStorageMock(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
        setItem: (key: string, value: string) => {
            map.set(key, String(value));
        },
        removeItem: (key: string) => {
            map.delete(key);
        },
        clear: () => {
            map.clear();
        },
        key: (index: number) => Array.from(map.keys())[index] ?? null,
        get length() {
            return map.size;
        },
    } as unknown as Storage;
}

describe('pushTokenRegistration (web)', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('document', {});
        vi.stubGlobal('window', { localStorage: createLocalStorageMock() });
        mmkvCtor.mockClear();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses localStorage instead of MMKV', async () => {
        const { saveLastRegisteredExpoPushToken, loadLastRegisteredExpoPushToken, clearLastRegisteredExpoPushToken } =
            await import('./pushTokenRegistration');

        expect(loadLastRegisteredExpoPushToken()).toBeNull();
        saveLastRegisteredExpoPushToken('ExponentPushToken[test]');
        expect(loadLastRegisteredExpoPushToken()).toBe('ExponentPushToken[test]');
        clearLastRegisteredExpoPushToken();
        expect(loadLastRegisteredExpoPushToken()).toBeNull();

        expect(mmkvCtor).not.toHaveBeenCalled();
    });
});

