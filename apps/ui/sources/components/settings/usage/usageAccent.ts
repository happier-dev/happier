/**
 * THE single palette owner for every usage surface (R-DESIGN D-1).
 *
 * Binding design language (L4): "instruments, not dashboards" — near-monochrome
 * canvas with ONE signature accent (the theme `text.link` family). Categorical
 * distinction, where genuinely needed, is an ORDERED tonal ramp of that single
 * accent (opacity steps), never different hues. Meter bars are monochrome
 * neutrals; the accent is reserved for the row that MEANS something (the
 * leader, the current selection, the over-threshold value).
 *
 * Every usage component takes its colors from here. A per-section palette or a
 * per-dimension hue map is a review-rejectable regression.
 */

type UsageAccentThemeSlice = Readonly<{
    colors: Readonly<{
        text: Readonly<{
            link: string;
            secondary: string;
        }>;
    }>;
}>;

/** The one signature accent for usage surfaces. */
export function usageSignatureAccent(theme: UsageAccentThemeSlice): string {
    return theme.colors.text.link;
}

/**
 * `#RRGGBB` → `rgba(...)` at the given alpha. Non-hex inputs (already-derived
 * rgba, platform-selected tokens) are returned unchanged rather than guessed.
 */
export function withUsageAccentAlpha(color: string, alpha: number): string {
    const hex = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
    if (!hex) return color;
    const value = parseInt(hex[1]!, 16);
    const clamped = Math.max(0, Math.min(1, alpha));
    return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${clamped})`;
}

/**
 * Ordered tonal ramp for series/categorical distinction (journey-chart series,
 * token-mix segments, the context-gauge popover category legend). Index 0 is
 * the full signature accent; later steps fade in strictly decreasing,
 * still-legible alpha steps.
 *
 * Eight steps so the widest categorical surface — the context-gauge popover,
 * which can list up to 8 context categories — gets a DISTINCT ordered tone per
 * category and never wraps back to the signature accent (D-6).
 */
export const USAGE_SERIES_RAMP_ALPHAS = [1, 0.82, 0.68, 0.56, 0.46, 0.37, 0.29, 0.22] as const;

export function usageSeriesColor(theme: UsageAccentThemeSlice, index: number): string {
    const clampedIndex = Math.max(0, Math.min(index, USAGE_SERIES_RAMP_ALPHAS.length - 1));
    const alpha = USAGE_SERIES_RAMP_ALPHAS[clampedIndex]!;
    const accent = usageSignatureAccent(theme);
    return alpha >= 1 ? accent : withUsageAccentAlpha(accent, alpha);
}

/**
 * Meter/bar fill: monochrome neutral for ordinary rows; the signature accent
 * only for the row that carries meaning (leader / selected / over-threshold).
 */
export function usageMeterFill(theme: UsageAccentThemeSlice, emphasized: boolean): string {
    return emphasized ? usageSignatureAccent(theme) : theme.colors.text.secondary;
}
