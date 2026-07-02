import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListShellFlags = Readonly<{
    selectable: boolean;
    canReorderSessions: boolean;
    canDragSessionRows: boolean;
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
    folderActionsEnabled: boolean;
    folderViewMode: 'off' | 'tree';
    hasAnySessionFolderInAccount: boolean;
}>): SessionListShellFlags {
    const cacheKey = [
        params.selectedServerCount,
        params.selectionEnabled ? '1' : '0',
        params.selectionPresentation,
        params.isTablet ? '1' : '0',
        params.sessionListOrderingModeV1,
        params.folderActionsEnabled ? '1' : '0',
        params.folderViewMode,
        params.hasAnySessionFolderInAccount ? '1' : '0',
    ].join('|');
    const cached = SESSION_LIST_SHELL_FLAGS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
}
    const selectable = params.isTablet;
    const canReorderSessions = params.sessionListOrderingModeV1 === 'custom';
    const canDragSessionRows = canReorderSessions
        || (
            params.folderActionsEnabled
            && params.folderViewMode === 'tree'
            && params.hasAnySessionFolderInAccount
        );
    const hasMultiServerSelection = params.selectionEnabled && params.selectedServerCount > 1;
    const showServerBadge = hasMultiServerSelection && params.selectionPresentation === 'flat-with-badge';
    const showPinnedServerBadge = hasMultiServerSelection;

    const next = {
        selectable,
        canReorderSessions,
        canDragSessionRows,
        showServerBadge,
        showPinnedServerBadge,
    } satisfies SessionListShellFlags;

    SESSION_LIST_SHELL_FLAGS_CACHE.set(cacheKey, next);
    return next;
}
