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

    it('keeps actions visible on hover-less hosts: touch platforms and coarse-primary-pointer web', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, platformOS: 'ios' })).toBe(true);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, platformOS: 'android' })).toBe(true);
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, coarsePrimaryPointer: true })).toBe(true);
    });

    it('keeps actions visible while transcript selection mode is active', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, selectionModeActive: true })).toBe(true);
    });
});

describe('shouldShowTranscriptRowPinAction', () => {
    it('keeps a pinned row pin visible without hover', () => {
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: true })).toBe(true);
    });

    it('does not drag the rest of the row into view for a pinned row', () => {
        expect(shouldShowTranscriptRowActions({ ...hiddenOnFinePointerWeb, pinned: true })).toBe(false);
    });

    it('follows the row policy for an unpinned row', () => {
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: false })).toBe(false);
        expect(shouldShowTranscriptRowPinAction({ ...hiddenOnFinePointerWeb, pinned: false, isRowHovered: true })).toBe(true);
    });
});
