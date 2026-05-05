import { Platform } from 'react-native';
/** Canonical UI shadow steps (1 = lowest). Web uses CSS `box-shadow`; native uses a single-shadow approximation. */
export const SHADOW_LEVELS = [1, 2, 3, 4, 5];
function token(boxShadow, shadowColor, shadowOffset, shadowOpacity, shadowRadius, elevation) {
    return {
        boxShadow,
        shadowColor,
        shadowOffset,
        shadowOpacity,
        shadowRadius,
        elevation,
    };
}
/** Light surfaces: level 1 matches product spec (lowest elevation). */
export function buildLightShadowLevels() {
    return {
        1: token('0 2px 8px rgba(0, 0, 0, 0.01), 0 1px 3px rgba(0, 0, 0, 0.03)', '#000000', { width: 0, height: 1 }, 0.06, 4, 1),
        2: token('0 2px 10px rgba(0, 0, 0, 0.04), 0 2px 6px rgba(0, 0, 0, 0.06)', '#000000', { width: 0, height: 2 }, 0.1, 5, 2),
        3: token('0 4px 18px rgba(0, 0, 0, 0.07), 0 2px 8px rgba(0, 0, 0, 0.09)', '#000000', { width: 0, height: 3 }, 0.14, 8, 4),
        4: token('0 8px 28px rgba(0, 0, 0, 0.11), 0 4px 14px rgba(0, 0, 0, 0.09)', '#000000', { width: 0, height: 4 }, 0.18, 12, 6),
        5: token('0 14px 40px rgba(0, 0, 0, 0.16), 0 6px 18px rgba(0, 0, 0, 0.12)', '#000000', { width: 0, height: 8 }, 0.22, 16, 10),
    };
}
/** Dark surfaces: stronger cast shadows so depth reads on dark UI. */
export function buildDarkShadowLevels() {
    return {
        1: token('0 2px 8px rgba(0, 0, 0, 0.03), 0 1px 3px rgba(0, 0, 0, 0.05)', '#000000', { width: 0, height: 1 }, 0.06, 4, 1),
        2: token('0 2px 10px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.08)', '#000000', { width: 0, height: 2 }, 0.1, 5, 2),
        3: token('0 4px 18px rgba(0, 0, 0, 0.11), 0 2px 8px rgba(0, 0, 0, 0.13)', '#000000', { width: 0, height: 3 }, 0.14, 8, 4),
        4: token('0 8px 28px rgba(0, 0, 0, 0.15), 0 4px 14px rgba(0, 0, 0, 0.17)', '#000000', { width: 0, height: 4 }, 0.18, 12, 6),
        5: token('0 14px 40px rgba(0, 0, 0, 0.20), 0 6px 18px rgba(0, 0, 0, 0.22)', '#000000', { width: 0, height: 8 }, 0.22, 16, 10),
    };
}
/** Rotated popover arrow on web: keep a dedicated token (RN-web shadow + transforms are finicky). */
export function buildShadowPopoverArrowBoxShadow(dark) {
    return dark
        ? '0 4px 14px rgba(0, 0, 0, 0.55)'
        : '0 4px 14px rgba(0, 0, 0, 0.24)';
}
/**
 * View shadow styles for a themed elevation step.
 */
export function shadowLevelStyle(level) {
    if (Platform.OS === 'web') {
        return { boxShadow: level.boxShadow };
    }
    return {
        shadowColor: level.shadowColor,
        shadowOffset: level.shadowOffset,
        shadowOpacity: level.shadowOpacity,
        shadowRadius: level.shadowRadius,
        elevation: level.elevation,
    };
}
