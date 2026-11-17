import { PresentedAutoRefresh, type PresentedAutoRefreshDemand } from '@/utils/runtime/presentedAutoRefresh';

/** The selected Activity Resource supplies its existing read; this owner adds no query or transport. */
export type DatabaseActivityResource<T> = Readonly<{
    read(options: Readonly<{ signal: AbortSignal }>): Promise<T>;
}>;

export type DatabaseActivitySnapshot<T> = Readonly<{
    value: T | null;
    loading: boolean;
    /** Preserve the Resource's typed failure instead of replacing it with an unavailable reason. */
    error: unknown;
}>;

/** One controller belongs to one selected Activity Resource, shared by its presented consumers. */
export function createDatabaseActivityController<T>(resource: DatabaseActivityResource<T>) {
    let snapshot: DatabaseActivitySnapshot<T> = { value: null, loading: false, error: null };
    const listeners = new Set<() => void>();
    let pending: { abort: AbortController; promise: Promise<void> } | null = null;
    const publish = (next: DatabaseActivitySnapshot<T>) => {
        if (snapshot.value === next.value && snapshot.loading === next.loading && snapshot.error === next.error) return;
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const refresh = (): Promise<void> => {
        if (!scheduler.hasDemand('activity')) return Promise.resolve();
        if (pending) return pending.promise;
        const abort = new AbortController();
        // Defer entry until pending is installed so a subscriber's synchronous Refresh joins it too.
        const promise = Promise.resolve().then(async () => {
            try {
                if (abort.signal.aborted) return;
                const value = await resource.read({ signal: abort.signal });
                if (!abort.signal.aborted) publish({ value, loading: false, error: null });
            } catch (error) {
                if (!abort.signal.aborted) publish({ ...snapshot, loading: false, error });
            } finally {
                pending = null;
            }
        });
        pending = { abort, promise };
        publish({ ...snapshot, loading: true });
        return promise;
    };
    const scheduler = new PresentedAutoRefresh<PresentedAutoRefreshDemand, T | null>(() => ({
        key: 'activity',
        read: async () => {
            await refresh();
            return snapshot.value;
        },
    }), { requireWindowFocus: false, intervalFromStart: true });
    const cancel = () => {
        pending?.abort.abort();
        publish({ ...snapshot, loading: false });
    };
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        refresh,
        invalidate: () => { if (scheduler.hasDemand('activity')) void refresh(); },
        dispose: () => { scheduler.dispose(); cancel(); },
        retainAutoRefresh: (demand: Readonly<{ intervalMs: number }>) => {
            const release = scheduler.retain(demand);
            let retained = true;
            return () => {
                if (!retained) return;
                retained = false;
                release();
                if (!scheduler.hasDemand('activity')) cancel();
            };
        },
    };
}

export type DatabaseActivityController<T> = ReturnType<typeof createDatabaseActivityController<T>>;
