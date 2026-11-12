import type { UnistylesThemes } from 'react-native-unistyles';
import {
    summarizeConnectedServiceQuotaCredits,
    type ConnectedServiceQuotaCreditSummary,
    type ConnectedServiceQuotaMeterV1,
} from '@happier-dev/protocol';

import type { MeterTone } from '@/components/ui/lists/MeterBar';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import {
    buildConnectedServiceQuotaGaugeMeterRows,
    selectComparableConnectedServiceQuotaMeters,
    type ConnectedServiceQuotaGaugeMeterRow,
    type ConnectedServiceQuotaGaugeLabelFormatter,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { resolveQuotaToneColor } from '@/sync/domains/connectedServices/resolveQuotaToneColor';

type Theme = UnistylesThemes[keyof UnistylesThemes];

/**
 * Pure presentation model for `AccountBlock`. Keeps the tone/health mapping in a
 * single, trivially testable place so the collapsed header signals, the expanded
 * USAGE meters, and the health dot can never disagree (they all flow through
 * `resolveQuotaTone`).
 */

export type AccountUsageRow = Readonly<{
    meterId: string;
    label: string;
    tone: MeterTone;
    /**
     * Remaining capacity fraction in 0..1 — the ONE fill/indicator value. CS quota gauges are
     * remaining-first end to end (labels say "% left", tone derives from remaining, capacity rings
     * display remaining), so bars fill with remaining too (battery model: full green = plenty
     * left). A consumption fill next to a "left" label reads inverted (user decision 2026-07-10,
     * reverting 5ad4d06be).
     */
    remaining: number | null;
    detailLabel: string;
}>;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

/**
 * Map the gauge's reported meter rows onto the AccountBlock USAGE rows. Tone is
 * derived from the SAME `resolveQuotaTone` owner the meter bars and health dot
 * use; `remaining` feeds both the capacity indicators and the MeterBar fill so
 * the row can never disagree with its own "% left" label.
 */
export function resolveAccountUsageRows(
    meterRows: ReadonlyArray<ConnectedServiceQuotaGaugeMeterRow> | null | undefined,
): AccountUsageRow[] {
    if (!meterRows || meterRows.length === 0) return [];
    return meterRows.map((row) => ({
        meterId: row.meterId,
        label: row.label,
        tone: resolveQuotaTone(row.remainingPct),
        remaining: row.remainingPct === null ? null : clamp01(row.remainingPct / 100),
        detailLabel: row.detailRightLabel,
    }));
}

/** Map derived account health onto the canonical status variant vocabulary. */
export function resolveAccountHealthVariant(health: AccountHealth): StatusPillVariant {
    if (health === 'error') return 'danger';
    if (health === 'attention') return 'warning';
    return 'success';
}

/**
 * Map derived account health onto the `MeterTone` vocabulary so the health dot
 * color resolves through the SAME `resolveQuotaToneColor` owner the meter bars
 * use (the dot and the bars can never disagree).
 */
export function resolveAccountHealthTone(health: AccountHealth): MeterTone {
    if (health === 'error') return 'danger';
    if (health === 'attention') return 'warning';
    return 'success';
}

/** Resolve the themed dot color for an account's derived health. */
export function resolveAccountHealthDotColor(theme: Theme, health: AccountHealth): string {
    return resolveQuotaToneColor(theme, resolveAccountHealthTone(health));
}

/** One concentric capacity-ring: `ratio` is the remaining-capacity fraction it fills. */
export type CapacityRingDatum = Readonly<{ ratio: number; tone: MeterTone }>;

export type AccountCapacityView = Readonly<{
    capacityPct: number | null;
    rings: CapacityRingDatum[];
    /** Provider credits (Codex credits, Claude extra usage); null when the account reports none. */
    credits: ConnectedServiceQuotaCreditSummary | null;
    /** Included limits are spent but credits keep the account usable — never "used up". */
    creditsOnly: boolean;
}>;

/** Display-only windows never become capacity candidates; the gauge owner chooses the family. */
export function resolveAccountCapacityView(
    meters: readonly ConnectedServiceQuotaMeterV1[],
    nowMs: number,
    formatter: ConnectedServiceQuotaGaugeLabelFormatter,
): AccountCapacityView {
    const rows = buildConnectedServiceQuotaGaugeMeterRows(
        selectComparableConnectedServiceQuotaMeters(meters), nowMs, formatter,
    );
    const capacityPct = deriveAccountCapacityPct(rows);
    const credits = summarizeConnectedServiceQuotaCredits(meters);
    return {
        capacityPct,
        rings: resolveAccountCapacityRings(resolveAccountUsageRows(rows)),
        credits,
        creditsOnly: capacityPct !== null && capacityPct <= 0 && credits?.available === true,
    };
}

/**
 * Beyond this the avatar's concentric rings become illegibly thin, so we only
 * render the most-constrained few.
 */
export const MAX_CAPACITY_RINGS = 3;

/**
 * Build the concentric capacity-ring data from an account's usage rows: one ring
 * per limit, most-constrained (lowest remaining) OUTERMOST, capped at
 * {@link MAX_CAPACITY_RINGS}. The center number (overall capacity) therefore
 * matches the outer ring, and you can read every limit at a glance.
 */
export function resolveAccountCapacityRings(
    usageRows: ReadonlyArray<AccountUsageRow>,
): CapacityRingDatum[] {
    return usageRows
        .flatMap((row) => row.remaining === null ? [] : [{ ratio: row.remaining, tone: row.tone }])
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, MAX_CAPACITY_RINGS);
}

/**
 * Human names for the provider limit ids a quota reset clears. The base window ids keep
 * their localized family names; any other id the snapshot shows as a meter (matched by
 * provider limit id or meter id) keeps that meter's name, so a reset reads in the same
 * vocabulary as the USAGE list. Unknown ids stay visible verbatim rather than guessed.
 */
export function resolveResetLimitLabels(
    providerLimitIds: ReadonlyArray<string>,
    meters: ReadonlyArray<ConnectedServiceQuotaMeterV1>,
    familyLabels: Readonly<{ fiveHour: string; weekly: string }>,
): string[] {
    const labels = providerLimitIds.map((id) => {
        if (id === 'five_hour') return familyLabels.fiveHour;
        if (id === 'seven_day') return familyLabels.weekly;
        const meter = meters.find((candidate) => (candidate.providerLimitId ?? candidate.meterId) === id || candidate.meterId === id);
        return meter ? meter.label : id;
    });
    return [...new Set(labels)];
}
