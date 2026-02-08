import { describe, expect, it, vi } from 'vitest';

import Purchases from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';

import RevenueCat from './revenueCat';
import { PaywallResult } from './types';

describe('RevenueCat entitlement migration safety', () => {
  it('treats pro entitlement as satisfying voice paywall gating (native)', async () => {
    vi.spyOn(Purchases, 'getCustomerInfo').mockResolvedValueOnce({
      activeSubscriptions: [],
      entitlements: { all: { pro: { isActive: true, identifier: 'pro' } } },
      originalAppUserId: 'u',
      requestDate: new Date().toISOString(),
    } as any);

    const present = vi.spyOn(RevenueCatUI as any, 'presentPaywallIfNeeded');

    const res = await RevenueCat.presentPaywallIfNeeded({ requiredEntitlementIdentifier: 'voice' } as any);
    expect(res).toBe(PaywallResult.NOT_PRESENTED);
    expect(present).not.toHaveBeenCalled();
  });
});

