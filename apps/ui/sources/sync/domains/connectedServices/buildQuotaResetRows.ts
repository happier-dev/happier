import type {
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditDetailsV1,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';

import { isConnectedServiceQuotaRecoveryCreditAvailable } from '@happier-dev/protocol/connect/connected-service-schemas';

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
    title?: string;
    description?: string;
    details?: ConnectedServiceQuotaRecoveryCreditDetailsV1;
}>;

function readCreditId(credit: ConnectedServiceQuotaRecoveryCreditV1): string | null {
    const raw = typeof credit.id === 'string' ? credit.id.trim() : '';
    return raw.length > 0 ? raw : null;
}

function normalizeFutureExpiry(expiresAtMs: number | null | undefined, nowMs: number): number | null {
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) return null;
    return expiresAtMs > nowMs ? expiresAtMs : null;
}

/**
 * Build per-credit QUOTA RESETS rows from a recovery-credit summary.
 *
 * - Identified, unexpired unknown credits remain informational rows.
 * - Only the authoritative available count and credit status permit consumption.
 * - Empty `credits[]` + positive `availableCount` ⇒ one aggregate placeholder
 *   row (`consumableCreditId: null`, `canUse: true`) consumed via the summary.
 *   A supplied summary expiry is shown without affecting consumption authority.
 * - Detailed credits ⇒ at most `availableCount` individually consumable rows.
 *   Missing-id and undisclosed/capped credits remain reachable through one
 *   aggregate-remainder row instead of consuming an unusable detail slot.
 */
export function buildQuotaResetRows(
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined,
    nowMs: number,
    formatter: ResetCountdownDaysFormatter,
    recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1,
): QuotaResetRow[] {
    if (!recoveryCredits) return [];

    const detailedCredits = Array.isArray(recoveryCredits.credits) ? recoveryCredits.credits : [];
    const aggregateExpiresAtMs = normalizeFutureExpiry(recoveryCredits.nextExpiresAtMs, nowMs);

    if (detailedCredits.length === 0) {
        if (recoveryCredits.availableCount <= 0) return [];
        return [{
            key: 'aggregate',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: aggregateExpiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, aggregateExpiresAtMs, formatter),
        }];
    }

    const individuallyConsumableCredits = detailedCredits
        .filter((credit) => isConnectedServiceQuotaRecoveryCreditAvailable(credit, nowMs))
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
            ...(credit.title ? { title: credit.title } : {}),
            ...(credit.description ? { description: credit.description } : {}),
            ...(recoveryCreditDetails?.[consumableCreditId] ? { details: recoveryCreditDetails[consumableCreditId] } : {}),
        };
    });
    const aggregateRemainder = Math.max(0, recoveryCredits.availableCount - individuallyConsumableCredits.length);
    if (aggregateRemainder > 0) {
        rows.push({
            key: 'aggregate-remainder',
            consumableCreditId: null,
            canUse: true,
            isAggregate: true,
            expiresAtMs: aggregateExpiresAtMs,
            countdownLabel: formatResetCountdownDays(nowMs, aggregateExpiresAtMs, formatter),
        });
    }
    for (const credit of detailedCredits) {
        if (credit.status !== 'unknown') continue;
        const id = readCreditId(credit);
        if (!id) continue;
        if (typeof credit.expiresAtMs === 'number' && credit.expiresAtMs <= nowMs) continue;
        const expiresAtMs = normalizeFutureExpiry(credit.expiresAtMs, nowMs);
        rows.push({
            key: id, consumableCreditId: null, canUse: false, isAggregate: false,
            expiresAtMs, countdownLabel: formatResetCountdownDays(nowMs, expiresAtMs, formatter),
            ...(credit.title ? { title: credit.title } : {}),
            ...(credit.description ? { description: credit.description } : {}),
            ...(recoveryCreditDetails?.[id] ? { details: recoveryCreditDetails[id] } : {}),
        });
    }
    return rows;
}
