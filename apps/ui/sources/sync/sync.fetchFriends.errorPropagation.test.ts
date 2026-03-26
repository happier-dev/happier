import { afterEach, describe, expect, it, vi } from 'vitest';

// Sync imports persistence, which instantiates MMKV. Mock it for deterministic tests.
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

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fetchAndApplyFriendsSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {
    throw new Error('boom');
}));

vi.mock('./engine/social/syncFriends', () => ({
    fetchAndApplyFriends: (...args: any[]) => fetchAndApplyFriendsSpy(...args),
}));

describe('sync fetchFriends error propagation', () => {
    afterEach(() => {
        fetchAndApplyFriendsSpy.mockClear();
        kvStore.clear();
        vi.resetModules();
    });

    it('propagates errors so InvalidateSync can own retry/backoff semantics', async () => {
        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'token', secret: 'secret' };

        await expect((sync as any).fetchFriends()).rejects.toThrow('boom');
        expect(fetchAndApplyFriendsSpy).toHaveBeenCalledTimes(1);
    });
});
