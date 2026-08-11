import { describe, expect, it } from 'vitest';

import { ICON_ACTION_BOX_PX } from '@/components/ui/buttons/IconAction';

import { AGENT_ROW_ACTION_GAP_PX, AGENT_ROW_ACTION_HIT_SLOP } from './agentRowMetrics';

/**
 * The row's right cluster is two adjacent icon controls, and a tap must never be a coin flip.
 *
 * The caret and the overflow are separate components sitting a few points apart, each extending its
 * 28pt box with its own `hitSlop`. Nothing in either component can see the other, so the geometry
 * they compose is only checkable here — and when it was decided twice it composed a ~12pt band in
 * which both controls claimed the same points, so pressing near the seam opened the menu or
 * expanded the preview depending on which happened to win the hit test.
 *
 * The contract is the composition, not either number: laid out at their real box size and gap, the
 * two hit areas meet and do not overlap, and each still clears the minimum comfortable target.
 */

/** The floor a control has to clear on touch (`make-interfaces-feel-better`, rule 16). */
const MINIMUM_TARGET_PX = 40;

type Span = Readonly<{ start: number; end: number }>;

/** Where a control's touch area starts and ends, in the cluster's own horizontal coordinates. */
function hitSpan(boxStartPx: number): Span {
    return {
        start: boxStartPx - AGENT_ROW_ACTION_HIT_SLOP.left,
        end: boxStartPx + ICON_ACTION_BOX_PX.sm + AGENT_ROW_ACTION_HIT_SLOP.right,
    };
}

describe('agent row action geometry', () => {
    it('gives the overflow and the caret touch areas that meet exactly once', () => {
        // The two controls as the row lays them out: `sm` boxes separated by the cluster gap.
        const overflow = hitSpan(0);
        const caret = hitSpan(ICON_ACTION_BOX_PX.sm + AGENT_ROW_ACTION_GAP_PX);

        // No point belongs to both: the seam is a boundary, never a band.
        expect(caret.start).toBeGreaterThanOrEqual(overflow.end);
        // And no point belongs to neither: a dead strip between two adjacent controls is a press
        // that falls through to the row and opens the agent instead.
        expect(caret.start).toBeLessThanOrEqual(overflow.end);
    });

    it('keeps each control at a comfortable target width despite the split', () => {
        const width = ICON_ACTION_BOX_PX.sm
            + AGENT_ROW_ACTION_HIT_SLOP.left
            + AGENT_ROW_ACTION_HIT_SLOP.right;
        expect(width).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX);

        // Vertically nothing competes, so the box takes the row's full 44pt touch height.
        const height = ICON_ACTION_BOX_PX.sm
            + AGENT_ROW_ACTION_HIT_SLOP.top
            + AGENT_ROW_ACTION_HIT_SLOP.bottom;
        expect(height).toBeGreaterThanOrEqual(MINIMUM_TARGET_PX);
    });
});
