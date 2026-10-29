export type MachineStripMode = 'inline-metrics' | 'comfort' | 'compact';

/** Horizontal padding per side inside one comfort chip and around the whole strip row. */
export const MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX = 6;
export const MACHINE_STRIP_ROW_HORIZONTAL_PADDING_PX = 8;
/** Edge length of the monitor glyph that carries the machine's initial. */
export const MACHINE_STRIP_GLYPH_SIZE_PX = 18;
/** Gap between a chip's glyph and its alias, and between neighboring chips. */
export const MACHINE_STRIP_CHIP_INNER_GAP_PX = 4;
export const MACHINE_STRIP_CHIP_GAP_PX = 6;
/** Comfort-chip border, drawn on both sides of the chip's content box. */
export const MACHINE_STRIP_CHIP_BORDER_PX = 1;
/** Fixed chrome every comfort chip costs before a single pixel of alias text. */
export const MACHINE_STRIP_CHIP_OVERHEAD_PX =
    MACHINE_STRIP_CHIP_HORIZONTAL_PADDING_PX * 2
    + MACHINE_STRIP_GLYPH_SIZE_PX
    + MACHINE_STRIP_CHIP_INNER_GAP_PX
    + MACHINE_STRIP_CHIP_BORDER_PX * 2;
/** Alias floor: below this budget a chip cannot show a meaningful name and the row degrades. */
export const MACHINE_STRIP_MIN_ALIAS_BUDGET_PX = 12;
/** Conservative average advance for Latin and other narrow glyphs at the 12px alias font size. */
export const MACHINE_STRIP_ESTIMATED_CHAR_WIDTH_PX = 7;
/** Wide glyphs (CJK, kana, Hangul, fullwidth forms, emoji) advance ≈ the 12px alias font size. */
export const MACHINE_STRIP_ESTIMATED_WIDE_CHAR_WIDTH_PX = 12;

function isWideGlyph(codePoint: number): boolean {
    // 0x2E80 (CJK radicals) upward covers kana, Hangul, CJK ideographs, and the astral emoji
    // planes; the fullwidth ASCII block sits below that cutoff and needs its own range.
    return codePoint >= 0x2E80 || (codePoint >= 0xFF01 && codePoint <= 0xFF60);
}

export function estimateMachineStripChipWidthPx(alias: string): number {
    let textWidth = 0;
    // String iteration yields whole code points, so surrogate-pair emoji count as one glyph.
    for (const glyph of alias) {
        textWidth += isWideGlyph(glyph.codePointAt(0) ?? 0)
            ? MACHINE_STRIP_ESTIMATED_WIDE_CHAR_WIDTH_PX
            : MACHINE_STRIP_ESTIMATED_CHAR_WIDTH_PX;
    }
    return MACHINE_STRIP_CHIP_OVERHEAD_PX + textWidth;
}

/**
 * Alias pixels each chip may spend when the row stays in the comfort density: whatever width is
 * left after every chip's fixed chrome and the inter-chip gaps, split evenly. Long display names
 * ellipsize against this budget instead of collapsing the whole row to avatars; `null` means the
 * budget cannot even pay for {@link MACHINE_STRIP_MIN_ALIAS_BUDGET_PX}, so the row degrades.
 */
export function resolveMachineStripAliasBudgetPx(containerWidth: number, machineCount: number): number | null {
    if (!Number.isFinite(containerWidth) || containerWidth <= 0 || machineCount <= 1) return null;
    const budget = Math.floor(
        (containerWidth - (machineCount - 1) * MACHINE_STRIP_CHIP_GAP_PX - machineCount * MACHINE_STRIP_CHIP_OVERHEAD_PX)
            / machineCount,
    );
    return budget >= MACHINE_STRIP_MIN_ALIAS_BUDGET_PX ? budget : null;
}

/**
 * Density for the machine strip row: one machine always inlines its three metrics, several
 * machines keep alias chips whenever each chip can afford a minimal (ellipsized) alias, and only a
 * row that cannot pay even that collapses to glyph-only avatars. `containerWidth` is the width
 * actually available to the chips (row width minus the row's own horizontal padding); `null`
 * means the first, not-yet-measured frame, which renders optimistically as `comfort`.
 */
export function resolveMachineStripMode(input: Readonly<{
    machineCount: number;
    containerWidth: number | null;
}>): MachineStripMode | null {
    if (input.machineCount <= 0) return null;
    if (input.machineCount === 1) return 'inline-metrics';
    if (input.containerWidth === null) return 'comfort';
    return resolveMachineStripAliasBudgetPx(input.containerWidth, input.machineCount) !== null
        ? 'comfort'
        : 'compact';
}
