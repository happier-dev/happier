/**
 * FR4-12 — Explicit cache adapter seam for cross-mount dynamic section caching.
 *
 * Background:
 *   `useSelectionListDynamicSections` historically depended on a module-level
 *   LRU `Map` to preserve last-successful options across remounts so reopening
 *   a path popover didn't flicker through an empty body before the resolver
 *   completed. That implicit global state forced production code to export
 *   test-only reset/inspect hooks (`__resetDynamicSectionCacheForTests`,
 *   `__getDynamicSectionCacheSizeForTests`) and made every future consumer
 *   depend on an undocumented global.
 *
 * This module replaces the implicit global with an explicit
 * `SelectionListDynamicSectionCache` adapter:
 *   - Production callers receive a singleton instance from
 *     `getDefaultDynamicSectionCache()` for back-compat (zero behavior change).
 *   - Tests instantiate an isolated cache via `createTestDynamicSectionCache()`
 *     to eliminate ordering risk and avoid touching production globals.
 *   - Callers can inject a custom cache via the hook's optional `cache` prop.
 *
 * Invariants:
 *   - Successful resolves write to the cache. Aborted in-flight resolves MUST
 *     NOT poison the cache (the in-progress write is gated by a mount + sequence
 *     guard in the hook itself).
 *   - LRU eviction with a configurable cap (default 64); access promotes the
 *     entry to the head (Map insertion order is the LRU order).
 */

import type { SelectionListOption } from './_types';

const DEFAULT_DYNAMIC_SECTION_CACHE_CAP = 64;

export type SelectionListDynamicSectionCache = Readonly<{
    /** Read an entry. Promotes the entry to the MRU end on hit. */
    get(key: string): ReadonlyArray<SelectionListOption> | undefined;
    /** Write an entry. Promotes to the MRU end and evicts the oldest if over cap. */
    set(key: string, value: ReadonlyArray<SelectionListOption>): void;
    /** Remove a single entry. */
    delete(key: string): void;
    /** Empty the cache (used by tests). */
    clear(): void;
    /** Number of entries currently held. */
    size(): number;
}>;

export function buildDynamicSectionCacheKey(
    id: string,
    resolverKey: string | undefined,
    seed: string,
): string {
    return `${id}::${resolverKey ?? id}::${seed}`;
}

/**
 * Construct an LRU-backed cache. Each call returns a fresh, isolated instance.
 *
 * @param options.maxEntries - Cap (default 64). Values <= 0 fall back to default.
 */
export function createDefaultDynamicSectionCache(
    options?: Readonly<{ maxEntries?: number }>,
): SelectionListDynamicSectionCache {
    const cap = options?.maxEntries !== undefined && options.maxEntries > 0
        ? options.maxEntries
        : DEFAULT_DYNAMIC_SECTION_CACHE_CAP;
    const store = new Map<string, ReadonlyArray<SelectionListOption>>();

    return {
        get(key) {
            const value = store.get(key);
            if (value === undefined) return undefined;
            // LRU promotion: re-insert so the entry becomes MRU.
            store.delete(key);
            store.set(key, value);
            return value;
        },
        set(key, value) {
            if (store.has(key)) store.delete(key);
            store.set(key, value);
            while (store.size > cap) {
                // Map iteration is insertion order: first key is the oldest.
                const oldest = store.keys().next().value;
                if (oldest === undefined) break;
                store.delete(oldest);
            }
        },
        delete(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        },
        size() {
            return store.size;
        },
    };
}

/**
 * Construct a fully isolated cache for tests. Functionally identical to
 * `createDefaultDynamicSectionCache` but spelled separately so tests advertise
 * intent at the call site (and so a future change can diverge the impl, e.g.
 * tracking writes for assertions, without breaking production semantics).
 */
export function createTestDynamicSectionCache(
    options?: Readonly<{ maxEntries?: number }>,
): SelectionListDynamicSectionCache {
    return createDefaultDynamicSectionCache(options);
}

// ─── Module-level singleton ──────────────────────────────────────────────────
// Back-compat: when callers don't pass an explicit `cache` prop, the hook
// reaches for this singleton so existing production behavior is preserved.

let defaultCacheInstance: SelectionListDynamicSectionCache | null = null;

export function getDefaultDynamicSectionCache(): SelectionListDynamicSectionCache {
    if (defaultCacheInstance === null) {
        defaultCacheInstance = createDefaultDynamicSectionCache();
    }
    return defaultCacheInstance;
}

/**
 * Test-only: reset the singleton between specs. Prefer
 * `createTestDynamicSectionCache()` + injection over relying on this.
 */
export function __resetDefaultDynamicSectionCacheForTests(): void {
    defaultCacheInstance?.clear();
    defaultCacheInstance = null;
}
