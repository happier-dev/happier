import {
    type FileBackedTranscriptSessionLease,
    type FileBackedTranscriptSessionStore,
    type FileBackedTranscriptSessionStoreFactory,
    type FileBackedTranscriptSessionStoreKey,
} from './fileBackedTranscriptSessionStoreTypes';
import { buildSessionStoreCacheKey } from './sessionStoreCacheKey';

type RegistryEntry<TStore extends FileBackedTranscriptSessionStore> = {
    key: FileBackedTranscriptSessionStoreKey;
    store: TStore;
    leaseCount: number;
    detachTimer: ReturnType<typeof setTimeout> | null;
    coldTimer: ReturnType<typeof setTimeout> | null;
    disposed: boolean;
};

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer) {
        clearTimeout(timer);
    }
}

export class FileBackedTranscriptSessionRegistry<TStore extends FileBackedTranscriptSessionStore = FileBackedTranscriptSessionStore> {
    private readonly entries = new Map<string, RegistryEntry<TStore>>();

    constructor(private readonly options: Readonly<{
        detachedGraceMs: number;
        coldIdleMs: number;
        createStore: FileBackedTranscriptSessionStoreFactory<TStore>;
    }>) {}

    get(cacheKey: string): TStore | null {
        return this.entries.get(cacheKey)?.store ?? null;
    }

    async getOrCreate(key: FileBackedTranscriptSessionStoreKey): Promise<FileBackedTranscriptSessionLease<TStore>> {
        return this.acquire(key);
    }

    async acquire(key: FileBackedTranscriptSessionStoreKey): Promise<FileBackedTranscriptSessionLease<TStore>> {
        const cacheKey = buildSessionStoreCacheKey(key);
        let entry = this.entries.get(cacheKey) ?? null;

        if (!entry) {
            const store = await this.options.createStore(key);
            await store.warm();
            entry = {
                key,
                store,
                leaseCount: 0,
                detachTimer: null,
                coldTimer: null,
                disposed: false,
            };
            this.entries.set(cacheKey, entry);
        }

        const wasDetached = entry.leaseCount === 0;
        clearTimer(entry.detachTimer);
        clearTimer(entry.coldTimer);
        entry.detachTimer = null;
        entry.coldTimer = null;
        entry.leaseCount += 1;

        if (wasDetached) {
            await entry.store.setLifecycleState('hot_attached');
        }

        let released = false;
        return {
            key,
            store: entry.store,
            release: async () => {
                if (released) return;
                released = true;
                await this.release(cacheKey, entry!);
            },
        };
    }

    async disposeAll(): Promise<void> {
        const entries = Array.from(this.entries.entries());
        this.entries.clear();
        await Promise.all(entries.map(async ([, entry]) => {
            if (entry.disposed) return;
            entry.disposed = true;
            clearTimer(entry.detachTimer);
            clearTimer(entry.coldTimer);
            await entry.store.dispose();
        }));
    }

    private async release(cacheKey: string, entry: RegistryEntry<TStore>): Promise<void> {
        if (entry.disposed) return;
        if (entry.leaseCount > 0) {
            entry.leaseCount -= 1;
        }
        if (entry.leaseCount > 0) return;

        clearTimer(entry.detachTimer);
        clearTimer(entry.coldTimer);

        entry.detachTimer = setTimeout(() => {
            void this.transitionToWarmDetached(cacheKey, entry);
        }, Math.max(0, this.options.detachedGraceMs));
    }

    private async transitionToWarmDetached(cacheKey: string, entry: RegistryEntry<TStore>): Promise<void> {
        if (entry.disposed || entry.leaseCount > 0) return;
        entry.detachTimer = null;
        await entry.store.setLifecycleState('warm_detached');
        entry.coldTimer = setTimeout(() => {
            void this.transitionToColdIdle(cacheKey, entry);
        }, Math.max(0, this.options.coldIdleMs));
    }

    private async transitionToColdIdle(cacheKey: string, entry: RegistryEntry<TStore>): Promise<void> {
        if (entry.disposed || entry.leaseCount > 0) return;
        entry.coldTimer = null;
        await entry.store.setLifecycleState('cold_idle');
        if (this.entries.get(cacheKey) === entry) {
            this.entries.delete(cacheKey);
        }
    }
}
