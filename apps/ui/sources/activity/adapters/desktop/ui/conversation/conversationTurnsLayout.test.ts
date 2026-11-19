import { describe, expect, it } from 'vitest';

import { resolveConversationTurnsLayout } from './conversationTurnsLayout';

describe('resolveConversationTurnsLayout', () => {
    it('gives the turns the panel room the header, asks and reply leave, and asks the island for the rest', () => {
        // A short window (the list's height): the turns get what is left and the island asks for every turn.
        expect(resolveConversationTurnsLayout({ available: 240, chromeHeight: 160, turnsContentHeight: 900 }))
            .toEqual({ maxHeight: 80, overflow: 820 });
        // The planner granted a tall island: the same turns now fit, nothing is asked beyond them.
        expect(resolveConversationTurnsLayout({ available: 1100, chromeHeight: 160, turnsContentHeight: 900 }))
            .toEqual({ maxHeight: 940, overflow: 0 });
    });

    it('scrolls only past the room the island has, and never sizes the turns below zero', () => {
        expect(resolveConversationTurnsLayout({ available: 700, chromeHeight: 160, turnsContentHeight: 2_000 }))
            .toEqual({ maxHeight: 540, overflow: 1_460 });
        expect(resolveConversationTurnsLayout({ available: 100, chromeHeight: 160, turnsContentHeight: 50 }))
            .toEqual({ maxHeight: 0, overflow: 50 });
        // Unmeasured room: no cap yet, nothing asked beyond the content itself.
        expect(resolveConversationTurnsLayout({ available: null, chromeHeight: 160, turnsContentHeight: 300 }))
            .toEqual({ maxHeight: undefined, overflow: 0 });
    });
});
