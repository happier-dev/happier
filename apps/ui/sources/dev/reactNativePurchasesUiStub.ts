// Vitest/node stub for `react-native-purchases-ui` (RevenueCat UI).
// The real package depends on React Native native modules and UI primitives.

export const PAYWALL_RESULT = {
    NOT_PRESENTED: 'NOT_PRESENTED',
    ERROR: 'ERROR',
    CANCELLED: 'CANCELLED',
    PURCHASED: 'PURCHASED',
    RESTORED: 'RESTORED',
} as const;

const RevenueCatUI = {
    presentPaywall: async (_options?: { offering?: any }) => PAYWALL_RESULT.NOT_PRESENTED,
    presentPaywallIfNeeded: async (_params: {
        requiredEntitlementIdentifier: string;
        offering?: any;
        displayCloseButton?: boolean;
        fontFamily?: string | null;
    }) => PAYWALL_RESULT.NOT_PRESENTED,
};

export default RevenueCatUI;
