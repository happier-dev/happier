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
 *    dimension people already recognise by mark and colour across the app (`createUsageAgentSeriesColor`: the
 *    catalog hue, or Usage's fallback hue for an Agent the catalog draws without one). Models,
 *    projects, machines and token kinds keep the accent ramp;
 *  - status is said with an icon and words, in the theme's status roles.
 *
 * Magnitude colors come from here; Agent identity hues come from the Agent catalog.
 * A per-section palette or a hue map for any
 * dimension other than Agent is a review-rejectable regression.
 */

import { createContext, useContext, useMemo } from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { normalizeBundledAgentRoutingId } from '@happier-dev/agents';
import { readUsageScopeOptions } from '@happier-dev/protocol/usage/usageFilterOptions';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { mixHappierColorOverPaper, resolveHappierSeriesRampColor } from '@happier-dev/plugin-ui/presentation';
import { isUnattributedUsageAgentId } from '@happier-dev/protocol/usage/usageFormatting';
import { getAgentIdentityColor, getNeutralAgentIdentityColor } from '@/agents/catalog/catalog';
import { agentIdFromEngineKey, resolveUsageMeasuredTokens } from '@/sync/api/account/usageAnalytics';

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

/** Preferred fallback slot for the canonical Agent id. */
function usageAgentFallbackSlot(agentId: string): number {
    let hash = 0;
    for (let index = 0; index < agentId.length; index += 1) hash = (hash * 31 + agentId.charCodeAt(index)) >>> 0;
    return hash % USAGE_AGENT_FALLBACK_HUES.length;
}

type UsageAgentColor = (agentId: string) => string;
const UsageAgentColorContext = createContext<UsageAgentColor | null>(null);
export const UsageAgentColorProvider = UsageAgentColorContext.Provider;

/** One member of a page's Agent population: its weight is its share of the page (tokens), larger first. */
export type UsageAgentPopulationMember = string | Readonly<{ agentId: string; weight: number | null }>;

/**
 * Assign the surface's hues once, before any chart or swatch reads them, in the page's RANK order: the largest share
 * first, canonical id as tie-break (USAGE-ACCEPT 1122 #2: in id order the leader of sixteen fell to the ink ramp). The
 * result depends on the population only, never on the order it is listed in; a bare id weighs nothing.
 */
export function createUsageAgentSeriesColor(
    theme: UsageAccentThemeSlice & Readonly<{ dark: boolean }>,
    population: Iterable<UsageAgentPopulationMember>,
): UsageAgentColor {
    const neutral = getNeutralAgentIdentityColor(theme);
    const ink = theme.colors.text.primary ?? theme.colors.text.secondary;
    const mode = theme.dark ? 'dark' : 'light';
    const assigned = new Map<string, string>();
    const taken = new Set<number>();
    const identityColor = (agentId: string) => isUnattributedUsageAgentId(agentId) ? neutral : getAgentIdentityColor(theme, agentId);
    const fallbackHue = (slot: number) => USAGE_AGENT_FALLBACK_HUES[slot]![mode];

    const weights = new Map<string, number>();
    for (const member of population) {
        const id = normalizeBundledAgentRoutingId(typeof member === 'string' ? member : member.agentId);
        const weight = typeof member === 'string' ? 0 : member.weight ?? 0;
        weights.set(id, Math.max(weights.get(id) ?? 0, weight));
    }
    const ranked = [...weights.keys()].sort((left, right) => (weights.get(right)! - weights.get(left)!) || (left < right ? -1 : left > right ? 1 : 0));
    for (const id of ranked) {
        if (isUnattributedUsageAgentId(id)) continue;
        let color = identityColor(id);
        if (color === neutral) {
            const first = usageAgentFallbackSlot(id);
            let slot = first;
            while (taken.has(slot) && taken.size < USAGE_AGENT_FALLBACK_HUES.length) {
                slot = (slot + 1) % USAGE_AGENT_FALLBACK_HUES.length;
            }
            if (taken.has(slot)) {
                color = resolveHappierSeriesRampColor(ink, theme.colors.surface?.base, assigned.size + 1);
            } else {
                taken.add(slot);
                color = fallbackHue(slot);
            }
        }
        assigned.set(id, color);
    }
    return (agentId) => {
        const id = normalizeBundledAgentRoutingId(agentId);
        const known = assigned.get(id);
        if (known !== undefined) return known;
        const identity = identityColor(id);
        return identity !== neutral || isUnattributedUsageAgentId(id) ? identity : fallbackHue(usageAgentFallbackSlot(id));
    };
}

type UsageAccounting = NonNullable<UsageQueryResultSlice['accounting']>;
// One reading per admitted accounting response: a page choice that keeps the response (the cost basis) re-ranks from it
// without walking its rows again (the page's retained-rows contract).
const agentTokensByAccounting = new WeakMap<UsageAccounting, Readonly<{ breakdown: ReadonlyMap<string, number>; timeline: ReadonlyMap<string, number> }>>();
function accountingAgentTokens(accounting: UsageAccounting) {
  const known = agentTokensByAccounting.get(accounting);
  if (known) return known;
  const breakdown = new Map<string, number>();
  const timeline = new Map<string, number>();
  for (const entry of accounting.breakdowns?.agent ?? []) {
    breakdown.set(entry.key, (breakdown.get(entry.key) ?? 0) + (resolveUsageMeasuredTokens(entry.tokens).total ?? 0));
  }
  for (const bucket of accounting.engineTimeline ?? []) for (const leader of bucket.leaders) {
    const agentId = agentIdFromEngineKey(leader.key);
    timeline.set(agentId, (timeline.get(agentId) ?? 0) + (leader.tokens ? resolveUsageMeasuredTokens(leader.tokens).total ?? 0 : 0));
  }
  const read = { breakdown, timeline };
  agentTokensByAccounting.set(accounting, read);
  return read;
}

/**
 * Agents named by the admitted chart results, including charts sourced from Work detail, each weighted by its token
 * total in the accounting breakdown (the page's rank), so the leaders take the hues first.
 */
export function readUsageChartAgentIds(slices: readonly UsageQueryResultSlice[]): readonly Readonly<{ agentId: string; weight: number }>[] {
  const ids = new Set(readUsageScopeOptions(slices, 'agents').keys());
  const add = (id: string | null) => { if (id !== null) ids.add(id); };
  for (const slice of slices) {
    const work = slice.howYouWork;
    for (const row of work?.agentCalendar?.periodSummary.agents ?? []) add(row.agentId);
    for (const row of work?.intervals?.lanes ?? []) add(row.agentId);
    for (const row of work?.steering?.byAgent ?? []) add(row.agentId);
    for (const row of work?.runLengths?.byAgent ?? []) add(row.agentId);
    for (const edge of work?.collaboration?.edges ?? []) {
      add(edge.sourceAgentId);
      add(edge.targetAgentId);
    }
    for (const row of slice.work?.allocations ?? []) add(row.contribution.agentId);
  }
  // The rank is the Agent's tokens on the page: its breakdown row where the query asks for one, its timeline leaders
  // (the Overview reads no Agent breakdown), or its calendar total (How you work reads neither). The largest reading
  // wins; none is added to another.
  const breakdown = new Map<string, number>();
  const timeline = new Map<string, number>();
  const calendar = new Map<string, number>();
  const addAll = (into: Map<string, number>, from: ReadonlyMap<string, number>) => {
    for (const [id, tokens] of from) into.set(id, (into.get(id) ?? 0) + tokens);
  };
  for (const slice of slices) {
    for (const row of slice.howYouWork?.agentCalendar?.periodSummary.agents ?? []) {
      if (row.agentId !== null) calendar.set(row.agentId, (calendar.get(row.agentId) ?? 0) + (row.metrics.tokens ?? 0));
    }
    if (slice.accounting) {
      const read = accountingAgentTokens(slice.accounting);
      addAll(breakdown, read.breakdown);
      addAll(timeline, read.timeline);
    }
  }
  const weights = new Map([...ids].map(id => [id, Math.max(breakdown.get(id) ?? 0, timeline.get(id) ?? 0, calendar.get(id) ?? 0)]));
  return [...ids].sort().map(agentId => ({ agentId, weight: weights.get(agentId) ?? 0 }));
}

/** Standalone widget results use the same assignment over their own admitted population. */
export function useUsageAgentColor(slice?: UsageQueryResultSlice | null): UsageAgentColor {
    const { theme } = useUnistyles();
    const shared = useContext(UsageAgentColorContext);
    return useMemo(() => shared ?? createUsageAgentSeriesColor(theme, slice ? readUsageChartAgentIds([slice]) : []), [shared, slice, theme]);
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
