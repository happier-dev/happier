import { describe, expect, it } from 'vitest';

import { resolveSessionRowInteractionPolicy } from './resolveSessionRowInteractionPolicy';

describe('resolveSessionRowInteractionPolicy', () => {
    it('reuses the same policy object for identical inputs', () => {
        const input = {
            platformOs: 'ios',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: true,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: false,
            nativeInlineDragEnabled: false,
            hasReorderHandle: false,
        } as const;

        const first = resolveSessionRowInteractionPolicy(input);
        const second = resolveSessionRowInteractionPolicy(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            swipeEnabled: true,
            showReorderHandle: false,
            enableLongPressContextMenu: true,
            suppressNextPressOnNativeContextMenuOpen: true,
        });
    });

    it('suppresses the next press when a native context menu opens', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: false,
            nativeInlineDragEnabled: false,
            hasReorderHandle: false,
        });

        expect(policy.enableLongPressContextMenu).toBe(true);
        expect(policy.suppressNextPressOnNativeContextMenuOpen).toBe(true);
    });

    it('does not suppress presses while the menu stays open', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: true,
            nativeInlineDragEnabled: false,
            hasReorderHandle: false,
        });

        expect(policy.suppressNextPressOnNativeContextMenuOpen).toBe(false);
    });

    it('uses archive permission for active-session swipe actions', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: false,
            contextMenuWasOpen: false,
            nativeInlineDragEnabled: false,
            hasReorderHandle: false,
        });

        expect(policy.swipeEnabled).toBe(false);
    });
});
