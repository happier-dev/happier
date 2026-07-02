/**
 * Shared, pure helpers for the rich markdown editor's caches.
 *
 * Extracted to remove the duplicated content-hash + bounded-FIFO-cache logic
 * that previously lived in both `markdownRichEligibility.ts` (eligibility cache)
 * and `core/tiptap/markdownRoundTrip.web.ts` (round-trip cache). Centralizing it
 * keeps the cache-key hashing identical across both so a change to one can never
 * silently diverge from the other (R4-style "change both together" hazard).
 *
 * PURE — NO `@tiptap/*` import (R18). Safe to import from the native graph and
 * from the `core/tiptap/` (web-only) round-trip alike.
 */

/**
 * Cheap deterministic string hash (djb2-xor), returned as a base36 string.
 *
 * Used purely for cache keying — it is NOT a cryptographic hash. The algorithm
 * must stay stable so cached results remain addressable across calls.
 */
export function hashContent(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}

/**
 * A minimal bounded cache with first-in-first-out eviction.
 *
 * Backed by a `Map` (insertion-ordered), it evicts the oldest inserted entry
 * once `set` would push the size past `maxEntries`. Overwriting an existing key
 * does not change its insertion position relative to eviction in our usage
 * (callers only `set` a key once), matching the prior inline behavior.
 */
export type BoundedFifoCache<V> = Readonly<{
    has: (key: string) => boolean;
    get: (key: string) => V | undefined;
    set: (key: string, value: V) => V;
}>;

/**
 * Creates a {@link BoundedFifoCache} that holds at most `maxEntries` entries.
 */
export function createBoundedFifoCache<V>(maxEntries: number): BoundedFifoCache<V> {
    const store = new Map<string, V>();

    return {
        has: (key: string) => store.has(key),
        get: (key: string) => store.get(key),
        set: (key: string, value: V) => {
            store.set(key, value);
            while (store.size > maxEntries) {
                const oldest = store.keys().next().value;
                if (typeof oldest !== 'string') {
                    break;
                }
                store.delete(oldest);
            }
            return value;
        },
    };
}
