import Purchases, { 
    CustomerInfo as NativeCustomerInfo,
    PurchasesOffering,
    PurchasesOfferings,
    PurchasesStoreProduct,
    LOG_LEVEL
} from 'react-native-purchases';
import { 
    RevenueCatInterface, 
    CustomerInfo, 
    Product, 
    Offerings, 
    Offering,
    PurchaseResult,
    RevenueCatConfig,
    LogLevel
} from './types';

// Map native log levels to our common ones
const logLevelMap = {
    [LogLevel.VERBOSE]: LOG_LEVEL.VERBOSE,
    [LogLevel.DEBUG]: LOG_LEVEL.DEBUG,
    [LogLevel.INFO]: LOG_LEVEL.INFO,
    [LogLevel.WARN]: LOG_LEVEL.WARN,
    [LogLevel.ERROR]: LOG_LEVEL.ERROR
};

class RevenueCatNative implements RevenueCatInterface {
    configure(config: RevenueCatConfig): void {
        Purchases.configure({
            apiKey: config.apiKey,
            appUserID: config.appUserID,
            useAmazon: config.useAmazon || false
        });
    }

    async getCustomerInfo(): Promise<CustomerInfo> {
        const nativeInfo = await Purchases.getCustomerInfo();
        return this.transformCustomerInfo(nativeInfo);
    }

    async getOfferings(): Promise<Offerings> {
        const nativeOfferings = await Purchases.getOfferings();
        return this.transformOfferings(nativeOfferings);
    }

    async getProducts(productIds: string[]): Promise<Product[]> {
        const nativeProducts = await Purchases.getProducts(productIds);
        return nativeProducts.map(p => this.transformProduct(p));
    }

    async purchaseStoreProduct(product: Product, shouldContinue?: () => boolean): Promise<PurchaseResult | null> {
        // For native, we need to get the actual native product object
        const nativeProducts = await Purchases.getProducts([product.identifier]);
        if (nativeProducts.length === 0) {
            throw new Error(`Product ${product.identifier} not found`);
        }
        
        if (shouldContinue?.() === false) return null;
        const result = await Purchases.purchaseStoreProduct(nativeProducts[0]);
        return {
            customerInfo: this.transformCustomerInfo(result.customerInfo)
        };
    }

    async logIn(appUserId: string): Promise<void> {
        await Purchases.logIn(appUserId);
    }

    async restore(): Promise<CustomerInfo> {
        return this.transformCustomerInfo(await Purchases.restorePurchases());
    }

    async purchasePackage(offeringId: string, productId?: string, shouldContinue?: () => boolean): Promise<PurchaseResult | null> {
        const offerings = await Purchases.getOfferings();
        const packages = offerings.all[offeringId]?.availablePackages ?? [];
        const selected = productId
            ? packages.find((item) => item.product.identifier === productId)
            : packages.length === 1 ? packages[0] : undefined;
        if (!selected) throw new Error('Store package unavailable');
        if (shouldContinue?.() === false) return null;
        const result = await Purchases.purchasePackage(selected);
        return { customerInfo: this.transformCustomerInfo(result.customerInfo) };
    }

    setLogLevel(level: LogLevel): void {
        const nativeLevel = logLevelMap[level];
        if (nativeLevel !== undefined) {
            Purchases.setLogLevel(nativeLevel);
        }
    }

    // Transform native types to our common types
    private transformCustomerInfo(native: NativeCustomerInfo): CustomerInfo {
        return {
            activeSubscriptions: native.activeSubscriptions,
            managementURL: native.managementURL ?? null,
            entitlements: {
                all: Object.entries(native.entitlements.all || {}).reduce((acc, [key, entitlement]) => {
                    acc[key] = {
                        isActive: entitlement.isActive,
                        identifier: entitlement.identifier
                    };
                    return acc;
                }, {} as Record<string, { isActive: boolean; identifier: string }>)
            },
            originalAppUserId: native.originalAppUserId,
            requestDate: new Date(native.requestDate)
        };
    }

    private transformProduct(native: PurchasesStoreProduct): Product {
        return {
            identifier: native.identifier,
            priceString: native.priceString,
            price: native.price,
            currencyCode: native.currencyCode,
            title: native.title,
            description: native.description
        };
    }

    private transformOfferings(native: PurchasesOfferings): Offerings {
        const transformOffering = (offering: PurchasesOffering): Offering => ({
            identifier: offering.identifier,
            availablePackages: offering.availablePackages.map(pkg => ({
                identifier: pkg.identifier,
                packageType: pkg.packageType,
                product: this.transformProduct(pkg.product)
            }))
        });

        return {
            current: native.current ? transformOffering(native.current) : null,
            all: Object.fromEntries(Object.entries(native.all).map(([key, offering]) => [key, transformOffering(offering)]))
        };
    }
}

export default new RevenueCatNative();
