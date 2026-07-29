import { clampQuotaPct } from './deriveQuotaUtilizationPct';

export type AccountCapacityMeterRow = Readonly<{ remainingPct: number }>;

/**
 * Derive an account's capacity as the MINIMUM remaining percentage across its
 * meter rows (the most-constrained window governs usable capacity). Returns
 * `null` when there are no finite rows.
 */
export function deriveAccountCapacityPct(
    meterRows: ReadonlyArray<AccountCapacityMeterRow>,
): number | null {
    let minRemainingPct = Number.POSITIVE_INFINITY;
    for (const row of meterRows) {
        if (typeof row.remainingPct === 'number' && Number.isFinite(row.remainingPct)) {
            minRemainingPct = Math.min(minRemainingPct, clampQuotaPct(row.remainingPct));
        }
    }
    return Number.isFinite(minRemainingPct) ? minRemainingPct : null;
}
