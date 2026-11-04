import { describe, expect, it } from 'vitest';

import { resolveSessionListShellFlags } from './resolveSessionListShellFlags';

describe('resolveSessionListShellFlags', () => {
    it('reuses the same shell flags object for identical inputs', () => {
        const input = {
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'flat-with-badge' as const,
            isTablet: true,
            sessionListLayoutChoice: 'projects' as const,
            usesProjectGrouping: true,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        };

        const first = resolveSessionListShellFlags(input);
        const second = resolveSessionListShellFlags(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            selectable: true,
            canReorderSessions: true,
            canMoveSessionRowsBetweenFolders: false,
            canDragSessionRows: true,
            showPinnedServerBadge: true,
            showServerBadge: true,
        });
    });

    it('shows badges only when multi-server selection makes them relevant and enables reorder only for Projects', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'flat-with-badge',
            isTablet: true,
            sessionListLayoutChoice: 'projects',
            usesProjectGrouping: true,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        })).toEqual({
            selectable: true,
            canReorderSessions: true,
            canMoveSessionRowsBetweenFolders: false,
            canDragSessionRows: true,
            showPinnedServerBadge: true,
            showServerBadge: true,
        });
    });

    it('suppresses server badges for single-server or grouped views and disables reorder outside Projects', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: true,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            canMoveSessionRowsBetweenFolders: false,
            canDragSessionRows: false,
            showPinnedServerBadge: false,
            showServerBadge: false,
        });
    });

    it('carries Home identity onto rows in Recent activity even when the saved presentation is grouped', () => {
        const recentActivity = resolveSessionListShellFlags({
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        });
        expect(recentActivity.showServerBadge).toBe(true);
        expect(recentActivity.showPinnedServerBadge).toBe(true);

        // Projects keeps its server headers, so the saved grouped presentation still decides.
        expect(resolveSessionListShellFlags({
            selectedServerCount: 2,
            selectionEnabled: true,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'projects',
            usesProjectGrouping: true,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        }).showServerBadge).toBe(false);

        // A single selected Home never needs a badge, whatever the layout.
        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: true,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: false,
        }).showServerBadge).toBe(false);
    });

    it('disables row drag in Recent activity while preserving the saved custom project order', () => {
        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: true,
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            canMoveSessionRowsBetweenFolders: false,
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
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: true,
            hasAnySessionFolderInAccount: true,
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            canMoveSessionRowsBetweenFolders: true,
            canDragSessionRows: true,
            showPinnedServerBadge: false,
            showServerBadge: false,
        });

        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: true,
            hasAnySessionFolderInAccount: false,
        }).canDragSessionRows).toBe(false);

        expect(resolveSessionListShellFlags({
            selectedServerCount: 1,
            selectionEnabled: false,
            selectionPresentation: 'grouped',
            isTablet: false,
            sessionListLayoutChoice: 'recent_activity',
            usesProjectGrouping: false,
            usesFolderTreePresentation: false,
            hasAnySessionFolderInAccount: true,
        }).canDragSessionRows).toBe(false);
    });
});
