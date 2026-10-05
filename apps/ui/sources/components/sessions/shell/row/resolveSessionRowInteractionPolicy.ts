import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

export type SessionRowInteractionPolicyParams = Readonly<{
    platformOs: string;
    /** The primary pointer is a finger (native, or a phone/tablet browser): rows recompose as on a phone. */
    touchPrimaryPointer: boolean;
    isActiveSession: boolean;
    canStopSession: boolean;
    canArchiveSession: boolean;
    contextMenuItemCount: number;
    contextMenuOpen: boolean;
    contextMenuWasOpen: boolean;
    /** The row can be carried at all (its list's organization and order rules allow moving it). */
    dragEnabled: boolean;
    /** The phone list is in its intentional Organize mode (K1). */
    organizeMode: boolean;
}>;

/**
 * How one Session row arbitrates its inputs (DnD lab E1 / K1):
 *
 * - Desktop: the whole row is the one drag source; a press still opens it, secondary controls keep
 *   their own presses, and no separate handle exists.
 * - Phone: scrolling, swipes, taps and the long-press menu keep their meaning. A row drags only
 *   through its grip, and grips exist only in Organize mode, where swipe and the long-press menu
 *   step aside so the grip and the list's Done own the gesture space.
 */
export type SessionRowInteractionPolicy = Readonly<{
    swipeEnabled: boolean;
    wholeRowDrag: boolean;
    showDragGrip: boolean;
    enableLongPressContextMenu: boolean;
    suppressNextPressOnNativeContextMenuOpen: boolean;
}>;

const SESSION_ROW_INTERACTION_POLICY_CACHE = new LruMap<string, SessionRowInteractionPolicy>({
    maxEntries: readSessionListShellCacheMaxEntriesFromEnv(),
});

export function resolveSessionRowInteractionPolicy(
    params: SessionRowInteractionPolicyParams,
): SessionRowInteractionPolicy {
    const cacheKey = JSON.stringify([
        params.platformOs,
        params.touchPrimaryPointer,
        params.isActiveSession,
        params.canStopSession,
        params.canArchiveSession,
        params.contextMenuItemCount,
        params.contextMenuOpen,
        params.contextMenuWasOpen,
        params.dragEnabled,
        params.organizeMode,
    ]);
    const cached = SESSION_ROW_INTERACTION_POLICY_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const {
        platformOs,
        touchPrimaryPointer,
        isActiveSession,
        canStopSession,
        canArchiveSession,
        contextMenuItemCount,
        contextMenuOpen,
        contextMenuWasOpen,
        dragEnabled,
        organizeMode,
    } = params;

    const isWeb = platformOs === 'web';
    const isNativePhone = platformOs === 'ios' || platformOs === 'android';
    const phoneOrganizing = touchPrimaryPointer && organizeMode;
    const suppressNextPressOnNativeContextMenuOpen = contextMenuItemCount > 0 && contextMenuOpen && !contextMenuWasOpen;

    const next = {
        swipeEnabled: !isWeb && !phoneOrganizing && canArchiveSession,
        wholeRowDrag: !touchPrimaryPointer && dragEnabled,
        showDragGrip: phoneOrganizing && dragEnabled,
        enableLongPressContextMenu: isNativePhone && !phoneOrganizing && contextMenuItemCount > 0,
        suppressNextPressOnNativeContextMenuOpen,
    };

    SESSION_ROW_INTERACTION_POLICY_CACHE.set(cacheKey, next);
    return next;
}
