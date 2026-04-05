import { describe, expect, it } from 'vitest';

import { resolveSessionRowInteractionPolicy } from './resolveSessionRowInteractionPolicy';

describe('resolveSessionRowInteractionPolicy', () => {
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
});
