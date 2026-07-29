import type {
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol';

import { formatResetCountdownDays, type ResetCountdownDaysFormatter } from './formatResetCountdown';

export type QuotaResetRow = Readonly<{
    /** Stable React key — the credit `id` when present, else the row index. */
    key: string;
    /** Provider credit id to consume, or `null` for the aggregate fallback. */
    consumableCreditId: string | null;
    /** Whether the `Use` action is permitted (has an id, or is the aggregate). */
    canUse: boolean;
    /** True for the single placeholder row when only an available count is known. */
    isAggregate: boolean;
    expiresAtMs: number | null;
    countdownLabel: string | null;
}>;

function readCreditId(credit: ConnectedServiceQuotaRecoveryCreditV1): string | null {
    const raw = typeof credit.id === 'string' ? credit.id.trim() : '';
    return raw.length > 0 ? raw : null;
}

function isAvailableCredit(credit: ConnectedServiceQuotaRecoveryCreditV1, nowMs: number): boolean {
    if (credit.status !== 'available') return false;
    if (typeof credit.expiresAtMs !== 'number' || !Number.isFinite(credit.expiresAtMs)) return true;
    return credit.expiresAtMs > nowMs;
}

function normalizeFutureExpiry(expiresAtMs: number | null | undefined, nowMs: number): number | null {
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return null;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

/**
 * Build per-credit QUOTA RESETS rows from a recovery-credit summary.
 *
 * - No available count ⇒ no rows.
 * - Empty `credits[]` + positive `availableCount` ⇒ one aggregate placeholder
 *   row (`consumableCreditId: null`, `canUse: true`) consumed via the summary.
 *   The recovery-credits payload carries no aggregate expiry, so the row has no
 *   countdown.
 * - Detailed credits ⇒ at most `availableCount` individually consumable rows.
 *   Missing-id and undisclosed/capped credits remain reachable through one
 *   aggregate-remainder row instead of consuming an unusable detail slot.
 */
export function buildQuotaResetRows(
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
    nowMs: number,
    formatter: ResetCountdownDaysFormatter,
): QuotaResetRow[] {
    if (!recoveryCredits || recoveryCredits.availableCount <= 0) return [];

    const detailedCredits = Array.isArray(recoveryCredits.credits) ? recoveryCredits.credits : [];

    if (detailedCredits.length === 0) {
        return [{
            key: 'aggregate',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: null,
            countdownLabel: null,
        }];
    }

    const individuallyConsumableCredits = detailedCredits
        .filter((credit) => isAvailableCredit(credit, nowMs))
        .map((credit) => ({ credit, consumableCreditId: readCreditId(credit) }))
        .filter((entry): entry is Readonly<{
            credit: ConnectedServiceQuotaRecoveryCreditV1;
            consumableCreditId: string;
        }> => entry.consumableCreditId !== null)
        .slice(0, recoveryCredits.availableCount);
    const rows: QuotaResetRow[] = individuallyConsumableCredits.map(({ credit, consumableCreditId }) => {
        const expiresAtMs = normalizeFutureExpiry(credit.expiresAtMs, nowMs);
        return {
            key: consumableCreditId,
            consumableCreditId,
            canUse: true,
            isAggregate: false,
            expiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
        };
    });
    const aggregateRemainder = Math.max(0, recoveryCredits.availableCount - individuallyConsumableCredits.length);
    if (aggregateRemainder > 0) {
        rows.push({
            key: 'aggregate-remainder',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: null,
            countdownLabel: null,
        });
    }
    return rows;
}
