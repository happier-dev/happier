import { Platform } from 'react-native';
import { config } from '@/config';
import { RevenueCat, LogLevel } from '@/sync/domains/purchases';
import type { AccountPlanResponseV1 } from '@happier-dev/protocol';

type PurchaseScope = { appUserId: string; shouldContinue?: () => boolean };
let configuredUser: string | null = null;
let pendingStoreOperation: Promise<unknown> = Promise.resolve();

function nativeKey(): string | undefined {
    return Platform.OS === 'ios' ? config.revenueCatAppleKey
        : Platform.OS === 'android' ? config.revenueCatGoogleKey
        : undefined;
}

export function supportsNativeStorePurchases(): boolean {
    return Boolean(nativeKey());
}

export function hasNativeStoreOffers(data: AccountPlanResponseV1 | null | undefined): boolean {
    const offers = data?.offers;
    return offers?.billingReference === 'account' && Boolean(offers.supporter?.storeOfferingId
        || offers.plans.some((plan) => plan.prices.some((price) => price.storeProductId || price.storeOfferingId)));
}

async function configureFor(appUserId: string, apiKey: string): Promise<void> {
    if (configuredUser === appUserId) return;
    if (configuredUser === null) {
        if (__DEV__) RevenueCat.setLogLevel(LogLevel.DEBUG);
        RevenueCat.configure({ apiKey, appUserID: appUserId });
    } else {
        await RevenueCat.logIn(appUserId);
    }
    configuredUser = appUserId;
}

function runStoreOperation<T>(scope: PurchaseScope, run: () => Promise<T>): Promise<T | null> {
    const apiKey = nativeKey();
    if (!apiKey || !scope.appUserId || scope.shouldContinue?.() === false) return Promise.resolve(null);
    // Keep a purchase or restore bound to the same native identity until the SDK settles it.
    const pending = pendingStoreOperation.then(async () => {
        if (scope.shouldContinue?.() === false) return null;
        await configureFor(scope.appUserId, apiKey);
        if (scope.shouldContinue?.() === false) return null;
        return await run();
    });
    pendingStoreOperation = pending.then(() => undefined, () => undefined);
    return pending;
}

export async function ensurePurchasesConfiguredAtLaunch(params: {
    accountId: string;
    storePlansOffered: boolean;
    shouldContinue?: () => boolean;
}): Promise<void> {
    if (!params.storePlansOffered) return;
    await runStoreOperation({ appUserId: params.accountId, shouldContinue: params.shouldContinue }, async () => undefined);
}

export async function purchaseProduct(params: PurchaseScope & {
    productId?: string;
    offeringId?: string;
}): Promise<{ success: boolean; error?: string }> {
    try {
        const purchased = await runStoreOperation(params, async () => {
            if (params.offeringId) {
                return await RevenueCat.purchasePackage(params.offeringId, params.productId, params.shouldContinue);
            }
            if (!params.productId) return null;
            const [product] = await RevenueCat.getProducts([params.productId]);
            if (!product || params.shouldContinue?.() === false) return null;
            return await RevenueCat.purchaseStoreProduct(product, params.shouldContinue);
        });
        return { success: purchased !== null && params.shouldContinue?.() !== false };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Purchase failed' };
    }
}

export async function readSupporterStorePackages(scope: PurchaseScope, offeringId: string) {
    const offerings = await runStoreOperation(scope, () => RevenueCat.getOfferings());
    return scope.shouldContinue?.() === false ? [] : offerings?.all[offeringId]?.availablePackages ?? [];
}

export async function restorePurchases(scope: PurchaseScope): Promise<boolean> {
    const customerInfo = await runStoreOperation(scope, () => RevenueCat.restore());
    return customerInfo !== null && scope.shouldContinue?.() !== false;
}

export async function getManagementURL(scope: PurchaseScope): Promise<string | null> {
    const info = await runStoreOperation(scope, () => RevenueCat.getCustomerInfo());
    return scope.shouldContinue?.() === false ? null : info?.managementURL ?? null;
}
