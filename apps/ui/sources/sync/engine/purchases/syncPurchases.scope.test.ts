import { afterEach, describe, expect, it, vi } from 'vitest';

const revenueCatMock = vi.hoisted(() => ({
    setLogLevel: vi.fn(),
    configure: vi.fn(),
    getCustomerInfo: vi.fn(),
    getProducts: vi.fn(),
    getOfferings: vi.fn(),
    purchaseStoreProduct: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('@/config', () => ({
    config: {
        revenueCatAppleKey: 'apple-key',
        revenueCatGoogleKey: '',
    },
}));

vi.mock('@/sync/domains/purchases', () => ({
    RevenueCat: revenueCatMock,
    LogLevel: { DEBUG: 'debug' },
}));

describe('syncPurchases', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('does not configure RevenueCat when the captured sync scope is already stale', async () => {
        const { ensurePurchasesConfiguredAtLaunch } = await import('./syncPurchases');

        await ensurePurchasesConfiguredAtLaunch({
            accountId: 'account-a',
            storePlansOffered: true,
            shouldContinue: () => false,
        });

        expect(revenueCatMock.configure).not.toHaveBeenCalled();
    });

    it('reports a stale purchase scope as not successful', async () => {
        const { purchaseProduct } = await import('./syncPurchases');
        let isCurrentScope = true;
        revenueCatMock.getProducts.mockResolvedValue([{ identifier: 'product-pro' }]);
        revenueCatMock.purchaseStoreProduct.mockImplementation(async () => {
            isCurrentScope = false;
            return { customerInfo: { entitlements: { active: { pro: true } } } };
        });

        const result = await purchaseProduct({
            appUserId: 'account-a',
            productId: 'product-pro',
            shouldContinue: () => isCurrentScope,
        });

        expect(result.success).toBe(false);
    });

    it('lists the store-priced Supporter tiers only from the configured offering', async () => {
        const { readSupporterStorePackages } = await import('./syncPurchases');
        const tier = { identifier: 'o10', product: { identifier: 'supporter_once_10', priceString: '$9.99' } };
        revenueCatMock.getOfferings.mockResolvedValue({ all: { supporter_once: { availablePackages: [tier] } } });
        await expect(readSupporterStorePackages({ appUserId: 'account-a' }, 'supporter_once')).resolves.toEqual([tier]);
        await expect(readSupporterStorePackages({ appUserId: 'account-a' }, 'unconfigured')).resolves.toEqual([]);
    });
});
