import { afterEach, describe, expect, it, vi } from 'vitest';

const revenueCatMock = vi.hoisted(() => ({
    setLogLevel: vi.fn(),
    configure: vi.fn(),
    syncPurchases: vi.fn(),
    getCustomerInfo: vi.fn(),
    getProducts: vi.fn(),
    purchaseStoreProduct: vi.fn(),
    presentPaywall: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/config', () => ({
    config: {
        revenueCatAppleKey: '',
        revenueCatGoogleKey: '',
        revenueCatStripeKey: 'stripe-key',
    },
}));

vi.mock('@/sync/domains/purchases', () => ({
    RevenueCat: revenueCatMock,
    LogLevel: { DEBUG: 'debug' },
    PaywallResult: {
        PURCHASED: 'purchased',
        RESTORED: 'restored',
        CANCELLED: 'cancelled',
        NOT_PRESENTED: 'not_presented',
        ERROR: 'error',
    },
}));

describe('syncPurchases scope guards', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('rejects a transient customer-info read so the retry owner can recover entitlements', async () => {
        const { syncPurchases } = await import('./syncPurchases');
        const failure = new TypeError('Failed to fetch');
        const customerInfo = { entitlements: { active: { pro: true } } };
        revenueCatMock.getCustomerInfo.mockRejectedValueOnce(failure).mockResolvedValueOnce(customerInfo);
        const applyPurchases = vi.fn();
        const params = {
            serverID: 'account-a', revenueCatInitialized: true,
            setRevenueCatInitialized: vi.fn(), applyPurchases,
        };

        await expect(syncPurchases(params)).rejects.toBe(failure);
        expect(applyPurchases).not.toHaveBeenCalled();
        await expect(syncPurchases(params)).resolves.toBeUndefined();
        expect(applyPurchases).toHaveBeenCalledWith(customerInfo);
    });

    it('drops fetched customer info when the captured sync scope is stale before apply', async () => {
        const { syncPurchases } = await import('./syncPurchases');
        revenueCatMock.getCustomerInfo.mockResolvedValue({ entitlements: { active: {} } });
        const applyPurchases = vi.fn();

        await syncPurchases({
            serverID: 'account-a',
            revenueCatInitialized: false,
            setRevenueCatInitialized: vi.fn(),
            applyPurchases,
            shouldContinue: () => false,
        } as Parameters<typeof syncPurchases>[0] & { shouldContinue: () => boolean });

        expect(applyPurchases).not.toHaveBeenCalled();
    });

    it('drops purchased customer info when the captured purchase scope becomes stale', async () => {
        const { purchaseProduct } = await import('./syncPurchases');
        let isCurrentScope = true;
        revenueCatMock.getProducts.mockResolvedValue([{ identifier: 'product-pro' }]);
        revenueCatMock.purchaseStoreProduct.mockImplementation(async () => {
            isCurrentScope = false;
            return { customerInfo: { entitlements: { active: { pro: true } } } };
        });
        const applyPurchases = vi.fn();

        const result = await purchaseProduct({
            revenueCatInitialized: true,
            productId: 'product-pro',
            applyPurchases,
            shouldContinue: () => isCurrentScope,
        } as Parameters<typeof purchaseProduct>[0] & { shouldContinue: () => boolean });

        expect(result.success).toBe(false);
        expect(applyPurchases).not.toHaveBeenCalled();
    });

    it('does not refresh purchases after a paywall result when the captured scope becomes stale', async () => {
        const { presentPaywall } = await import('./syncPurchases');
        let isCurrentScope = true;
        revenueCatMock.presentPaywall.mockImplementation(async () => {
            isCurrentScope = false;
            return 'purchased';
        });
        const syncPurchases = vi.fn();

        const result = await presentPaywall({
            revenueCatInitialized: true,
            trackPaywallPresented: vi.fn(),
            trackPaywallPurchased: vi.fn(),
            trackPaywallCancelled: vi.fn(),
            trackPaywallRestored: vi.fn(),
            trackPaywallError: vi.fn(),
            syncPurchases,
            shouldContinue: () => isCurrentScope,
        } as Parameters<typeof presentPaywall>[0] & { shouldContinue: () => boolean });

        expect(result.success).toBe(false);
        expect(syncPurchases).not.toHaveBeenCalled();
    });
});
