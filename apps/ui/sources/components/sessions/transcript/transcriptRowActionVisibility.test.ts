import { describe, expect, it } from 'vitest';

import {
    shouldShowTranscriptRowActions,
    shouldShowTranscriptRowPinAction,
} from './transcriptRowActionVisibility';

const hiddenOnFinePointerWeb = {
    platformOS: 'web' as const,
    isRowHovered: false,
    isActionHovered: false,
};

describe('shouldShowTranscriptRowActions', () => {
    it('hides actions on fine-pointer web until the row or an action is hovered', () => {
        expect(shouldShowTranscriptRowActions(hiddenOnFinePointerWeb)).toBe(false);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, isRowHovered: true })).toBe(true);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, isActionHovered: true })).toBe(true);
    });

    it('reveals actions when keyboard focus enters the row action group', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, isRowFocused: true })).toBe(true);
    });

    it('keeps actions visible on touch for a row without a tap-to-open gesture', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, platformOS: 'ios' })).toBe(true);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, platformOS: 'android' })).toBe(true);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, coarsePrimaryPointer: true })).toBe(true);
    });

    it('on touch, shows a message row only while that message is opened by tap or long-press', () => {
        for (const touch of [{ platformOS: 'ios' as const }, { platformOS: 'android' as const }, { coarsePrimaryPointer: true }]) {
            expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, ...touch, touchOpened: false })).toBe(false);
            expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, ...touch, touchOpened: true })).toBe(true);
            // A touch-emulated hover (mouse events synthesized from a tap) never reveals on its own.
            expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, ...touch, touchOpened: false, isRowHovered: true })).toBe(false);
            expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, ...touch, touchOpened: false, isRowFocused: true })).toBe(true);
            expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, ...touch, touchOpened: false, selectionModeActive: true })).toBe(true);
        }
    });

    it('keeps hover on a fine pointer whether or not the row can be opened by tap', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, touchOpened: false })).toBe(false);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, touchOpened: false, isRowHovered: true })).toBe(true);
    });

    it('keeps actions visible while transcript selection mode is active', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, selectionModeActive: true })).toBe(true);
    });
});

describe('shouldShowTranscriptRowPinAction', () => {
    it('keeps a pinned row pin visible without hover', () => {
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: true })).toBe(true);
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, coarsePrimaryPointer: true, touchOpened: false, pinned: true })).toBe(true);
    });

    it('does not drag the rest of the row into view for a pinned row', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, pinned: true })).toBe(false);
    });

    it('follows the row policy for an unpinned row', () => {
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: false })).toBe(false);
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: false, isRowHovered: true })).toBe(true);
    });
});
