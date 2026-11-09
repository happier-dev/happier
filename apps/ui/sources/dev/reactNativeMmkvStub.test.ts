import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { MMKV, resetMmkvStoresForTests } from './reactNativeMmkvStub';

const platform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: {
        get OS() { return platform.os; },
        select: (values: Record<string, unknown>) => values[platform.os] ?? values.default,
    } });
});

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let createWebMMKV: typeof import('../../../../node_modules/react-native-mmkv/src/createMMKV.web').createMMKV;

beforeAll(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://mmkv-contract.test' });
    // Bypass the UI alias and the package's built-in Jest/Vitest mock.
    ({ createMMKV: createWebMMKV } = await import('../../../../node_modules/react-native-mmkv/src/createMMKV.web'));
});
beforeEach(() => {
    platform.os = 'web';
    browser.activate();
    browser.storage.clear();
    resetMmkvStoresForTests();
});
afterAll(() => browser.restore());

it.each(['ios', 'android'] as const)('retains native %s keys and ids containing backslashes', os => {
    platform.os = os;
    const storage = new MMKV({ id: String.raw`native\account` });
    const key = JSON.stringify(['session-target', JSON.stringify(['home', 'session'])]);
    expect(key).toContain('\\');
    storage.set(key, 'retained attachment sources');
    expect(storage.getString(key)).toBe('retained attachment sources');
    expect(storage.contains(key)).toBe(true);
    expect(storage.getAllKeys()).toEqual([key]);
    storage.delete(key);
    expect(storage.contains(key)).toBe(false);
});

it('limits native-only legacy keys to the explicit migration boundary and restores strict storage', async () => {
    const { installLegacyNativeMmkvBoundaryForTest } = await import('@/dev/testkit/harness/persistentUiState');
    const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
    const storage = getPersistenceStorage();
    const legacyKey = String.raw`legacy\key`;
    await installLegacyNativeMmkvBoundaryForTest();
    try {
        storage.set(legacyKey, 'retained native choice');
        expect(storage.getAllKeys()).toEqual([legacyKey]);
        expect(storage.getString(legacyKey)).toBe('retained native choice');
    } finally {
        vi.restoreAllMocks();
    }
    expect(() => storage.set(legacyKey, 'refused'))
        .toThrow('MMKV: `key` cannot contain the backslash character (`\\`)!');
    expect(storage.getAllKeys()).toEqual([]);
});

describe.each(['installed web adapter', 'shared stub'] as const)('%s key contract', implementation => {
    const create = (id: string) => implementation === 'installed web adapter'
        ? createWebMMKV({ id })
        : new MMKV({ id });

    it.each(['set', 'getString', 'getNumber', 'getBoolean', 'getBuffer', 'contains', 'delete'] as const)(
        'rejects backslash keys on %s without changing stored keys', operation => {
            const storage = create('mmkv-contract');
            storage.set('retained', 'value');
            const invalidKey = String.raw`project:C:\work\project`;
            const invoke = () => operation === 'set'
                ? storage.set(invalidKey, 'refused')
                : storage[operation](invalidKey);
            expect(invoke).toThrow('MMKV: `key` cannot contain the backslash character (`\\`)!');
            expect(storage.getAllKeys()).toEqual(['retained']);
            expect(storage.getString('retained')).toBe('value');
        },
    );

    it('rejects backslashes in the store id', () => {
        expect(() => create(String.raw`home\account`))
            .toThrow('MMKV: `id` cannot contain the backslash character (`\\`)!');
    });

    it('accepts empty keys and ids, punctuation, forward slashes, encoded paths and Unicode', () => {
        const storage = create('');
        const keys = ['', 'home/account:group', 'C%3A%5Cwork%5Cproject', '["group","quote"]', '日本語'];
        for (const key of keys) storage.set(key, key);
        expect(storage.getAllKeys().sort()).toEqual([...keys].sort());
        for (const key of keys) {
            expect(storage.contains(key)).toBe(true);
            expect(storage.getString(key)).toBe(key);
            storage.delete(key);
            expect(storage.contains(key)).toBe(false);
        }
        expect(storage.getAllKeys()).toEqual([]);
    });
});
