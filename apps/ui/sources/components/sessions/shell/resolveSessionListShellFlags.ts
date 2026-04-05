export function resolveSessionListShellFlags(params: Readonly<{
    selectedServerCount: number;
    selectionEnabled: boolean;
    selectionPresentation: 'grouped' | 'flat' | 'flat-with-badge';
    isTablet: boolean;
    sessionListOrderingModeV1: 'custom' | 'created' | 'updated';
}>): Readonly<{
    selectable: boolean;
    canReorderSessions: boolean;
    showServerBadge: boolean;
    showPinnedServerBadge: boolean;
}> {
    const selectable = params.isTablet;
    const canReorderSessions = params.sessionListOrderingModeV1 === 'custom';
    const hasMultiServerSelection = params.selectionEnabled && params.selectedServerCount > 1;
    const showServerBadge = hasMultiServerSelection && params.selectionPresentation === 'flat-with-badge';
    const showPinnedServerBadge = hasMultiServerSelection;

    return {
        selectable,
        canReorderSessions,
        showServerBadge,
        showPinnedServerBadge,
    };
}
