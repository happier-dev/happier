import { LruMap } from '@/utils/cache/lruMap';
import {
    resolveSessionListLayoutPresentation,
    type SessionListLayoutChoice,
} from '@/sync/domains/session/listing/sessionListLayout';
import type { ServerSelectionPresentation } from '@/sync/domains/server/selection/serverSelectionTypes';
import { readSessionListShellCacheMaxEntriesFromEnv } from './sessionListShellCacheConfig';

export type SessionListShellFlags = Readonly<{
    selectable: boolean;
    canReorderSessions: boolean;
    canMoveSessionRowsBetweenFolders: boolean;
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
    selectionPresentation: ServerSelectionPresentation;
    isTablet: boolean;
    sessionListLayoutChoice: SessionListLayoutChoice;
    usesProjectGrouping: boolean;
    usesFolderTreePresentation: boolean;
    hasAnySessionFolderInAccount: boolean;
}>): SessionListShellFlags {
    const cacheKey = [
        params.selectedServerCount,
        params.selectionEnabled ? '1' : '0',
        params.selectionPresentation,
        params.isTablet ? '1' : '0',
        params.sessionListLayoutChoice,
        params.usesProjectGrouping ? '1' : '0',
        params.usesFolderTreePresentation ? '1' : '0',
        params.hasAnySessionFolderInAccount ? '1' : '0',
    ].join('|');
    const cached = SESSION_LIST_SHELL_FLAGS_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }
    const selectable = params.isTablet;
    const canReorderSessions = params.usesProjectGrouping
        && params.sessionListLayoutChoice === 'projects';
    const canMoveSessionRowsBetweenFolders = params.usesFolderTreePresentation
        && params.hasAnySessionFolderInAccount;
    const canDragSessionRows = canReorderSessions || canMoveSessionRowsBetweenFolders;
    const hasMultiServerSelection = params.selectionEnabled && params.selectedServerCount > 1;
    // The badge is the only Home marker a row carries, so it has to follow the
    // presentation the layout actually renders, not the saved server-group preference.
    const effectivePresentation = resolveSessionListLayoutPresentation(
        params.sessionListLayoutChoice,
        params.selectionPresentation,
    );
    const showServerBadge = hasMultiServerSelection && effectivePresentation === 'flat-with-badge';
    const showPinnedServerBadge = hasMultiServerSelection;

    const next = {
        selectable,
        canReorderSessions,
        canMoveSessionRowsBetweenFolders,
        canDragSessionRows,
        showServerBadge,
        showPinnedServerBadge,
    } satisfies SessionListShellFlags;

    SESSION_LIST_SHELL_FLAGS_CACHE.set(cacheKey, next);
    return next;
}
