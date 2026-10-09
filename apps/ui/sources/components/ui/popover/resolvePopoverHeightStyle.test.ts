import { describe, expect, it } from 'vitest';

import { resolvePopoverSideMaxHeight } from './resolvePopoverHeightStyle';

describe('resolvePopoverSideMaxHeight', () => {
    const boundary = { boundaryY: 10, boundaryHeight: 880, gap: 4 };

    it('keeps a top-aligned side popover with its anchor row while the room below the row holds what it usually needs', () => {
        // A submenu beside a row at y=127 runs from that row to the boundary's foot (10 + 880), less the gap,
        // not over the whole window.
        expect(resolvePopoverSideMaxHeight({ ...boundary, anchorY: 127, anchorAlignVertical: 'start', preferredMinHeight: 320 })).toBe(759);
    });

    it('lets it use the whole boundary when the row sits too low to hold what it usually needs', () => {
        expect(resolvePopoverSideMaxHeight({ ...boundary, anchorY: 700, anchorAlignVertical: 'start', preferredMinHeight: 320 })).toBe(872);
    });

    it('leaves centred and end-aligned side popovers bounded by the whole boundary', () => {
        expect(resolvePopoverSideMaxHeight({ ...boundary, anchorY: 127, anchorAlignVertical: 'center', preferredMinHeight: 320 })).toBe(872);
        expect(resolvePopoverSideMaxHeight({ ...boundary, anchorY: 127, anchorAlignVertical: 'end', preferredMinHeight: 320 })).toBe(872);
    });
});
