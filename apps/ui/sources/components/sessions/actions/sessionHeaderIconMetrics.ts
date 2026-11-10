import * as React from 'react';
import { useHappierTouchTargetSize } from '@happier-dev/plugin-ui/environment';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE } from '@/components/ui/icons/Icon';

/**
 * One size for the session header's icon actions.
 *
 * This file used to carry three tiers — a base size plus two hand-measured optical corrections for
 * glyphs that painted more ink than their neighbours at the same number. Those corrections existed
 * because the header mixed Ionicons and Octicons: two families drawn to different grids, so matching
 * the numbers did not match the ink.
 *
 * Behind a single-family seam that problem leaves this file entirely. The header asks for one size,
 * and any glyph that still diverges optically is corrected once, per glyph, inside `Icon` — the only
 * place that can reasonably know about a glyph's ink.
 */
export const SESSION_HEADER_ICON_SIZE_PX = ICON_SIZE.md;

/** The drawn square of a direct session-header action: the page's control height. */
export const SESSION_HEADER_ACTION_SIZE_PX = HAPPIER_PAGE_METRICS.controlHeightPx;

/** Between two actions under a precise pointer; their hit areas meet in the middle of it. */
const SESSION_HEADER_POINTER_GAP_PX = 6;

export type SessionHeaderActionMetrics = Readonly<{ glyphPx: number; gapPx: number }>;

const POINTER_METRICS: SessionHeaderActionMetrics = Object.freeze({ glyphPx: SESSION_HEADER_ICON_SIZE_PX, gapPx: SESSION_HEADER_POINTER_GAP_PX });

/**
 * The session header's actions as the shared hit-area owner decides the pointer (`useHappierTouchTargetSize`, the
 * same decision that reaches each action's hit area to the touch target). Under a finger the glyph is the header's
 * `lg` and neighbouring actions stand one touch target apart, so their hit areas abut without overlapping
 * (phone-system lab D1); under a precise pointer they keep the compact glyph and gap.
 */
export function useSessionHeaderActionMetrics(): SessionHeaderActionMetrics {
    const targetPx = useHappierTouchTargetSize();
    return React.useMemo(() => targetPx === undefined ? POINTER_METRICS : {
        glyphPx: ICON_SIZE.lg,
        gapPx: Math.max(0, targetPx - SESSION_HEADER_ACTION_SIZE_PX),
    }, [targetPx]);
}
