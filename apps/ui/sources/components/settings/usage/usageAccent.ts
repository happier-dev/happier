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

import { mixHappierColorOverPaper, resolveHappierSeriesRampColor } from '@happier-dev/plugin-ui/presentation';
import { getAgentIdentityColor, getNeutralAgentIdentityColor } from '@/agents/catalog/catalog';

type UsageAccentThemeSlice = Readonly<{
    colors: Readonly<{
        text: Readonly<{
            primary?: string;
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

/**
 * The colours of one ranked Agent chart (Daily, Flow): each Agent its catalog identity hue. An Agent the catalog
 * draws without one takes the next step of the ink ramp in rank order, so ranked leaders stay apart from each other
 * and from the folded Other's neutral (USAGE-ACCEPT 1118 #10: ten leaders in one grey). Call it once per chart, in
 * rank order.
 */
export function createUsageAgentSeriesColor(theme: UsageAccentThemeSlice & Readonly<{ dark: boolean }>): (agentId: string) => string {
    const neutral = getNeutralAgentIdentityColor(theme);
    const ink = theme.colors.text.primary ?? theme.colors.text.secondary;
    const inkSteps = new Map<string, number>();
    return (agentId) => {
        const identity = getAgentIdentityColor(theme, agentId);
        if (identity !== neutral) return identity;
        let step = inkSteps.get(agentId);
        if (step === undefined) {
            step = inkSteps.size;
            inkSteps.set(agentId, step);
        }
        return resolveHappierSeriesRampColor(ink, theme.colors.surface?.base, step + 1);
    };
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
 * Step `index` of the magnitude ramp. On a known paper the step is SOLID (the accent pre-mixed with
 * the paper), so stacked steps keep their order on glass and never show what is behind them.
 */
export function usageSeriesColor(theme: UsageAccentThemeSlice, index: number): string {
    return resolveHappierSeriesRampColor(usageSignatureAccent(theme), theme.colors.surface?.base, index);
}

/**
 * Meter/bar fill: monochrome neutral for ordinary rows; the signature accent
 * only for the row that carries meaning (leader / selected / over-threshold).
 */
export function usageMeterFill(theme: UsageAccentThemeSlice, emphasized: boolean): string {
    if (emphasized) return usageSignatureAccent(theme);
    // The ordinary bar is a light ink step on its paper (lab kitcharts `--uk-neu`), so the accent leader is what
    // the eye finds; secondary text ink read as a row of heavy grey bars beside it (R4).
    const { primary } = theme.colors.text;
    const paper = theme.colors.surface?.base;
    return (primary && paper ? mixHappierColorOverPaper(primary, paper, USAGE_METER_NEUTRAL_INK) : null) ?? theme.colors.text.secondary;
}

/** Lab kitcharts: `--uk-neu` is the text ink at 38% over the paper. */
const USAGE_METER_NEUTRAL_INK = 0.38;
