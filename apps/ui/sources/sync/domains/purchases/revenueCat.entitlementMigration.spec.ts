import { describe, expect, it, vi } from 'vitest';

import Purchases, { type PACKAGE_TYPE, type PRODUCT_TYPE, type PurchasesOffering, type PurchasesStoreProduct } from 'react-native-purchases';
import RevenueCatUI from 'react-native-purchases-ui';

import RevenueCat from './revenueCat';
import { PaywallResult } from './types';

describe('RevenueCat entitlement migration safety', () => {
  it('maps native offering packages through the RevenueCat product contract', async () => {
    const product = {
      identifier: 'voice.monthly', title: 'Voice', description: 'Monthly voice subscription',
      price: 10, priceString: '$10.00', currencyCode: 'USD',
      pricePerWeek: null, pricePerMonth: 10, pricePerYear: null,
      pricePerWeekString: null, pricePerMonthString: '$10.00', pricePerYearString: null,
      introPrice: null, discounts: [], productCategory: null, productType: 'AUTO_RENEWABLE_SUBSCRIPTION' as PRODUCT_TYPE,
      subscriptionPeriod: 'P1M', defaultOption: null, subscriptionOptions: null,
      presentedOfferingIdentifier: 'default', presentedOfferingContext: null, installmentsInfo: null,
    } satisfies PurchasesStoreProduct;
    const offering = {
      identifier: 'default', serverDescription: 'Default', metadata: {}, webCheckoutUrl: null,
      availablePackages: [{
        identifier: '$rc_monthly', packageType: 'MONTHLY' as PACKAGE_TYPE, product,
        offeringIdentifier: 'default', webCheckoutUrl: null,
        presentedOfferingContext: { offeringIdentifier: 'default', placementIdentifier: null, targetingContext: null },
      }],
      lifetime: null, annual: null, sixMonth: null, threeMonth: null, twoMonth: null, monthly: null, weekly: null,
    } satisfies PurchasesOffering;
    vi.spyOn(Purchases, 'getOfferings').mockResolvedValueOnce({ current: offering, all: { default: offering } });

    const result = await RevenueCat.getOfferings();
    const expected = {
      identifier: 'default',
      availablePackages: [{
        identifier: '$rc_monthly', packageType: 'MONTHLY',
        product: { identifier: 'voice.monthly', title: 'Voice', description: 'Monthly voice subscription', price: 10, priceString: '$10.00', currencyCode: 'USD' },
      }],
    };
    expect(result).toEqual({ current: expected, all: { default: expected } });
  });

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

