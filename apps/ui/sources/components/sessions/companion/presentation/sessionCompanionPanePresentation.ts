import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { PaneMainColumnState } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { createSessionBoardDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';

import type { SessionPresentationMutationOutcome } from './sessionCompanionPresentationAdapter';

type CompanionPane = Pick<AppPaneScopeApi,
    'openDetailsTab' | 'setActiveDetailsTab' | 'focusDetailsGroup'
    | 'closeDetails' | 'closeDetailsTab'> & Readonly<{
    scopeState: Readonly<{ details: NonNullable<AppPaneScopeApi['scopeState']>['details'] }> | null;
}>;

/** Session presentation intents use the same scoped pane operations as the person's controls. */
export function createSessionCompanionPanePresentation(input: Readonly<{
    readPane: () => CompanionPane;
    readMainColumn: () => Pick<PaneMainColumnState, 'hidden' | 'setHidden'> | null;
    isUndoCurrent: () => boolean;
}>) {
    function applyBoardTab(
        boardTab: ReturnType<typeof createSessionBoardDetailsTab>,
        mode: 'beside_chat' | 'focus' | 'preserve_focus',
    ): SessionPresentationMutationOutcome {
        const mainColumn = input.readMainColumn();
        if (mode === 'focus' && !mainColumn) return { status: 'unavailable' };
        const before = input.readPane();
        const beforeDetails = before.scopeState?.details ?? null;
        const beforeMainHidden = mainColumn?.hidden;
        const beforeBoardTabPresent = beforeDetails?.groups?.some(
            (group) => group.tabs.some((tab) => tab.key === boardTab.key),
        ) ?? beforeDetails?.tabs.some((tab) => tab.key === boardTab.key) ?? false;
        const paneAlreadyApplied = beforeDetails?.isOpen === true
            && beforeDetails.activeTabKey === boardTab.key;
        const mainHiddenAlreadyApplied = mode === 'preserve_focus'
            || mainColumn === null
            || mainColumn.hidden === (mode === 'focus');
        if (paneAlreadyApplied && mainHiddenAlreadyApplied) return { status: 'unchanged' };

        before.openDetailsTab(boardTab, { intent: 'pinned' });
        const mainHiddenChanged = !mainHiddenAlreadyApplied;
        if (mode !== 'preserve_focus') mainColumn?.setHidden(mode === 'focus');
        const paneChanged = !paneAlreadyApplied;

        return {
            status: 'applied',
            undo: () => {
                if (!input.isUndoCurrent()) return;
                const currentPane = input.readPane();
                const currentDetails = currentPane.scopeState?.details ?? null;
                // Only invert this command's fields while they still match its result.
                if (paneChanged && currentDetails?.isOpen === true && currentDetails.activeTabKey === boardTab.key) {
                    if (beforeDetails?.isOpen === true) {
                        if (beforeDetails.activeTabKey) currentPane.setActiveDetailsTab(beforeDetails.activeTabKey);
                        if (beforeDetails.focusedGroupId) currentPane.focusDetailsGroup?.(beforeDetails.focusedGroupId);
                    } else {
                        currentPane.closeDetails();
                    }
                    if (!beforeBoardTabPresent) currentPane.closeDetailsTab(boardTab.key);
                }
                if (mainHiddenChanged && beforeMainHidden !== undefined) {
                    const currentMainColumn = input.readMainColumn();
                    if (!currentMainColumn) return;
                    if (currentMainColumn.hidden !== (mode === 'focus')) return;
                    currentMainColumn.setHidden(beforeMainHidden);
                }
            },
        };
    }

    return {
        openBoard: (mode: 'beside_chat' | 'focus') => applyBoardTab(createSessionBoardDetailsTab(), mode),
        revealBoardItem: (widgetId: string) => applyBoardTab(
            createSessionBoardDetailsTab({ kind: 'item', itemId: widgetId }), 'preserve_focus',
        ),
        returnToChat: (): SessionPresentationMutationOutcome => {
            const mainColumn = input.readMainColumn();
            if (!mainColumn) return { status: 'unavailable' };
            if (!mainColumn.hidden) return { status: 'unchanged' };
            mainColumn.setHidden(false);
            return {
                status: 'applied',
                undo: () => {
                    if (!input.isUndoCurrent()) return;
                    const currentMainColumn = input.readMainColumn();
                    if (!currentMainColumn || currentMainColumn.hidden) return;
                    currentMainColumn.setHidden(true);
                },
            };
        },
    };
}
