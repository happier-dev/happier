// Vitest/node stub for `react-native-purchases` (RevenueCat).
// The real package depends on React Native native modules.

export const LOG_LEVEL = {
    VERBOSE: 'VERBOSE',
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
} as const;

export const CustomerInfo = {} as any;
export const PurchasesOfferings = {} as any;
export const PurchasesStoreProduct = {} as any;

const Purchases = {
    configure: () => {},
    getCustomerInfo: async () => ({
        activeSubscriptions: [],
        entitlements: { all: {} },
        originalAppUserId: 'test',
        requestDate: '2024-01-01T00:00:00.000Z',
    }),
    getOfferings: async () => ({ current: null, all: {} }),
    getProducts: async () => [],
    purchaseStoreProduct: async () => ({ customerInfo: await Purchases.getCustomerInfo() }),
    syncPurchases: async () => {},
    setLogLevel: () => {},
};

export default Purchases;
