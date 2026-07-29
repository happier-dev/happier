import type { UnistylesThemes } from 'react-native-unistyles';

import type { MeterTone } from '@/components/ui/lists/MeterBar';
import type { StatusPillVariant } from '@/components/ui/status/StatusPill';
import type { AccountHealth } from '@/sync/domains/connectedServices/deriveAccountHealth';
import type { ConnectedServiceQuotaGaugeMeterRow } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
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
    /** Remaining fraction in 0..1 (the MeterBar shrinks as quota depletes). */
    remaining: number;
    detailLabel: string;
}>;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

/**
 * Map the gauge's comparable meter rows onto the AccountBlock USAGE rows. Tone is
 * derived from the SAME `resolveQuotaTone` owner the meter bars and health dot
 * use, and `remaining` is normalized to the 0..1 fraction `MeterBar` expects.
 */
export function resolveAccountUsageRows(
    meterRows: ReadonlyArray<ConnectedServiceQuotaGaugeMeterRow> | null | undefined,
): AccountUsageRow[] {
    if (!meterRows || meterRows.length === 0) return [];
    return meterRows.map((row) => ({
        meterId: row.meterId,
        label: row.label,
        tone: resolveQuotaTone(row.remainingPct),
        remaining: clamp01(row.remainingPct / 100),
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
        .map((row) => ({ ratio: row.remaining, tone: row.tone }))
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, MAX_CAPACITY_RINGS);
}
