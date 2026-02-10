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
    const actual = await vi.importActual<any>('react-native');
    return {
        ...actual,
        Platform: { ...(actual?.Platform ?? {}), OS: 'web' },
        AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) as any },
    };
});

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./api/social/apiFriends', () => ({
    getUserProfile: vi.fn(),
}));

import { storage } from './domains/state/storage';
import { getUserProfile } from './api/social/apiFriends';

const initialStorageState = storage.getState();

describe('sync.assumeUsers', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        kvStore.clear();

        const { sync } = await import('./sync');
        (sync as any).credentials = { token: 'test-token', secret: 'test-secret' };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not cache null when user fetch throws a transient error', async () => {
        (getUserProfile as any).mockRejectedValueOnce(new Error('boom'));

        const { sync } = await import('./sync');
        await sync.assumeUsers(['user_transient']);

        expect(storage.getState().users.user_transient).toBeUndefined();
    });

    it('caches null when user fetch returns null (not found)', async () => {
        (getUserProfile as any).mockResolvedValueOnce(null);

        const { sync } = await import('./sync');
        await sync.assumeUsers(['user_missing']);

        expect(storage.getState().users.user_missing).toBeNull();
    });

    it('caches null when user fetch throws a 404-shaped error', async () => {
        (getUserProfile as any).mockRejectedValueOnce({ status: 404 });

        const { sync } = await import('./sync');
        await sync.assumeUsers(['user_404']);

        expect(storage.getState().users.user_404).toBeNull();
    });
});

