import type { MeterTone } from '@/components/ui/lists/MeterBar';

/**
 * Canonical quota tone thresholds, expressed on REMAINING percentage.
 *
 * These are the single source of truth for the tone boundaries that were
 * previously copied across `connectedServiceQuotaGauge.ts` and
 * `AgentInputProviderUsageBadge.tsx`.
 * The `<= 10` critical boundary is INCLUSIVE — exactly 10% remaining is danger.
 */
export const QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT = 10;
export const QUOTA_REMAINING_WARNING_THRESHOLD_PCT = 25;

/**
 * Resolve a meter tone from a REMAINING percentage (0..100).
 *
 * - `null`/non-finite ⇒ `neutral` (no data, rendered grey).
 * - `<= 10` ⇒ `danger` (preserves the existing critical boundary).
 * - `<= 25` ⇒ `warning`.
 * - otherwise ⇒ `success`.
 */
export function resolveQuotaTone(remainingPct: number | null): MeterTone {
    if (remainingPct === null || !Number.isFinite(remainingPct)) return 'neutral';
    if (remainingPct <= QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT) return 'danger';
    if (remainingPct <= QUOTA_REMAINING_WARNING_THRESHOLD_PCT) return 'warning';
    return 'success';
}
