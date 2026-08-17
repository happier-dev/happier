/**
 * Coalesces concurrent scoped resolutions that share identical inputs.
 *
 * The scoped data-key caches are read-await-write: a synchronous cache read, then an
 * awaited fetch plus an asymmetric envelope open, then a cache write. Nothing sits
 * between the read and the write, so a burst of concurrent callers all miss, all fetch
 * and all unwrap the same key. That is the shape the new-session screen produces: its
 * capability preflights fan out ~8-10 machine RPCs at once, and every one of them
 * resolves the same target machine data key before it can talk to the machine.
 *
 * A larger cache cannot fix that — the entries do not exist yet while the burst is in
 * flight. De-duplication does, provided the coalescing key fully determines the result:
 * a joiner must never adopt a result computed for different inputs.
 *
 * ONLY wrap work that is guaranteed to settle. A retained entry is shared by every later
 * caller for that key, so a resolution that can hang forever becomes a permanent poison
 * pill for it. Both data-key fetches qualify: each is bounded by its own reachability
 * wait, request timeout and abort signal, and its catch returns a value rather than
 * hanging. An unbounded read — stored credentials, for instance — does not.
 */
export type ScopedResolutionSingleFlight<T> = Readonly<{
    /**
     * Runs `resolve` for `key`, or joins the resolution already in flight for that exact
     * key. The entry is released as soon as it settles, so neither a rejection nor a
     * negative result is ever retained for a later caller.
     */
    run: (key: string, resolve: () => Promise<T>) => Promise<T>;
    reset: () => void;
}>;

export function createScopedResolutionSingleFlight<T>(): ScopedResolutionSingleFlight<T> {
    const inFlightByKey = new Map<string, Promise<T>>();

    return {
        async run(key: string, resolve: () => Promise<T>): Promise<T> {
            const existing = inFlightByKey.get(key);
            if (existing) {
                return await existing;
            }

            const pending = (async () => await resolve())();
            inFlightByKey.set(key, pending);
            try {
                return await pending;
            } finally {
                if (inFlightByKey.get(key) === pending) {
                    inFlightByKey.delete(key);
                }
            }
        },
        reset(): void {
            inFlightByKey.clear();
        },
    };
}
