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

/** The shared accessible hit target for each direct session-header action. */
export const SESSION_HEADER_ACTION_TAP_TARGET_PX = 44;
