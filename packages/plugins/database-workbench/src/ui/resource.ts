export type ResourceSnapshot<T> = Readonly<{ status: 'loading' | 'ready' | 'failed'; data?: T; error?: unknown }>;
/** One demanded resource. Hiding/revealing its consumer does not change its answer. */
export function createResource<T>(load: () => Promise<T>) {
    let state: ResourceSnapshot<T> = { status: 'loading' };
    let pending: Promise<void> | undefined;
    let loaded = false;
    let disposed = false;
    const listeners = new Set<() => void>();
    const publish = (next: ResourceSnapshot<T>) => { state = next; for (const listener of listeners) listener(); };
    function demand(): Promise<void> {
        if (disposed) return Promise.resolve();
        if (pending) return pending;
        if (loaded) return Promise.resolve();
        const request = Promise.resolve().then(load).then(data => {
            if (pending === request) { loaded = true; publish({ status: 'ready', data }); }
        }, error => {
            if (pending === request) { loaded = true; publish({ status: 'failed', ...(state.data === undefined ? {} : { data: state.data }), error }); }
        });
        pending = request;
        return request;
    }
    return {
        get: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        demand,
        dispose() { if (disposed) return; disposed = true; pending = undefined; publish({ status: 'loading' }); listeners.clear(); },
        invalidate() { if (disposed) return; loaded = false; pending = undefined; if (listeners.size) void demand(); },
    };
}
export type WorkbenchResource<T> = ReturnType<typeof createResource<T>>;
