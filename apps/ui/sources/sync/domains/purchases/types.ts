// Common types that work across both native and web platforms

export interface CustomerInfo {
    activeSubscriptions: readonly string[];
    entitlements: {
        all: Record<string, {
            isActive: boolean;
            identifier: string;
        }>;
    };
    originalAppUserId: string;
    requestDate: Date;
    managementURL: string | null;
}

export interface Product {
    identifier: string;
    priceString: string;
    price: number;
    currencyCode: string;
    title: string;
    description: string;
}

export interface Package {
    identifier: string;
    packageType: string;
    product: Product;
}

export interface Offering {
    identifier: string;
    availablePackages: Package[];
}

export interface Offerings {
    current: Offering | null;
    all: Record<string, Offering>;
}

export interface PurchaseResult {
    customerInfo: CustomerInfo;
}

export interface RevenueCatConfig {
    apiKey: string;
    appUserID: string;
    useAmazon?: boolean;
}

export enum LogLevel {
    VERBOSE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4
}

// Main interface that all platform implementations must follow
export interface RevenueCatInterface {
    configure(config: RevenueCatConfig): void;
    getCustomerInfo(): Promise<CustomerInfo>;
    getOfferings(): Promise<Offerings>;
    getProducts(productIds: string[]): Promise<Product[]>;
    purchaseStoreProduct(product: Product, shouldContinue?: () => boolean): Promise<PurchaseResult | null>;
    logIn(appUserId: string): Promise<void>;
    restore(): Promise<CustomerInfo>;
    purchasePackage(offeringId: string, productId?: string, shouldContinue?: () => boolean): Promise<PurchaseResult | null>;
    setLogLevel(level: LogLevel): void;
}
