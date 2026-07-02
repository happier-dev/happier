type SuggestionFileSearchCacheClearer = (sessionId?: string) => void;

const cacheClearers = new Set<SuggestionFileSearchCacheClearer>();

export function registerSuggestionFileSearchCacheClearer(clearer: SuggestionFileSearchCacheClearer): () => void {
    cacheClearers.add(clearer);
    return () => {
        cacheClearers.delete(clearer);
    };
}

export function clearSuggestionFileSearchCache(sessionId?: string): void {
    for (const clearer of cacheClearers) {
        clearer(sessionId);
    }
}
