import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileBackedTranscriptSessionRegistry } from './FileBackedTranscriptSessionRegistry';
import { buildSessionStoreCacheKey } from './sessionStoreCacheKey';
import type {
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreKey,
    FileBackedTranscriptSessionStoreLifecycleState,
} from './fileBackedTranscriptSessionStoreTypes';

class TestStore implements FileBackedTranscriptSessionStore {
    public readonly lifecycleStates: FileBackedTranscriptSessionStoreLifecycleState[] = [];
    public warmCount = 0;
    public disposeCount = 0;

    constructor(private readonly options?: Readonly<{
        onWarmStart?: () => void;
        warmPromise?: Promise<void>;
    }>) {}

    async warm(): Promise<void> {
        this.warmCount += 1;
        this.options?.onWarmStart?.();
        await this.options?.warmPromise;
    }

    async dispose(): Promise<void> {
        this.disposeCount += 1;
    }

    async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
        this.lifecycleStates.push(state);
    }

    async pageOlder(): Promise<{ items: readonly unknown[]; nextCursor: string | null; hasMore: boolean; tailCursor: string | null; truncated: boolean }> {
        return { items: [], nextCursor: null, hasMore: false, tailCursor: null, truncated: false };
    }

    async readAfter(): Promise<{ items: readonly unknown[]; nextCursor: string | null; truncated: boolean }> {
        return { items: [], nextCursor: null, truncated: false };
    }

    getTailCursor(): string | null {
        return null;
    }

    subscribe(): () => void {
        return () => {};
    }

    async getTitle(): Promise<string | null> {
        return null;
    }

    async getWorkingDirectory(): Promise<string | null> {
        return null;
    }

    async getActivity(): Promise<null> {
        return null;
    }

    async getPreview(): Promise<string | null> {
        return null;
    }
}

function buildKey(overrides?: Partial<FileBackedTranscriptSessionStoreKey>): FileBackedTranscriptSessionStoreKey {
    return {
        providerId: overrides?.providerId ?? 'codex',
        source: overrides?.source ?? { kind: 'codexHome', home: 'user' },
        remoteSessionId: overrides?.remoteSessionId ?? 'session-1',
    };
}

describe('FileBackedTranscriptSessionRegistry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reuses one warmed store per cache key while multiple leases are active', async () => {
        const created: TestStore[] = [];
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => {
                const store = new TestStore();
                created.push(store);
                return store;
            },
        });

        const lease1 = await registry.acquire(buildKey());
        const lease2 = await registry.acquire(buildKey());

        expect(created).toHaveLength(1);
        expect(lease1.store).toBe(lease2.store);
        expect(created[0]?.warmCount).toBe(1);
        expect(created[0]?.lifecycleStates).toEqual(['hot_attached']);

        await lease1.release();
        await lease2.release();
    });

    it('exposes getOrCreate as the canonical registry API alias', async () => {
        const created: TestStore[] = [];
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => {
                const store = new TestStore();
                created.push(store);
                return store;
            },
        });

        const lease = await registry.getOrCreate(buildKey());

        expect(created).toHaveLength(1);
        expect(lease.store).toBe(created[0]);

        await lease.release();
    });

    it('supports warm leases that do not hot-attach until a later active acquire', async () => {
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => new TestStore(),
        });

        const warmLease = await registry.acquire(buildKey(), { hotAttach: false });
        const store = warmLease.store as TestStore;
        expect(store.lifecycleStates).toEqual([]);

        await warmLease.release();

        const activeLease = await registry.acquire(buildKey());
        expect(activeLease.store).toBe(store);
        expect(store.lifecycleStates).toEqual(['hot_attached']);

        await activeLease.release();
    });

    it('transitions detached stores through warm_detached and cold_idle after the configured timers', async () => {
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => new TestStore(),
        });

        const lease = await registry.acquire(buildKey());
        const store = lease.store as TestStore;
        await lease.release();

        await vi.advanceTimersByTimeAsync(100);
        expect(store.lifecycleStates).toEqual(['hot_attached', 'warm_detached']);

        await vi.advanceTimersByTimeAsync(200);
        expect(store.lifecycleStates).toEqual(['hot_attached', 'warm_detached', 'cold_idle']);
    });

    it('cancels a pending detach transition when the same store is reattached before the grace window expires', async () => {
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => new TestStore(),
        });

        const firstLease = await registry.acquire(buildKey());
        const store = firstLease.store as TestStore;
        await firstLease.release();

        await vi.advanceTimersByTimeAsync(50);
        const secondLease = await registry.acquire(buildKey());

        await vi.advanceTimersByTimeAsync(75);
        expect(store.lifecycleStates).toEqual(['hot_attached', 'hot_attached']);

        await secondLease.release();
    });

    it('disposes stores and clears the registry on disposeAll', async () => {
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => new TestStore(),
        });

        const key = buildKey();
        const lease = await registry.acquire(key);
        const store = lease.store as TestStore;
        await lease.release();

        await registry.disposeAll();

        expect(store.disposeCount).toBe(1);
        expect(registry.get(buildSessionStoreCacheKey(key))).toBeNull();
    });

    it('does not create duplicate stores when the first acquire races concurrently for the same key', async () => {
        let resolveCreate!: (store: TestStore) => void;
        const createStorePromise = new Promise<TestStore>((resolve) => {
            resolveCreate = resolve;
        });
        const createStore = vi.fn(async () => await createStorePromise);
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore,
        });

        const firstAcquire = registry.acquire(buildKey());
        const secondAcquire = registry.acquire(buildKey());

        expect(createStore).toHaveBeenCalledTimes(1);

        const sharedStore = new TestStore();
        resolveCreate(sharedStore);

        const [firstLease, secondLease] = await Promise.all([firstAcquire, secondAcquire]);

        expect(firstLease.store).toBe(sharedStore);
        expect(secondLease.store).toBe(sharedStore);
        expect(sharedStore.warmCount).toBe(1);

        await firstLease.release();
        await secondLease.release();
    });

    it('rejects a pending acquire and disposes the store when disposeAll runs before warm completes', async () => {
        let resolveWarm!: () => void;
        let markWarmStarted!: () => void;
        const warmPromise = new Promise<void>((resolve) => {
            resolveWarm = resolve;
        });
        const warmStarted = new Promise<void>((resolve) => {
            markWarmStarted = resolve;
        });
        const store = new TestStore({
            onWarmStart: markWarmStarted,
            warmPromise,
        });
        const key = buildKey();
        const registry = new FileBackedTranscriptSessionRegistry({
            detachedGraceMs: 100,
            coldIdleMs: 200,
            createStore: async () => store,
        });

        const acquirePromise = registry.acquire(key);
        await warmStarted;

        const disposeAllPromise = registry.disposeAll();
        resolveWarm();

        await disposeAllPromise;
        await expect(acquirePromise).rejects.toThrow(/disposed/i);
        expect(store.disposeCount).toBe(1);
        expect(registry.get(buildSessionStoreCacheKey(key))).toBeNull();
    });
});
