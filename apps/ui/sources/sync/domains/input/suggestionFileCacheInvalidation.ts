import type { FileSuggestionScope } from '@/sync/domains/input/fileSuggestionScope';

type SuggestionFileSearchCacheClearer = (scope: FileSuggestionScope) => void;

const cacheClearers = new Set<SuggestionFileSearchCacheClearer>();

export function registerSuggestionFileSearchCacheClearer(clearer: SuggestionFileSearchCacheClearer): () => void {
    cacheClearers.add(clearer);
    return () => {
        cacheClearers.delete(clearer);
    };
}

/**
 * Invalidates the file index for one workspace.
 *
 * Keyed by machine + folder, like the index itself: a git snapshot change invalidates the
 * FOLDER, so every session pointing at it sees fresh files from one clear instead of each
 * session holding its own stale copy.
 */
export function clearSuggestionFileSearchCache(scope: FileSuggestionScope): void {
    for (const clearer of cacheClearers) {
        clearer(scope);
    }
}
