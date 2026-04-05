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

export function resolveSessionRowInteractionPolicy(
    params: SessionRowInteractionPolicyParams,
): SessionRowInteractionPolicy {
    const {
        platformOs,
        isActiveSession,
        canStopSession,
        canArchiveSession,
        contextMenuItemCount,
        contextMenuOpen,
        contextMenuWasOpen,
        nativeInlineDragEnabled,
        hasReorderHandle,
    } = params;

    const isNativeMobile = platformOs === 'ios' || platformOs === 'android';
    const swipeEnabled = platformOs !== 'web' && (isActiveSession ? canStopSession : canArchiveSession);
    const suppressNextPressOnNativeContextMenuOpen = contextMenuItemCount > 0 && contextMenuOpen && !contextMenuWasOpen;

    return {
        swipeEnabled,
        showReorderHandle: hasReorderHandle,
        enableLongPressContextMenu:
            isNativeMobile
            && contextMenuItemCount > 0
            && (!nativeInlineDragEnabled || hasReorderHandle),
        suppressNextPressOnNativeContextMenuOpen,
    };
}
