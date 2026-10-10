import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            AppState: {
                                                addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any,
                                            },
                                        }
    );
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storage } from './domains/state/storage';

const initialStorageState = storage.getState();

describe('sync.assumeUsers', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();

        const { sync } = await import('./syncEngine');
        (sync as any).credentials = { token: 'test-token', secret: 'test-secret' };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a transient profile read so feed refresh retries without caching absence', async () => {
        const failure = new TypeError('Failed to fetch');
        const request = vi.fn(async () => new Response('', { status: 404 }));
        request.mockRejectedValueOnce(failure);
        const { sync } = await import('./sync');
        await expect(sync.assumeUsers(['user_transient'], { request })).rejects.toBe(failure);
        expect(storage.getState().users.user_transient).toBeUndefined();
        await sync.assumeUsers(['user_transient'], { request });
        expect(storage.getState().users.user_transient).toBeNull();
    });

    it('caches null when user fetch returns null (not found)', async () => {
        const { sync } = await import('./sync');
        const request = vi.fn(async () => new Response('', { status: 404 }));
        await sync.assumeUsers(['user_missing'], { request });

        expect(storage.getState().users.user_missing).toBeNull();
    });
});
