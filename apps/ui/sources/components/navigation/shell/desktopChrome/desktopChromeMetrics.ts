import { SIDEBAR_DOCK_MIN_WIDTH_PX } from '../sidebarSizing';
import { ICON_SIZE } from '@/components/ui/icons/Icon';

export const DESKTOP_SIDEBAR_CHROME_ACTIONS_COMPACT_THRESHOLD_PX = SIDEBAR_DOCK_MIN_WIDTH_PX + 120;
export const DESKTOP_SIDEBAR_CHROME_HORIZONTAL_PADDING_PX = 16;
export const DESKTOP_SIDEBAR_CHROME_CONTROL_GAP_PX = 8;
export const DESKTOP_SIDEBAR_CHROME_ROW_GAP_PX = 4;
export const DESKTOP_SIDEBAR_CHROME_BRAND_ROW_MIN_HEIGHT_PX = 40;
export const DESKTOP_SIDEBAR_CHROME_BRAND_LOGO_SIZE_PX = 24;
export const DESKTOP_SIDEBAR_CHROME_COLLAPSED_HORIZONTAL_PADDING_PX = 8;
export const DESKTOP_SIDEBAR_CHROME_COLLAPSED_VERTICAL_GAP_PX = 8;
/**
 * One box for every control in the sidebar header row: the brand button, and each control in the
 * action cluster -- the overflow trigger, the nav glyphs, and the trailing "+".
 *
 * It was already this 32 three times over in this row, until the action cluster started taking the
 * inline-row default of a full 44px visible target per control and wrapping the 32/24px boxes
 * inside it. Two boxes deep, four controls spread across the whole sidebar and the custom overflow
 * trigger -- which brought no box of its own -- stayed 32 beside them, so the row also read at two
 * different densities.
 */
export const DESKTOP_SIDEBAR_CHROME_ACTION_CONTROL_SIZE_PX = 32;
export const DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_BUTTON_SIZE_PX = 20;
export const DESKTOP_SIDEBAR_CHROME_TOP_SETTINGS_ICON_BUTTON_SIZE_PX = 24;
export const DESKTOP_SIDEBAR_CHROME_TOP_ICON_GAP_PX = 12;
/**
 * One glyph size for every icon in the desktop sidebar chrome: the top strip, and the collapsed
 * rail's toggle, which is the same control in its other state.
 *
 * These were 15/13/18 across three constants -- hand-measured corrections from when this row mixed
 * Ionicons and Octicons, which are drawn to different grids, so matching their declared sizes did not
 * match their ink. Behind a single-family seam the corrections are noise, and collapsing them was
 * right; taking the app's DEFAULT size as the survivor was not. This strip is window chrome, sitting
 * beside 12px traffic lights, and at 20 the glyphs exactly filled their 20px buttons -- no padding
 * anywhere in the row. It is the compact step, and the button boxes stay where they are so the
 * glyphs finally have air around them.
 */
export const DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX = ICON_SIZE.sm;
export const DESKTOP_SIDEBAR_CHROME_TOP_NOTIFICATION_DOT_SIZE_PX = 8;
export const DESKTOP_SIDEBAR_CHROME_TOP_NOTIFICATION_DOT_TOP_PX = -2;
export const DESKTOP_SIDEBAR_CHROME_TOP_NOTIFICATION_DOT_RIGHT_PX = -2;
export const DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_OPACITY = 0.72;
export const DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_DISABLED_OPACITY = 0.28;
export const DESKTOP_SIDEBAR_CHROME_TOP_SETTINGS_ICON_OPACITY = 0.78;
export const DESKTOP_SIDEBAR_CHROME_WINDOW_CONTROLS_GAP_PX = 2;
export const DESKTOP_SIDEBAR_CHROME_TOP_PADDING_PX = 2;
export const DESKTOP_WINDOW_CONTROLS_SLOT_MIN_WIDTH_PX = 68;
export const DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX = 28;
export const DESKTOP_MAIN_CONTENT_DRAG_HEIGHT_PX = DESKTOP_WINDOW_CONTROLS_SLOT_MIN_HEIGHT_PX * 2;
