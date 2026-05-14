import { describe, expect, it } from 'vitest';

import {
    moveTranscriptVirtualCursor,
    resolveTranscriptKeyboardNavigationIntent,
} from './transcript';

describe('transcript keyboard navigation helpers', () => {
    it('resolves page and edge keys only while the transcript zone owns focus', () => {
        expect(resolveTranscriptKeyboardNavigationIntent({
            key: 'PageUp',
            shiftKey: false,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: false,
        })).toEqual({ kind: 'page', direction: 'up', bottomFollowIntent: 'user-scroll' });

        expect(resolveTranscriptKeyboardNavigationIntent({
            key: 'End',
            shiftKey: false,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: false,
        })).toEqual({ kind: 'edge', edge: 'bottom', bottomFollowIntent: 'pin-bottom' });
    });

    it('does not hijack transcript keys when composer, editor, or terminal owns focus', () => {
        for (const focusOwner of ['composer', 'editor', 'terminal'] as const) {
            expect(resolveTranscriptKeyboardNavigationIntent({
                key: 'PageDown',
                shiftKey: false,
                transcriptFocused: true,
                focusOwner,
                singleKeyShortcutsEnabled: true,
            })).toBeNull();
        }
    });

    it('maps Space and Shift+Space to focused transcript page navigation', () => {
        expect(resolveTranscriptKeyboardNavigationIntent({
            key: ' ',
            shiftKey: false,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: false,
        })).toEqual({ kind: 'page', direction: 'down', bottomFollowIntent: 'user-scroll' });

        expect(resolveTranscriptKeyboardNavigationIntent({
            key: ' ',
            shiftKey: true,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: false,
        })).toEqual({ kind: 'page', direction: 'up', bottomFollowIntent: 'user-scroll' });
    });

    it('gates J and K message navigation behind the single-key shortcut setting', () => {
        expect(resolveTranscriptKeyboardNavigationIntent({
            key: 'j',
            shiftKey: false,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: false,
        })).toBeNull();

        expect(resolveTranscriptKeyboardNavigationIntent({
            key: 'K',
            shiftKey: false,
            transcriptFocused: true,
            focusOwner: 'transcript',
            singleKeyShortcutsEnabled: true,
        })).toEqual({ kind: 'message', direction: 'previous', bottomFollowIntent: 'user-scroll' });
    });

    it('moves a virtual message cursor without requiring mounted row focus', () => {
        const messageIds = ['m1', 'm2', 'm3'];

        expect(moveTranscriptVirtualCursor({
            messageIds,
            cursorMessageId: null,
            direction: 'next',
        })).toEqual({ messageId: 'm1', index: 0 });

        expect(moveTranscriptVirtualCursor({
            messageIds,
            cursorMessageId: 'm2',
            direction: 'previous',
        })).toEqual({ messageId: 'm1', index: 0 });

        expect(moveTranscriptVirtualCursor({
            messageIds,
            cursorMessageId: 'missing',
            direction: 'previous',
        })).toEqual({ messageId: 'm3', index: 2 });
    });
});
