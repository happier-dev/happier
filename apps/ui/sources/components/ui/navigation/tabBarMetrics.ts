/**
 * Resolves bottom tab-bar sizing from the user's `tabBarSize` + `tabBarShowLabels`
 * settings. Shared by every bottom bar (main app + cockpit) so size and the
 * Instagram-style icon-only mode stay consistent.
 *
 * Icon-only mode (no labels) gets one more step of vertical padding, so the selected
 * highlight that fills the tab's height is a round-ish 42 × 36 at regular size (as in 0.2).
 *
 * `activePillRadius` is the rounding of the selected-tab highlight: a capsule. The bar is a
 * capsule and the highlight sits a uniform inset inside it, so a capsule highlight is exactly
 * the bar's radius minus that inset — concentric at every size, with or without labels
 * (owner 2026-11-10). Platforms clamp it to half the highlight's shorter side.
 */
export type TabBarSize = 'compact' | 'regular' | 'large';

export type TabBarMetrics = Readonly<{
    iconSize: number;
    tabMinWidth: number;
    tabPaddingVertical: number;
    tabPaddingHorizontal: number;
    rowGap: number;
    showLabels: boolean;
    activePillRadius: number;
}>;

const SIZE_PRESETS: Record<TabBarSize, Readonly<{ iconSize: number; minWidth: number; padV: number }>> = {
    compact: { iconSize: 20, minWidth: 44, padV: 3 },
    regular: { iconSize: 24, minWidth: 50, padV: 5 },
    large: { iconSize: 28, minWidth: 54, padV: 7 },
};

const CAPSULE_RADIUS = 999;

export function resolveTabBarMetrics(size: TabBarSize, showLabels: boolean): TabBarMetrics {
    const preset = SIZE_PRESETS[size] ?? SIZE_PRESETS.regular;
    return {
        iconSize: preset.iconSize,
        tabMinWidth: preset.minWidth,
        tabPaddingVertical: showLabels ? preset.padV : preset.padV + 1,
        // Horizontal padding is aligned to the vertical (base) padding so each tab's
        // padding is symmetric — H = V = padV per size (compact 3, regular 5, large 7).
        tabPaddingHorizontal: preset.padV,
        rowGap: 0,
        showLabels,
        activePillRadius: CAPSULE_RADIUS,
    };
}
