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
 * Two governed exceptions (lab `kitcharts`, accepted in the widgets handoff §3.12):
 *  - the AGENT dimension draws each Agent in its own fixed identity hue, because Agents are the one
 *    dimension people already recognise by mark and colour across the app. Models, projects,
 *    machines and token kinds keep the accent ramp;
 *  - status is said with an icon and words, in the theme's status roles.
 *
 * Magnitude colors come from here; Agent identity hues come from the Agent catalog.
 * A per-section palette or a hue map for any
 * dimension other than Agent is a review-rejectable regression.
 */

import { getNeutralAgentIdentityColor } from '@/agents/catalog/catalog';

type UsageAccentThemeSlice = Readonly<{
    colors: Readonly<{
        text: Readonly<{
            link: string;
            secondary: string;
        }>;
        /** The paper the ramp is mixed with; a slice without it keeps translucent steps. */
        surface?: Readonly<{ base: string }>;
    }>;
}>;

/** The neutral every folded "Other" series takes, in any dimension. */
export function usageOtherColor(theme: Readonly<{ dark: boolean }>): string {
    return getNeutralAgentIdentityColor(theme);
}

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

const HEX6 = /^#([0-9a-fA-F]{6})$/;

/** `accent` at `amount` over `paper`, as one solid colour; `null` when either is not `#RRGGBB`. */
function mixOverPaper(accent: string, paper: string, amount: number): string | null {
    const top = HEX6.exec(accent.trim());
    const under = HEX6.exec(paper.trim());
    if (!top || !under) return null;
    const a = parseInt(top[1]!, 16);
    const b = parseInt(under[1]!, 16);
    const channel = (shift: number) =>
        Math.round(((a >> shift) & 0xff) * amount + ((b >> shift) & 0xff) * (1 - amount));
    return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Step `index` of the magnitude ramp. On a known paper the step is SOLID (the accent pre-mixed with
 * the paper), so stacked steps keep their order on glass and never show what is behind them.
 */
export function usageSeriesColor(theme: UsageAccentThemeSlice, index: number): string {
    const clampedIndex = Math.max(0, Math.min(index, USAGE_SERIES_RAMP_ALPHAS.length - 1));
    const alpha = USAGE_SERIES_RAMP_ALPHAS[clampedIndex]!;
    const accent = usageSignatureAccent(theme);
    if (alpha >= 1) return accent;
    const paper = theme.colors.surface?.base;
    return (paper ? mixOverPaper(accent, paper, alpha) : null) ?? withUsageAccentAlpha(accent, alpha);
}

/**
 * Meter/bar fill: monochrome neutral for ordinary rows; the signature accent
 * only for the row that carries meaning (leader / selected / over-threshold).
 */
export function usageMeterFill(theme: UsageAccentThemeSlice, emphasized: boolean): string {
    return emphasized ? usageSignatureAccent(theme) : theme.colors.text.secondary;
}
