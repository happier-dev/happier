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

    it('delegates iOS long-press context menu opening to native inline drag while it owns reorder', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: false,
            contextMenuWasOpen: false,
            nativeInlineDragEnabled: true,
            hasReorderHandle: true,
        });

        expect(policy.enableLongPressContextMenu).toBe(false);
        expect(policy.showReorderHandle).toBe(true);
    });

    it('keeps Android row long-press menus disabled so row presses remain clickable', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'android',
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: false,
            contextMenuWasOpen: false,
            nativeInlineDragEnabled: false,
            hasReorderHandle: false,
        });

        expect(policy.enableLongPressContextMenu).toBe(false);
    });
});
