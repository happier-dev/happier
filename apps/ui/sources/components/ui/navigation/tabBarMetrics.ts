import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

/**
 * Resolves bottom tab-bar sizing from the user's `tabBarSize` + `tabBarShowLabels`
 * settings. Shared by every bottom bar (main app + cockpit) so size and the
 * Instagram-style icon-only mode stay consistent.
 *
 * Icon-only mode (no labels) gets slightly more vertical padding so the bar keeps
 * a comfortable, balanced height. Visible presets are clamped to the platform's
 * minimum interactive target so compact mode can shrink without hurting usability.
 *
 * `activePillRadius` is the rounding of the selected-tab highlight. It scales with
 * size and gets extra rounding when labels are shown (taller tab) so the pill stays
 * visually concentric with the fully-rounded outer capsule.
 */
export type TabBarSize = 'compact' | 'regular' | 'large';

export type TabBarMetrics = Readonly<{
    iconSize: number;
    tabMinWidth: number;
    tabMinHeight: number;
    tabPaddingVertical: number;
    tabPaddingHorizontal: number;
    rowGap: number;
    showLabels: boolean;
    activePillRadius: number;
}>;

const SIZE_PRESETS: Record<TabBarSize, Readonly<{ iconSize: number; minWidth: number; minHeight: number; padV: number; gap: number; pillRadius: number }>> = {
    compact: { iconSize: 18, minWidth: 44, minHeight: 40, padV: 3, gap: 4, pillRadius: 13 },
    regular: { iconSize: 22, minWidth: 50, minHeight: 44, padV: 5, gap: 5, pillRadius: 16 },
    large: { iconSize: 26, minWidth: 54, minHeight: 48, padV: 7, gap: 7, pillRadius: 20 },
};

const LABELED_PILL_RADIUS_BOOST = 6;

export function resolveTabBarMetrics(size: TabBarSize, showLabels: boolean, platform: string): TabBarMetrics {
    const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS.regular;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(platform);
    return {
        iconSize: preset.iconSize,
        tabMinWidth: Math.max(preset.minWidth, minimumInteractiveTargetSize),
        tabMinHeight: Math.max(preset.minHeight, minimumInteractiveTargetSize),
        tabPaddingVertical: showLabels ? preset.padV : preset.padV + 4,
        // Horizontal padding is aligned to the vertical (base) padding so each tab's
        // padding is symmetric — H = V = padV per size (compact 3, regular 5, large 7).
        tabPaddingHorizontal: preset.padV,
        rowGap: preset.gap,
        showLabels,
        activePillRadius: showLabels ? preset.pillRadius + LABELED_PILL_RADIUS_BOOST : preset.pillRadius,
    };
}
