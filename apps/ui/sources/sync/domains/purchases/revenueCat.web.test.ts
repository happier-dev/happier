import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PaywallResult } from './types';

// RevenueCat is the external billing SDK; the adapter and transformations remain real.
const sdk = vi.hoisted(() => ({
    loaded: false,
    configure: vi.fn(),
    getCustomerInfo: vi.fn(),
    getOfferings: vi.fn(),
    purchase: vi.fn(),
}));

vi.mock('@revenuecat/purchases-js', () => {
    sdk.loaded = true;
    return { Purchases: { configure: sdk.configure } };
});

const customerInfo = {
    activeSubscriptions: {},
    entitlements: { all: { pro: { isActive: true, identifier: 'pro' } } },
    originalAppUserId: 'account-one',
    requestDate: '2026-10-09T12:00:00Z',
};
const product = {
    identifier: 'voice-monthly',
    currentPrice: { formattedPrice: '$10', amountMicros: 10_000_000, currency: 'USD' },
    title: 'Voice',
    description: 'Monthly voice',
};
const rcPackage = { identifier: 'monthly', webBillingProduct: product };
const offering = { identifier: 'default', availablePackages: [rcPackage] };

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.loaded = false;
    sdk.configure.mockReset().mockReturnValue(sdk);
    sdk.getCustomerInfo.mockReset().mockResolvedValue(customerInfo);
    sdk.getOfferings.mockReset().mockResolvedValue({ current: offering, all: { default: offering } });
    sdk.purchase.mockReset().mockResolvedValue({ customerInfo });
});

describe('web billing SDK demand loading', () => {
    it('keeps import and synchronous configuration lightweight, then shares initialization across requests', async () => {
        const { default: revenueCat } = await import('./revenueCat.web');
        expect(sdk.loaded).toBe(false);
        revenueCat.configure({ apiKey: 'web-key', appUserID: 'account-one' });
        expect(sdk.loaded).toBe(false);

        const [info, offerings] = await Promise.all([revenueCat.getCustomerInfo(), revenueCat.getOfferings()]);
        expect(sdk.configure).toHaveBeenCalledExactlyOnceWith({ apiKey: 'web-key', appUserId: 'account-one' });
        expect(info.entitlements.all.pro.isActive).toBe(true);
        expect(info.requestDate).toEqual(new Date(customerInfo.requestDate));
        expect(offerings.current?.availablePackages[0].product).toEqual({
            identifier: 'voice-monthly', priceString: '$10', price: 10,
            currencyCode: 'USD', title: 'Voice', description: 'Monthly voice',
        });
    });

    it('rejects an unconfigured request without loading the SDK', async () => {
        const { default: revenueCat } = await import('./revenueCat.web');
        await expect(revenueCat.getCustomerInfo()).rejects.toThrow('RevenueCat not configured');
        expect(sdk.loaded).toBe(false);
    });

    it('retries failed initialization and applies a subsequently configured account', async () => {
        const { default: revenueCat } = await import('./revenueCat.web');
        revenueCat.configure({ apiKey: 'web-key', appUserID: 'account-one' });
        sdk.configure.mockImplementationOnce(() => { throw new Error('SDK initialization failed'); });
        await expect(revenueCat.getCustomerInfo()).rejects.toThrow('SDK initialization failed');
        await expect(revenueCat.getCustomerInfo()).resolves.toMatchObject({ originalAppUserId: 'account-one' });

        revenueCat.configure({ apiKey: 'web-key', appUserID: 'account-two' });
        sdk.getCustomerInfo.mockResolvedValueOnce({ ...customerInfo, originalAppUserId: 'account-two' });
        await expect(revenueCat.getCustomerInfo()).resolves.toMatchObject({ originalAppUserId: 'account-two' });
        expect(sdk.configure).toHaveBeenLastCalledWith({ apiKey: 'web-key', appUserId: 'account-two' });
    });

    it('preserves product purchase, cancellation, entitlement checks, and recovery', async () => {
        const { default: revenueCat } = await import('./revenueCat.web');
        revenueCat.configure({ apiKey: 'web-key', appUserID: 'account-one' });
        const products = await revenueCat.getProducts(['voice-monthly']);
        expect(products).toHaveLength(1);
        await expect(revenueCat.purchaseStoreProduct(products[0])).resolves.toMatchObject({
            customerInfo: { originalAppUserId: 'account-one' },
        });
        expect(sdk.purchase).toHaveBeenCalledWith({ rcPackage });
        await expect(revenueCat.presentPaywallIfNeeded({ requiredEntitlementIdentifier: 'voice' }))
            .resolves.toBe(PaywallResult.NOT_PRESENTED);
        sdk.purchase.mockRejectedValueOnce({ code: 'UserCancelled' });
        await expect(revenueCat.presentPaywall()).resolves.toBe(PaywallResult.CANCELLED);
        await expect(revenueCat.presentPaywall()).resolves.toBe(PaywallResult.PURCHASED);
    });
});
