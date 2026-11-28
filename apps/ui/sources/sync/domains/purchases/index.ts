// Main export that selects the correct implementation based on platform
// React Native's bundler will automatically choose .native.ts or .web.ts

export type {
    RevenueCatInterface,
    CustomerInfo,
    Product,
    Offerings,
    PurchaseResult,
    RevenueCatConfig,
    Offering,
    Package
} from './types';

// Export enums as values since they are used as runtime values
export { LogLevel } from './types';

// This will be resolved to either revenueCat.native.ts or revenueCat.web.ts
// based on the platform
export { default as RevenueCat } from './revenueCat';