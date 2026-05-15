import { LruMap } from '@/utils/cache/lruMap';

import { readSessionListShellCacheMaxEntriesFromEnv } from '../sessionListShellCacheConfig';

export type SessionRowInteractionPolicyParams = Readonly<{
    platformOs: string;
    isActiveSession: boolean;
    canStopSession: boolean;
    canArchiveSession: boolean;
    contextMenuItemCount: number;
    contextMenuOpen: boolean;
    contextMenuWasOpen: boolean;
    nativeInlineDragEnabled: boolean;
    hasReorderHandle: boolean;
}>;

export type SessionRowInteractionPolicy = Readonly<{
    swipeEnabled: boolean;
    showReorderHandle: boolean;
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
        params.isActiveSession,
        params.canStopSession,
        params.canArchiveSession,
        params.contextMenuItemCount,
        params.contextMenuOpen,
        params.contextMenuWasOpen,
        params.nativeInlineDragEnabled,
        params.hasReorderHandle,
    ]);
    const cached = SESSION_ROW_INTERACTION_POLICY_CACHE.get(cacheKey);
    if (cached) {
        return cached;
    }

    const {
        platformOs,
        isActiveSession,
        canStopSession,
        canArchiveSession,
        contextMenuItemCount,
        contextMenuOpen,
        contextMenuWasOpen,
        hasReorderHandle,
    } = params;

    const isIos = platformOs === 'ios';
    const swipeEnabled = platformOs !== 'web' && canArchiveSession;
    const suppressNextPressOnNativeContextMenuOpen = contextMenuItemCount > 0 && contextMenuOpen && !contextMenuWasOpen;

    const next = {
        swipeEnabled,
        showReorderHandle: hasReorderHandle,
        enableLongPressContextMenu:
            isIos
            && params.nativeInlineDragEnabled !== true
            && contextMenuItemCount > 0,
        suppressNextPressOnNativeContextMenuOpen,
    };

    SESSION_ROW_INTERACTION_POLICY_CACHE.set(cacheKey, next);
    return next;
}
