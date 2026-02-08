import type { CustomerInfo } from './types';

function isEntitlementActive(customerInfo: CustomerInfo, entitlementId: string): boolean {
  const entry = customerInfo.entitlements?.all?.[entitlementId];
  return Boolean(entry?.isActive);
}

/**
 * Migration-safe entitlement check.
 *
 * RevenueCat entitlements are configured externally and may not be migrated
 * (e.g. older users may only have `pro` while newer users have `voice`).
 *
 * Contract: for voice gating, treat `pro` and `voice` as equivalent.
 */
export function hasRequiredEntitlement(customerInfo: CustomerInfo, requiredEntitlementIdentifier: string): boolean {
  const required = requiredEntitlementIdentifier.trim();
  if (!required) return false;
  if (required === 'voice' || required === 'pro') {
    return isEntitlementActive(customerInfo, 'voice') || isEntitlementActive(customerInfo, 'pro');
  }
  return isEntitlementActive(customerInfo, required);
}

