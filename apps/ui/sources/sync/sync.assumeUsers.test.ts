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

    it('reads every missing person of one feed page in one request and caches the absent ones as unknown', async () => {
        const people = ['friend-a', 'friend-b'].map(id => ({ id, name: id, firstName: '', lastName: null, avatar: null,
            username: '', bio: null, badges: [], status: 'friend', publicKey: null }));
        // HTTP is the system boundary. Both the singleton and the batch respond validly, so the count is the contract.
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            const person = people.find(row => row.id === path.split('/').at(-1));
            const payload = init?.method === 'POST' ? { users: people } : person ? { user: person } : { error: 'User not found' };
            return new Response(JSON.stringify(payload), { status: init?.method === 'POST' || person ? 200 : 404,
                headers: { 'Content-Type': 'application/json' } });
        });
        const { sync } = await import('./sync');
        await sync.assumeUsers(['friend-a', 'friend-b', 'friend-gone'], { request });
        expect(request).toHaveBeenCalledTimes(1);
        expect(storage.getState().users['friend-a']?.id).toBe('friend-a');
        expect(storage.getState().users['friend-b']?.id).toBe('friend-b');
        expect(storage.getState().users['friend-gone']).toBeNull();
    });

});
