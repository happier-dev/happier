import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_SHELL_TITLE_ROW_GLYPH_PX, resolveHappierTitleRowInsetPx } from '@happier-dev/plugin-ui/presentation';

import {
    DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
    DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX,
} from '../desktopChrome/desktopChromeMetrics';

/**
 * Geometry of the app rail (lab `xrail-R1`, measured: rail 56 wide, items 36 centred on x 28).
 */
export const APP_RAIL_WIDTH_PX = 56;
/**
 * Every rail glyph's size, in the same 36 box: destinations, More, Usage, Machines, Updates, Settings. It is the title
 * row's glyph, whose ink top the column titles start on.
 */
export const APP_RAIL_ICON_GLYPH_SIZE_PX = HAPPIER_SHELL_TITLE_ROW_GLYPH_PX;
/** The visible square of a rail icon button. */
export const APP_RAIL_ITEM_SIZE_PX = 36;
/** One rail row: the button plus the gap to the next. The plugin group's overflow counts in these. */
export const APP_RAIL_ITEM_SLOT_PX = 40;
/**
 * How far a rail button's hit area may reach past its drawn square: half the gap to the button above and
 * below (the slot's free space), and the rail's free width beside it. Neighbouring slots' hit areas meet
 * without overlapping.
 */
export const APP_RAIL_ITEM_EDGES_PX = Object.freeze({
    leading: (APP_RAIL_WIDTH_PX - APP_RAIL_ITEM_SIZE_PX) / 2,
    trailing: (APP_RAIL_WIDTH_PX - APP_RAIL_ITEM_SIZE_PX) / 2,
    top: (APP_RAIL_ITEM_SLOT_PX - APP_RAIL_ITEM_SIZE_PX) / 2,
    bottom: (APP_RAIL_ITEM_SLOT_PX - APP_RAIL_ITEM_SIZE_PX) / 2,
});
/** The avatar at the rail's foot. */
export const APP_RAIL_AVATAR_SIZE_PX = 28;
/** The title strip across the window: back, forward, the column toggle, and macOS's traffic lights. */
export const APP_SHELL_TITLE_STRIP_HEIGHT_PX = 40;
/** Above the rail's first icon: its slot centres on the shell's one title row, level with every column title. */
export const APP_RAIL_PADDING_TOP_PX = resolveHappierTitleRowInsetPx(APP_RAIL_ITEM_SLOT_PX);
/**
 * Where the title strip's controls (back, forward, the column toggle…) start, from the window's leading edge: the
 * first glyph stands on the column's text edge below it, so the strip's controls head the column's title, search
 * field and rows (owner 2026-11-10). Hosts that draw window controls before the logo (macOS) shift the strip.
 */
export const APP_SHELL_TITLE_STRIP_CONTROLS_START_PX = APP_RAIL_WIDTH_PX + HAPPIER_COLLECTION_LIST_METRICS.contentInset
    - (DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX - DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX) / 2;

const GLYPH_RIGHT_PX = APP_RAIL_WIDTH_PX / 2 + APP_RAIL_ICON_GLYPH_SIZE_PX / 2;
const GLYPH_TOP_PX = APP_RAIL_ITEM_SLOT_PX / 2 - APP_RAIL_ICON_GLYPH_SIZE_PX / 2;
/** How far a badge's ringed box reaches back over the glyph's top-right corner. */
export const APP_RAIL_BADGE_OVERLAP_PX = 7;
/**
 * The one rail badge geometry (`AppRailBadge`), relative to a rail slot: a count or a dot whose ringed
 * box starts just inside the glyph box's top-right corner, so it reads as the glyph's without covering
 * it, and grows rightward into the slot's free space (never clipped by the rail).
 */
export const APP_RAIL_BADGE = Object.freeze({
    anchorLeftPx: GLYPH_RIGHT_PX - APP_RAIL_BADGE_OVERLAP_PX,
    anchorTopPx: GLYPH_TOP_PX - APP_RAIL_BADGE_OVERLAP_PX,
    /** A count's pill height (and minimum width) inside its ring. */
    countSizePx: 14,
    countFontSizePx: 9,
    /** Small and quiet (owner 2026-11-10): the dot marks "something to read", the count "needs you". */
    dotSizePx: 6,
    /** The ring in the rail's own colour that lifts the badge off the glyph. */
    ringPx: 2,
});
