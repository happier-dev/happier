import { describe, expect, it } from 'vitest';

import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';

describe('resolveSessionListShellFlags', () => {
    it('reuses the same shell flags object for identical inputs', () => {
        const input = {
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'flat-with-badge' as const,
            isTablet: true,
            sessionListOrderingModeV1: 'custom' as const,
            folderActionsEnabled: false,
            folderViewMode: 'off' as const,
            hasAnySessionFolderInAccount: false,
        };

        const first = resolveSessionListShellFlags(input);
        const second = resolveSessionListShellFlags(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            selectable: true,
            canReorderSessions: true,
            canDragSessionRows: true,
            showPinnedServerBadge: true,
            showServerBadge: true,
        });
    });

    it('shows badges only when multi-server selection makes them relevant and enables reorder only for custom mode', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'flat-with-badge',
            isTablet: true,
            sessionListOrderingModeV1: 'custom',
            folderActionsEnabled: false,
            folderViewMode: 'off',
            hasAnySessionFolderInAccount: false,
        })).toEqual({
            selectable: true,
            canReorderSessions: true,
            canDragSessionRows: true,
            showPinnedServerBadge: true,
            showServerBadge: true,
        });
    });

    it('suppresses server badges for single-server or grouped views and disables reorder outside custom mode', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: true,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListOrderingModeV1: 'updated',
            folderActionsEnabled: false,
            folderViewMode: 'off',
            hasAnySessionFolderInAccount: false,
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            canDragSessionRows: false,
            showPinnedServerBadge: false,
            showServerBadge: false,
        });
    });

    it('keeps row drag available in date mode only when folder tree operations can use it', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListOrderingModeV1: 'updated',
            folderActionsEnabled: true,
            folderViewMode: 'tree',
            hasAnySessionFolderInAccount: true,
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            canDragSessionRows: true,
            showPinnedServerBadge: false,
            showServerBadge: false,
        });

        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListOrderingModeV1: 'updated',
            folderActionsEnabled: true,
            folderViewMode: 'tree',
            hasAnySessionFolderInAccount: false,
        }).canDragSessionRows).toBe(false);

        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListOrderingModeV1: 'updated',
            folderActionsEnabled: true,
            folderViewMode: 'off',
            hasAnySessionFolderInAccount: true,
        }).canDragSessionRows).toBe(false);
    });
});
