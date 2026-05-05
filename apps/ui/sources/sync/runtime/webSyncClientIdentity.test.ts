import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebSyncClientIdentity } from './webSyncClientIdentity';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('resolveWebSyncClientIdentity', () => {
    it('uses a stored session candidate when no live collision exists', () => {
        const sessionStorage = new MemoryStorage();
        const localStorage = new MemoryStorage();
        sessionStorage.setItem('happier-sync-instance-id-v1', 'tab-a');

        const identity = resolveWebSyncClientIdentity({
            sessionStorage,
            localStorage,
            nowMs: 1_000,
            liveTtlMs: 45_000,
            randomUUID: () => 'new-id',
            ownerToken: 'owner-a',
        });

        expect(identity.instanceId).toBe('tab-a');
        expect(JSON.parse(localStorage.getItem('happier-sync-live-instances-v1') ?? '{}')).toMatchObject({
            'tab-a': { ownerToken: 'owner-a', lastSeenMs: 1_000 },
        });
    });

    it('rerolls a copied session candidate when another live owner has it', () => {
        const sessionStorage = new MemoryStorage();
        const localStorage = new MemoryStorage();
        sessionStorage.setItem('happier-sync-instance-id-v1', 'tab-a');
        localStorage.setItem(
            'happier-sync-live-instances-v1',
            JSON.stringify({ 'tab-a': { ownerToken: 'other-owner', lastSeenMs: 900 } }),
        );

        const identity = resolveWebSyncClientIdentity({
            sessionStorage,
            localStorage,
            nowMs: 1_000,
            liveTtlMs: 45_000,
            randomUUID: () => 'tab-b',
            ownerToken: 'owner-b',
        });

        expect(identity.instanceId).toBe('tab-b');
        expect(sessionStorage.getItem('happier-sync-instance-id-v1')).toBe('tab-b');
        expect(JSON.parse(localStorage.getItem('happier-sync-live-instances-v1') ?? '{}')).toMatchObject({
            'tab-a': { ownerToken: 'other-owner', lastSeenMs: 900 },
            'tab-b': { ownerToken: 'owner-b', lastSeenMs: 1_000 },
        });
    });

    it('reuses an expired candidate and updates its heartbeat owner', () => {
        const sessionStorage = new MemoryStorage();
        const localStorage = new MemoryStorage();
        sessionStorage.setItem('happier-sync-instance-id-v1', 'tab-a');
        localStorage.setItem(
            'happier-sync-live-instances-v1',
            JSON.stringify({ 'tab-a': { ownerToken: 'old-owner', lastSeenMs: 1_000 } }),
        );

        const identity = resolveWebSyncClientIdentity({
            sessionStorage,
            localStorage,
            nowMs: 100_000,
            liveTtlMs: 45_000,
            randomUUID: () => 'tab-b',
            ownerToken: 'owner-a',
        });

        expect(identity.instanceId).toBe('tab-a');
        expect(JSON.parse(localStorage.getItem('happier-sync-live-instances-v1') ?? '{}')).toMatchObject({
            'tab-a': { ownerToken: 'owner-a', lastSeenMs: 100_000 },
        });
    });

    it('keeps the same live instance identity on same-tab reloads', () => {
        const sessionStorage = new MemoryStorage();
        const localStorage = new MemoryStorage();
        sessionStorage.setItem('happier-sync-instance-id-v1', 'tab-a');
        localStorage.setItem(
            'happier-sync-live-instances-v1',
            JSON.stringify({ 'tab-a': { ownerToken: 'owner-live', lastSeenMs: 900 } }),
        );
        vi.stubGlobal('performance', {
            getEntriesByType: (entryType: string) => entryType === 'navigation'
                ? [{ type: 'reload' }]
                : [],
        });

        const identity = resolveWebSyncClientIdentity({
            sessionStorage,
            localStorage,
            nowMs: 1_000,
            liveTtlMs: 45_000,
            randomUUID: () => 'new-id',
        });

        expect(identity.instanceId).toBe('tab-a');
        expect(JSON.parse(localStorage.getItem('happier-sync-live-instances-v1') ?? '{}')).toMatchObject({
            'tab-a': { ownerToken: 'owner-live', lastSeenMs: 1_000 },
        });
    });
});
