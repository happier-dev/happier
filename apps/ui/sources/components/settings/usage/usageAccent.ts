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
 *    dimension people already recognise by mark and colour across the app (`usageAgentColor`: the
 *    catalog hue, or Usage's fallback hue for an Agent the catalog draws without one). Models,
 *    projects, machines and token kinds keep the accent ramp;
 *  - status is said with an icon and words, in the theme's status roles.
 *
 * Magnitude colors come from here; Agent identity hues come from the Agent catalog.
 * A per-section palette or a hue map for any
 * dimension other than Agent is a review-rejectable regression.
 */

import { mixHappierColorOverPaper, resolveHappierSeriesRampColor } from '@happier-dev/plugin-ui/presentation';
import { isUnattributedUsageAgentId } from '@happier-dev/protocol/usage/usageFormatting';
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
 * Usage's hues for the Agents the catalog draws without an identity hue (USAGE-ACCEPT 1121 #2). They sit in the hue
 * gaps between the catalog's Agent hues (orange, blue, green, indigo, pink) and stay clear of amber and rose, which
 * mean "needs you" and "failed"; a leading hue-less Agent must not read as Pi's pink. Light steps are deep enough for
 * white paper; dark steps lift for the dark card.
 */
const USAGE_AGENT_FALLBACK_HUES: readonly Readonly<{ light: string; dark: string }>[] = [
    { light: '#6f8f1a', dark: '#9bb540' }, // olive
    { light: '#9a5f33', dark: '#c08a5c' }, // umber
    { light: '#0e8fa3', dark: '#3cb3c6' }, // cyan
    { light: '#8e4585', dark: '#b67aac' }, // plum (darker and greyer than Pi's pink)
    { light: '#7d3fb0', dark: '#c48ae8' }, // violet
];

/** The fallback slot an Agent id hashes to, so a hue-less Agent keeps one hue on every chart and every page. */
function usageAgentFallbackSlot(agentId: string): number {
    let hash = 0;
    for (let index = 0; index < agentId.length; index += 1) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
    return hash % USAGE_AGENT_FALLBACK_HUES.length;
}

/**
 * An Agent's colour on any Usage chart: its catalog identity hue, or Usage's fallback hue for it. The neutral belongs
 * to what no Agent names: the folded Other and the unattributed member (`isUnattributedUsageAgentId`).
 */
export function usageAgentColor(theme: Readonly<{ dark: boolean }>, agentId: string): string {
    const identity = getAgentIdentityColor(theme, agentId);
    if (identity !== getNeutralAgentIdentityColor(theme) || isUnattributedUsageAgentId(agentId)) return identity;
    return USAGE_AGENT_FALLBACK_HUES[usageAgentFallbackSlot(agentId)]![theme.dark ? 'dark' : 'light'];
}

/**
 * The colours of one Agent chart, asked in rank order: each Agent its `usageAgentColor`. When two hue-less Agents of
 * the chart hash to one fallback hue, the later one takes the next free hue, so the chart's leaders stay apart from
 * each other and from the folded Other's neutral (USAGE-ACCEPT 1118 #10). Past the fallback hues, an ink step.
 */
export function createUsageAgentSeriesColor(theme: UsageAccentThemeSlice & Readonly<{ dark: boolean }>): (agentId: string) => string {
    const neutral = getNeutralAgentIdentityColor(theme);
    const ink = theme.colors.text.primary ?? theme.colors.text.secondary;
    const assigned = new Map<string, string>();
    const taken = new Set<number>();
    return (agentId) => {
        const known = assigned.get(agentId);
        if (known !== undefined) return known;
        let color = getAgentIdentityColor(theme, agentId);
        if (color === neutral && !isUnattributedUsageAgentId(agentId)) {
            const first = usageAgentFallbackSlot(agentId);
            const slot = Array.from({ length: USAGE_AGENT_FALLBACK_HUES.length }, (_, step) => (first + step) % USAGE_AGENT_FALLBACK_HUES.length)
                .find((candidate) => !taken.has(candidate));
            if (slot === undefined) {
                color = resolveHappierSeriesRampColor(ink, theme.colors.surface?.base, assigned.size + 1);
            } else {
                taken.add(slot);
                color = USAGE_AGENT_FALLBACK_HUES[slot]![theme.dark ? 'dark' : 'light'];
            }
        }
        assigned.set(agentId, color);
        return color;
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
