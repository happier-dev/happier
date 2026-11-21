import {
    isConnectedServiceQuotaRecoveryCreditAvailable,
    type ConnectedServiceQuotaRecoveryCreditV1,
    type ConnectedServiceQuotaRecoveryCreditsV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';

export function readQuotaRecoveryCreditId(credit: ConnectedServiceQuotaRecoveryCreditV1): string | null {
    return credit.id?.trim() || null;
}

/** The provider count is authoritative even when detailed grants are capped or undisclosed. */
export function readQuotaResetOffers(inventory: ConnectedServiceQuotaRecoveryCreditsV1, now: number) {
    const { availableCount } = inventory;
    const eligible = inventory.credits.filter(credit => isConnectedServiceQuotaRecoveryCreditAvailable(credit, now));
    const identified = eligible.flatMap(credit => {
        const id = readQuotaRecoveryCreditId(credit);
        return id ? [{ credit, id }] : [];
    }).slice(0, availableCount);
    return { availableCount, identified, eligible, aggregateCount: availableCount - identified.length };
}

/** Unknown details and unenumerated offers leave acceptance to the effect-time owner. */
export function quotaResetOfferIsDefinitivelyAbsent(
    inventory: ConnectedServiceQuotaRecoveryCreditsV1,
    now: number,
    providerCreditId?: string,
): boolean {
    const offers = readQuotaResetOffers(inventory, now);
    if (providerCreditId === undefined ? offers.availableCount > 0
        : offers.aggregateCount > 0 || offers.identified.some(offer => offer.id === providerCreditId)) return false;
    return !inventory.credits.some(credit => credit.status === 'unknown'
        && (credit.expiresAtMs == null || credit.expiresAtMs > now)
        && (providerCreditId === undefined || readQuotaRecoveryCreditId(credit) === providerCreditId));
}
