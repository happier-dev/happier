/**
 * Canonical owner of one in-memory Session data-key preparation pass.
 *
 * Recipient-preparation flows — the current Session's Team/Group audience and a Team/Group
 * membership's eligible history — page bounded server work, seal one page at a time, commit it
 * atomically, and count only what the server committed. That loop, not the crypto, is what they
 * share, so it lives here once instead of being reimplemented per flow. Sealing itself stays with
 * the existing envelope sealer and each host's cooperative batching; this module performs no crypto and
 * holds no key material.
 *
 * The pass is deliberately not durable: no cursor, claim, lease, or attempt count is persisted. A
 * crash or scope switch loses only progress memory, because the next `fetchPage` reconstructs the
 * remaining work from canonical access plus missing/invalid tuples.
 */

export type SessionDataKeyPreparationPage<TItem> = Readonly<{
    /** Actionable work the server returned for this page, already filtered by the resource. */
    items: readonly TItem[];
    nextCursor: string | null;
}>;

export type SessionDataKeyPreparationSeal<TEntry> = Readonly<{
    /** Entries ready to commit, in any order; a page may seal fewer entries than it received. */
    entries: readonly TEntry[];
    /** Items that could not be prepared locally. They are not retried again in this pass. */
    failedItemKeys: readonly string[];
}>;

export type SessionDataKeyPreparationProgress = Readonly<{
    /** Recipients/Sessions the server confirmed it committed. Never a locally sealed count. */
    preparedCount: number;
    pagesCommitted: number;
}>;

export type SessionDataKeyPreparationPassStatus =
    /** No actionable work remained after the one first-page recheck. */
    | 'complete'
    /** Work remains: locally failed items, or work discovered behind the cursor. */
    | 'incomplete'
    /** The captured Home/Account/session scope stopped being current; local writes are suppressed. */
    | 'scope_changed';

export type SessionDataKeyPreparationPassResult = Readonly<{
    status: SessionDataKeyPreparationPassStatus;
    preparedCount: number;
    skippedCount: number;
}>;

const inFlightDetachedPasses = new Map<string, Promise<unknown>>();

/**
 * The single process-local owner for detached recipient-key preparation.
 * Callers provide their collision-safe exact resource identity; this helper
 * owns only in-flight reuse and cleanup, never durable progress or authority.
 */
export function runSessionDataKeyPreparationDetached<TResult>(
    key: string,
    start: () => Promise<TResult>,
): Promise<TResult> {
    const existing = inFlightDetachedPasses.get(key);
    if (existing) return existing as Promise<TResult>;

    const promise = start();
    inFlightDetachedPasses.set(key, promise);
    void promise.finally(() => {
        if (inFlightDetachedPasses.get(key) === promise) inFlightDetachedPasses.delete(key);
    }).catch(() => {});
    return promise;
}

export type SessionDataKeyPreparationPassParams<TItem, TEntry> = Readonly<{
    fetchPage: (cursor: string | null) => Promise<SessionDataKeyPreparationPage<TItem>>;
    /** Stable identity of one unit of work (recipient Account or Session) within this pass. */
    itemKey: (item: TItem) => string;
    prepareEntries: (items: readonly TItem[]) => Promise<SessionDataKeyPreparationSeal<TEntry>>;
    /** Commits one bounded page atomically and returns the server's applied count. */
    commitEntries: (entries: readonly TEntry[]) => Promise<number>;
    /** Captured Home/Account/session/encryption-generation authority, re-asserted at every boundary. */
    isScopeCurrent: () => boolean;
    onProgress?: (progress: SessionDataKeyPreparationProgress) => void;
}>;

type PageOutcome =
    | Readonly<{ kind: 'processed'; actionableCount: number; appliedCount: number }>
    | Readonly<{ kind: 'scope_changed'; appliedCount: number }>;

export async function runSessionDataKeyPreparationPass<TItem, TEntry>(
    params: SessionDataKeyPreparationPassParams<TItem, TEntry>,
): Promise<SessionDataKeyPreparationPassResult> {
    /** Every item this pass already sealed, committed, or failed. Guarantees the pass terminates. */
    const handledItemKeys = new Set<string>();
    const failedItemKeys = new Set<string>();
    let preparedCount = 0;
    let pagesCommitted = 0;

    const processPage = async (page: SessionDataKeyPreparationPage<TItem>): Promise<PageOutcome> => {
        // The page request awaited the network, so the captured authority may already be stale. This
        // guards local sealing and the terminal verdict alike: an empty page proves nothing about
        // the Home the caller has since switched to.
        if (!params.isScopeCurrent()) {
            return { kind: 'scope_changed', appliedCount: 0 };
        }

        const actionable = page.items.filter((item) => !handledItemKeys.has(params.itemKey(item)));
        if (actionable.length === 0) {
            return { kind: 'processed', actionableCount: 0, appliedCount: 0 };
        }

        const seal = await params.prepareEntries(actionable);
        for (const item of actionable) {
            handledItemKeys.add(params.itemKey(item));
        }
        for (const key of seal.failedItemKeys) {
            failedItemKeys.add(key);
        }

        if (seal.entries.length === 0) {
            return { kind: 'processed', actionableCount: actionable.length, appliedCount: 0 };
        }
        // Sealing can take several cooperative chunks; the authority may have changed underneath it.
        if (!params.isScopeCurrent()) {
            return { kind: 'scope_changed', appliedCount: 0 };
        }

        const appliedCount = await params.commitEntries(seal.entries);
        preparedCount += appliedCount;
        pagesCommitted += 1;
        // The page is committed either way; only the local progress write is scope-sensitive.
        if (!params.isScopeCurrent()) {
            return { kind: 'scope_changed', appliedCount };
        }
        params.onProgress?.({ preparedCount, pagesCommitted });
        return { kind: 'processed', actionableCount: actionable.length, appliedCount };
    };

    const scopeChanged = (): SessionDataKeyPreparationPassResult => ({
        status: 'scope_changed',
        preparedCount,
        skippedCount: failedItemKeys.size,
    });

    let cursor: string | null = null;
    let lastPage: SessionDataKeyPreparationPage<TItem> | null = null;
    /** A keyset cursor must strictly advance; a repeated one would otherwise loop forever. */
    const servedCursors = new Set<string>();

    for (;;) {
        if (!params.isScopeCurrent()) return scopeChanged();
        const page: SessionDataKeyPreparationPage<TItem> = await params.fetchPage(cursor);
        lastPage = page;
        const outcome = await processPage(page);
        if (outcome.kind === 'scope_changed') return scopeChanged();

        if (page.nextCursor === null || servedCursors.has(page.nextCursor)) break;
        servedCursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }

    // One final action-required first-page recheck discovers work that appeared behind the cursor
    // and confirms that this pass's own committed work settled. It is processed at most once and
    // its own cursor starts no new traversal.
    //
    // It runs even after an initially empty first page with no writes: work committed concurrently
    // with that first read would otherwise be falsely reported complete. New concurrent work after
    // this bounded recheck waits for the next explicit pass; locally failed items are skipped for
    // this in-memory pass and exposed as retryable user work.
    if (!params.isScopeCurrent()) return scopeChanged();
    const recheck = await params.fetchPage(null);
    lastPage = recheck;
    const outcome = await processPage(recheck);
    if (outcome.kind === 'scope_changed') return scopeChanged();

    if (!params.isScopeCurrent()) return scopeChanged();
    const settled = failedItemKeys.size === 0
        && (lastPage?.items.length ?? 0) === 0
        && (lastPage?.nextCursor ?? null) === null;
    return {
        status: settled ? 'complete' : 'incomplete',
        preparedCount,
        skippedCount: failedItemKeys.size,
    };
}
