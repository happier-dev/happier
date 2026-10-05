import { describe, expect, it, vi } from 'vitest';

import {
    runSessionDataKeyPreparationPass,
    type SessionDataKeyPreparationPage,
    type SessionDataKeyPreparationSeal,
} from './sessionDataKeyPreparationPass.js';

type TestItem = Readonly<{ id: string }>;
type TestEntry = Readonly<{ id: string; sealed: string }>;

function page(items: readonly string[], nextCursor: string | null): SessionDataKeyPreparationPage<TestItem> {
    return { items: items.map((id) => ({ id })), nextCursor };
}

function sealAll(items: readonly TestItem[]): SessionDataKeyPreparationSeal<TestEntry> {
    return {
        entries: items.map((item) => ({ id: item.id, sealed: `sealed:${item.id}` })),
        failedItemKeys: [],
    };
}

/** Serves one scripted response per call so a first-page recheck differs from the first fetch. */
function scriptedPages(responses: ReadonlyArray<SessionDataKeyPreparationPage<TestItem>>) {
    let call = 0;
    return vi.fn(async (_cursor: string | null) => {
        const response = responses[Math.min(call, responses.length - 1)]!;
        call += 1;
        return response;
    });
}

describe('runSessionDataKeyPreparationPass', () => {
    it('follows the cursor, seals each page once, and counts only committed entries', async () => {
        const fetchPage = scriptedPages([
            page(['a', 'b'], 'cursor-1'),
            page(['c'], null),
            page([], null),
        ]);
        const prepareEntries = vi.fn(async (items: readonly TestItem[]) => sealAll(items));
        const commitEntries = vi.fn(async (entries: readonly TestEntry[]) => entries.length);
        const onProgress = vi.fn();

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries,
            commitEntries,
            isScopeCurrent: () => true,
            onProgress,
        });

        expect(result).toEqual({ status: 'complete', preparedCount: 3, skippedCount: 0 });
        // Two work pages plus exactly one final first-page recheck.
        expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'cursor-1', null]);
        // One sealing call per page carrying every item: never one request per recipient/session.
        expect(prepareEntries).toHaveBeenCalledTimes(2);
        expect(prepareEntries.mock.calls[0]![0]).toHaveLength(2);
        expect(onProgress.mock.calls.map(([progress]) => progress.preparedCount)).toEqual([2, 3]);
    });

    it('reports the server applied count rather than the number of entries it sealed', async () => {
        const onProgress = vi.fn();

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => page(['a', 'b', 'c'], null),
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            // A concurrent manager already prepared one of them; the page commits two.
            commitEntries: async () => 2,
            isScopeCurrent: () => true,
            onProgress,
        });

        expect(result.preparedCount).toBe(2);
        expect(onProgress).toHaveBeenCalledWith({ preparedCount: 2, pagesCommitted: 1 });
    });

    it('suppresses the commit and progress when the captured scope stops being current before PATCH', async () => {
        let scopeCurrent = true;
        const commitEntries = vi.fn(async (entries: readonly TestEntry[]) => entries.length);
        const onProgress = vi.fn();

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => page(['a'], null),
            itemKey: (item) => item.id,
            prepareEntries: async (items) => {
                // The Home/account switch lands while this page is being sealed.
                scopeCurrent = false;
                return sealAll(items);
            },
            commitEntries,
            isScopeCurrent: () => scopeCurrent,
            onProgress,
        });

        expect(result).toEqual({ status: 'scope_changed', preparedCount: 0, skippedCount: 0 });
        expect(commitEntries).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('suppresses the progress write when the scope stops being current after a committed page', async () => {
        let scopeCurrent = true;
        const onProgress = vi.fn();

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => page(['a'], 'cursor-1'),
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => {
                scopeCurrent = false;
                return entries.length;
            },
            isScopeCurrent: () => scopeCurrent,
            onProgress,
        });

        expect(result.status).toBe('scope_changed');
        // The page really committed on the server, so it is not lost work; only the local write is.
        expect(result.preparedCount).toBe(1);
        expect(onProgress).not.toHaveBeenCalled();
    });

    it('skips locally failed items for the rest of the pass so the final recheck cannot loop on them', async () => {
        const fetchPage = scriptedPages([
            page(['a', 'b'], 'cursor-1'),
            page([], null),
            // `a` could not be sealed locally, so the server still reports it as action-required.
            page(['a'], null),
        ]);
        const prepareEntries = vi.fn(async (items: readonly TestItem[]) => ({
            entries: items.filter((item) => item.id !== 'a').map((item) => ({ id: item.id, sealed: 'x' })),
            failedItemKeys: items.filter((item) => item.id === 'a').map((item) => item.id),
        }));

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries,
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        expect(result).toEqual({ status: 'incomplete', preparedCount: 1, skippedCount: 1 });
        // The recheck page holds only the failed item, so there is nothing left to seal.
        expect(prepareEntries).toHaveBeenCalledTimes(1);
    });

    it('processes the first-page recheck at most once and does not follow its cursor', async () => {
        const fetchPage = scriptedPages([
            page(['a'], 'cursor-1'),
            page([], null),
            // Work that appeared behind the cursor, still advertising more pages.
            page(['late'], 'cursor-2'),
        ]);

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'cursor-1', null]);
        // The recheck page committed, and its own `nextCursor` starts no new traversal.
        expect(result.preparedCount).toBe(2);
        expect(result.status).toBe('incomplete');
    });

    it('stops instead of looping when the server repeats a cursor it already served', async () => {
        const fetchPage = vi.fn(async () => page(['a'], 'cursor-1'));

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(3);
        // `a` is handled exactly once even though every page repeats it.
        expect(result.preparedCount).toBe(1);
        expect(result.status).toBe('incomplete');
    });

    it('rechecks the first page even when the initial page was empty and nothing was written', async () => {
        const fetchPage = scriptedPages([
            // Nothing actionable was visible when the pass started.
            page([], null),
            // A grant committed concurrently with that first read becomes visible only here.
            page(['late'], null),
            page([], null),
        ]);
        const commitEntries = vi.fn(async (entries: readonly TestEntry[]) => entries.length);

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries,
            isScopeCurrent: () => true,
        });

        // An empty first page proves only what the Home saw at that instant, so the one
        // bounded recheck still runs; otherwise concurrent work is reported as complete.
        expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, null]);
        expect(commitEntries).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: 'incomplete', preparedCount: 1, skippedCount: 0 });
    });

    it('performs the empty-page recheck exactly once and settles complete when it is still empty', async () => {
        const fetchPage = vi.fn(async () => page([], null));

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        expect(fetchPage).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ status: 'complete', preparedCount: 0, skippedCount: 0 });
    });

    it('rechecks the first page after a single-page commit and reports complete when nothing remains', async () => {
        const fetchPage = scriptedPages([
            // All the initial work fits one page, so the pass never follows a cursor.
            page(['a', 'b'], null),
            page([], null),
        ]);

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        // Committing the only page is exactly when the final action-required recheck is required:
        // without it the pass can never observe that its own work settled.
        expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, null]);
        expect(result).toEqual({ status: 'complete', preparedCount: 2, skippedCount: 0 });
    });

    it('reports incomplete when the recheck after a single-page commit finds work behind the cursor', async () => {
        const fetchPage = scriptedPages([
            page(['a'], null),
            // Concurrent work landed while the first page was being sealed and committed.
            page(['late'], null),
        ]);
        const prepareEntries = vi.fn(async (items: readonly TestItem[]) => sealAll(items));

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage,
            itemKey: (item) => item.id,
            prepareEntries,
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });

        // The recheck page is bounded work that is prepared once; it starts no new traversal, so
        // the pass cannot claim the newly discovered work settled.
        expect(prepareEntries).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ status: 'incomplete', preparedCount: 2, skippedCount: 0 });
    });

    it('does not start local sealing when the scope changed while the page request was in flight', async () => {
        let scopeCurrent = true;
        const prepareEntries = vi.fn(async (items: readonly TestItem[]) => sealAll(items));

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => {
                // The Home/account switch lands while the page request is awaiting the network.
                scopeCurrent = false;
                return page(['a'], null);
            },
            itemKey: (item) => item.id,
            prepareEntries,
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => scopeCurrent,
        });

        expect(result.status).toBe('scope_changed');
        expect(prepareEntries).not.toHaveBeenCalled();
    });

    it('does not report complete for an empty page fetched under a scope that already changed', async () => {
        let scopeCurrent = true;

        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => {
                scopeCurrent = false;
                return page([], null);
            },
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => scopeCurrent,
        });

        // "No work for the Home I just left" is not evidence that the current Home is settled.
        expect(result.status).toBe('scope_changed');
    });
    it('reports remaining work when the final page still advertises a committed item', async () => {
        const result = await runSessionDataKeyPreparationPass<TestItem, TestEntry>({
            fetchPage: async () => page(['a'], null),
            itemKey: (item) => item.id,
            prepareEntries: async (items) => sealAll(items),
            commitEntries: async (entries) => entries.length,
            isScopeCurrent: () => true,
        });
        // A tuple can become action-required again during the pass. Do not retry it forever,
        // but do not claim the server's remaining work disappeared merely because we handled it.
        expect(result).toEqual({ status: 'incomplete', preparedCount: 1, skippedCount: 0 });
    });

});
