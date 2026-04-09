import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListShellFlags = Readonly<{
    selectable: boolean;
    canReorderSessions: boolean;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
}>;

const SESSION_LIST_SHELL_FLAGS_CACHE = new LruMap<string, SessionListShellFlags>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveSessionListShellFlags(params: Readonly<{
    selectedServerCount: number;
    selectionEnabled: boolean;
    selectionPresentation: 'grouped' | 'flat' | 'flat-with-badge';
    isTablet: boolean;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
}>): SessionListShellFlags {
    const cacheKey = [
        params.selectedServerCount,
        params.selectionEnabled ? '1' : '0',
        params.selectionPresentation,
        params.isTablet ? '1' : '0',
        params.sessionListOrderingModeV1,
    ].join('|');
    const cached = SESSION_LIST_SHELL_FLAGS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
}
    const selectable = params.isTablet;
    const canReorderSessions = params.sessionListOrderingModeV1 === 'custom';
    const hasMultiServerSelection = params.selectionEnabled && params.selectedServerCount > 1;
    const showServerBadge = hasMultiServerSelection && params.selectionPresentation === 'flat-with-badge';
    const showPinnedServerBadge = hasMultiServerSelection;

    const next = {
        selectable,
        canReorderSessions,
        showServerBadge,
        showPinnedServerBadge,
    } satisfies SessionListShellFlags;

    SESSION_LIST_SHELL_FLAGS_CACHE.set(cacheKey, next);
    return next;
}
