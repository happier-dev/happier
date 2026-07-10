export type PendingMaterializationActiveTurnPolicy = 'block' | 'allow_live_delivery';
export type ProviderAcceptancePendingMaterializationPolicy = 'claimUntilProviderAccept' | 'commitAtMaterialize';

export function normalizePendingMaterializationActiveTurnPolicy(
  value: PendingMaterializationActiveTurnPolicy | undefined,
): PendingMaterializationActiveTurnPolicy {
  return value === 'allow_live_delivery' ? 'allow_live_delivery' : 'block';
}

export function blocksPendingMaterializationDuringActiveTurn(
  value: PendingMaterializationActiveTurnPolicy | undefined,
): boolean {
  return normalizePendingMaterializationActiveTurnPolicy(value) !== 'allow_live_delivery';
}

export function normalizeProviderAcceptancePendingMaterializationPolicy(
  value: ProviderAcceptancePendingMaterializationPolicy | undefined,
): ProviderAcceptancePendingMaterializationPolicy {
  return value === 'commitAtMaterialize' ? 'commitAtMaterialize' : 'claimUntilProviderAccept';
}

export function recoversProviderDeliveryAttachBeforeMaterialization(
  value: ProviderAcceptancePendingMaterializationPolicy | undefined,
): boolean {
  return normalizeProviderAcceptancePendingMaterializationPolicy(value) === 'claimUntilProviderAccept';
}
