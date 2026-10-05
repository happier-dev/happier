import { describe, expect, it } from 'vitest';

import { resolveSessionRowInteractionPolicy } from './resolveSessionRowInteractionPolicy';

describe('resolveSessionRowInteractionPolicy', () => {
    it('reuses the same policy object for identical inputs', () => {
        const input = {
            platformOs: 'ios',
            touchPrimaryPointer: true,
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: true,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: false,
            dragEnabled: false,
            organizeMode: false,
        } as const;

        const first = resolveSessionRowInteractionPolicy(input);
        const second = resolveSessionRowInteractionPolicy(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            swipeEnabled: true,
            wholeRowDrag: false,
            showDragGrip: false,
            enableLongPressContextMenu: true,
            suppressNextPressOnNativeContextMenuOpen: true,
        });
    });

    it('suppresses the next press when a native context menu opens', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            touchPrimaryPointer: true,
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: false,
            dragEnabled: false,
            organizeMode: false,
        });

        expect(policy.enableLongPressContextMenu).toBe(true);
        expect(policy.suppressNextPressOnNativeContextMenuOpen).toBe(true);
    });

    it('does not suppress presses while the menu stays open', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            touchPrimaryPointer: true,
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: true,
            contextMenuWasOpen: true,
            dragEnabled: false,
            organizeMode: false,
        });

        expect(policy.suppressNextPressOnNativeContextMenuOpen).toBe(false);
    });

    it('uses archive permission for active-session swipe actions', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'ios',
            touchPrimaryPointer: true,
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: false,
            contextMenuWasOpen: false,
            dragEnabled: false,
            organizeMode: false,
        });

        expect(policy.swipeEnabled).toBe(false);
    });

    const phoneRow = {
        isActiveSession: true,
        canStopSession: true,
        canArchiveSession: true,
        contextMenuItemCount: 2,
        contextMenuOpen: false,
        contextMenuWasOpen: false,
        dragEnabled: true,
    } as const;

    it('keeps long-press for the menu on a phone and shows no grip outside Organize mode (K1)', () => {
        const policy = resolveSessionRowInteractionPolicy({ ...phoneRow, platformOs: 'ios', touchPrimaryPointer: true, organizeMode: false });

        expect(policy.enableLongPressContextMenu).toBe(true);
        expect(policy.showDragGrip).toBe(false);
        expect(policy.wholeRowDrag).toBe(false);
        expect(policy.swipeEnabled).toBe(true);
    });

    it('drags only through the grip in phone Organize mode, where swipe and the long-press menu step aside', () => {
        for (const platformOs of ['ios', 'android', 'web'] as const) {
            const policy = resolveSessionRowInteractionPolicy({ ...phoneRow, platformOs, touchPrimaryPointer: true, organizeMode: true });

            expect(policy.showDragGrip).toBe(true);
            expect(policy.wholeRowDrag).toBe(false);
            expect(policy.swipeEnabled).toBe(false);
            expect(policy.enableLongPressContextMenu).toBe(false);
        }
    });

    it('shows no grip in Organize mode for a row that cannot move', () => {
        const policy = resolveSessionRowInteractionPolicy({ ...phoneRow, platformOs: 'android', touchPrimaryPointer: true, organizeMode: true, dragEnabled: false });

        expect(policy.showDragGrip).toBe(false);
    });

    it('makes the whole desktop row the one drag source, with no separate handle (E1)', () => {
        const policy = resolveSessionRowInteractionPolicy({ ...phoneRow, platformOs: 'web', touchPrimaryPointer: false, organizeMode: false });

        expect(policy.wholeRowDrag).toBe(true);
        expect(policy.showDragGrip).toBe(false);
        expect(policy.swipeEnabled).toBe(false);
    });

    it('never turns a whole row into a drag source in a phone browser, where it would steal scrolling', () => {
        const policy = resolveSessionRowInteractionPolicy({ ...phoneRow, platformOs: 'web', touchPrimaryPointer: true, organizeMode: false });

        expect(policy.wholeRowDrag).toBe(false);
        expect(policy.showDragGrip).toBe(false);
    });

    it('keeps Android row long-press menus disabled so row presses remain clickable', () => {
        const policy = resolveSessionRowInteractionPolicy({
            platformOs: 'android',
            touchPrimaryPointer: true,
            isActiveSession: true,
            canStopSession: true,
            canArchiveSession: false,
            contextMenuItemCount: 2,
            contextMenuOpen: false,
            contextMenuWasOpen: false,
            dragEnabled: false,
            organizeMode: false,
        });

        expect(policy.enableLongPressContextMenu).toBe(false);
    });
});
