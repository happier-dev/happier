export type ResourceSnapshot<T> = Readonly<{ status: 'loading' | 'ready' | 'failed'; data?: T; error?: unknown }>;
/** One demanded resource. Hiding/revealing its consumer does not change its answer. */
export function createResource<T>(load: () => Promise<T>, equivalent?: (previous: T, next: T) => boolean) {
    let state: ResourceSnapshot<T> = { status: 'loading' };
    // Keep the current request through settlement so a reveal reuses its answer.
    let request: Promise<void> | undefined;
    let disposed = false;
    const listeners = new Set<() => void>();
    const publish = (next: ResourceSnapshot<T>) => { state = next; for (const listener of listeners) listener(); };
    function publishReady(data: T) {
        if (equivalent && state.status === 'ready' && state.data !== undefined && equivalent(state.data, data)) return;
        publish({ status: 'ready', data });
    }
    function demand(): Promise<void> {
        if (disposed) return Promise.resolve();
        if (request) return request;
        const next = Promise.resolve().then(load).then(data => {
            if (request === next) publishReady(data);
        }, error => {
            if (request === next) publish({ status: 'failed', ...(state.data === undefined ? {} : { data: state.data }), error });
        });
        request = next;
        return next;
    }
    return {
        get: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        demand,
        accept(data: T) {
            if (disposed) return;
            request = Promise.resolve();
            publishReady(data);
        },
        dispose() { if (disposed) return; disposed = true; request = undefined; publish({ status: 'loading' }); listeners.clear(); },
        invalidate() { if (disposed) return; request = undefined; if (listeners.size) void demand(); },
    };
}
export type WorkbenchResource<T> = ReturnType<typeof createResource<T>>;
