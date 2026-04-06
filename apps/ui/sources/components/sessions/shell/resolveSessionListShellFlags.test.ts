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
        };

        const first = resolveSessionListShellFlags(input);
        const second = resolveSessionListShellFlags(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            selectable: true,
            canReorderSessions: true,
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
        })).toEqual({
            selectable: true,
            canReorderSessions: true,
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
        })).toEqual({
            selectable: false,
            canReorderSessions: false,
            showPinnedServerBadge: false,
            showServerBadge: false,
        });
    });
});
