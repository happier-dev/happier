import { SupporterCodeV1Schema, type PlanDefinitionV1, type PlanPriceV1, type SupporterOfferV1 } from '@happier-dev/protocol';
import { Platform } from 'react-native';

import {
    fetchAccountSupporter,
    PlanSurfaceRequestError,
    postBillingRefresh,
    postSupporterLinkStart,
    postSupporterLookup,
    putAccountSupporter,
} from '@/sync/api/account/apiAccountPlan';
import { getAccountPlanEntry, refreshAccountPlan } from '@/sync/domains/plans/accountPlanResource';
import { HAPPIER_CLOUD_SERVER_URL, isHappierCloudServerUrl } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { getManagementURL, hasNativeStoreOffers, purchaseProduct, readSupporterStorePackages, restorePurchases, supportsNativeStorePurchases } from '@/sync/engine/purchases/syncPurchases';

/**
 * Web and desktop purchases for plans and the Supporter pack (plan 03, F1, F4, F6).
 *
 * A purchase is bound by `reference_id`: the Account on servers running billing, a random supporter
 * code elsewhere (stored on that server before the checkout opens, so a payment is never
 * unbound). The code is a bearer: it travels only in request bodies and the checkout link the
 * person opens, never in a Happier URL or an Action result.
 *
 * Native store operations use the account reference offered by the Home.
 */

export type CheckoutOpenResult = 'opened' | 'unavailable' | 'failed';
export type SupporterCodeApplyResult = 'applied' | 'invalid' | 'not_found' | 'conflict' | 'failed';

/** Expo web also hosts the desktop shell. */
export function supportsHostedCheckout(): boolean {
    return Platform.OS === 'web';
}

export function supportsStoreCheckout(): boolean {
    return supportsNativeStorePurchases() && hasNativeStoreOffers(getAccountPlanEntry().data);
}

function storeScope(accountId: string) {
    const scope = getActiveServerAccountScope();
    if (!scope || scope.accountId !== accountId) return null;
    return { appUserId: accountId, shouldContinue: () => areServerAccountScopesEqual(scope, getActiveServerAccountScope()) };
}

async function openStoreCheckout(params: Parameters<typeof purchaseProduct>[0]): Promise<CheckoutOpenResult> {
    const result = await purchaseProduct(params);
    if (!result.success) return 'failed';
    if (params.shouldContinue?.() !== false) {
        fireAndForget(checkPurchaseAgain(params.shouldContinue), { tag: 'refreshStorePurchase' });
    }
    return 'opened';
}

export function usesAccountBilling(): boolean {
    const reference = getAccountPlanEntry().data?.offers?.billingReference;
    return reference === undefined ? isHappierCloudServerUrl(getActiveServerSnapshot().serverUrl) : reference === 'account';
}

function mintSupporterCode(): string {
    return Array.from(getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The reference a purchase carries; on a self-hosted server this stores a fresh code first. */
export async function resolvePurchaseRef(params: Readonly<{ accountId: string }>): Promise<string> {
    if (usesAccountBilling()) return params.accountId;
    const existing = await fetchAccountSupporter();
    if (existing.record) return existing.record.code;
    const code = mintSupporterCode();
    await putAccountSupporter({ code });
    return code;
}

export function buildCheckoutUrl(params: Readonly<{ checkoutUrl: string; ref: string; amountMinor?: number }>): string {
    const url = new URL(params.checkoutUrl);
    url.searchParams.set('reference_id', params.ref);
    if (params.amountMinor !== undefined) url.searchParams.set('amount', String(params.amountMinor));
    return url.toString();
}

/** Opens the hosted checkout in the system browser. Nothing is paid until the person finishes there. */
async function openCheckout(params: Readonly<{
    checkoutUrl: string | null | undefined;
    accountId: string;
    /** Pay-what-you-like amount for the Supporter pack; omitted for a fixed-price plan. */
    amountMinor?: number;
}>): Promise<CheckoutOpenResult> {
    if (!params.checkoutUrl) return 'unavailable';
    try {
        const ref = await resolvePurchaseRef({ accountId: params.accountId });
        const opened = await openExternalUrl(buildCheckoutUrl({ checkoutUrl: params.checkoutUrl, ref, amountMinor: params.amountMinor }));
        return opened ? 'opened' : 'failed';
    } catch {
        return 'failed';
    }
}

export async function openPlanCheckout(params: Readonly<{
    plan: PlanDefinitionV1;
    interval: PlanPriceV1['interval'];
    accountId: string;
}>): Promise<CheckoutOpenResult> {
    const price = params.plan.prices.find((candidate) => candidate.interval === params.interval);
    if (supportsHostedCheckout()) return openCheckout({ checkoutUrl: price?.checkoutUrl, accountId: params.accountId });
    if (!supportsStoreCheckout() || !price || !(price.storeProductId || price.storeOfferingId)) return 'unavailable';
    const scope = storeScope(params.accountId);
    if (!scope) return 'unavailable';
    return openStoreCheckout({ ...scope, productId: price.storeProductId, offeringId: price.storeOfferingId });
}

export function openSupporterCheckout(params: Readonly<{
    offer: SupporterOfferV1;
    interval: 'monthly' | 'once';
    accountId: string;
    amountMinor?: number;
    storeProductId?: string;
}>): Promise<CheckoutOpenResult> {
    if (!supportsHostedCheckout()) {
        const { storeOfferingId } = params.offer;
        const scope = supportsStoreCheckout() ? storeScope(params.accountId) : null;
        if (!scope || !storeOfferingId || !params.storeProductId || params.interval !== 'once') return Promise.resolve('unavailable');
        return openStoreCheckout({ ...scope, offeringId: storeOfferingId, productId: params.storeProductId });
    }
    if (params.amountMinor !== undefined && params.amountMinor < params.offer.minimumMinor) return Promise.resolve('unavailable');
    return openCheckout({
        checkoutUrl: params.offer.checkoutUrls?.[params.interval],
        accountId: params.accountId,
        amountMinor: params.amountMinor,
    });
}

export function loadSupporterStorePackages(offer: SupporterOfferV1, accountId: string) {
    const scope = supportsStoreCheckout() ? storeScope(accountId) : null;
    return scope && offer.storeOfferingId ? readSupporterStorePackages(scope, offer.storeOfferingId) : Promise.resolve([]);
}

async function openSupporterLink(
    provider: 'discord' | 'github', accountId: string, readCode?: () => Promise<string | undefined>,
): Promise<boolean> {
    const scope = getActiveServerAccountScope();
    if (!scope || scope.accountId !== accountId) return false;
    const current = () => areServerAccountScopesEqual(scope, getActiveServerAccountScope());
    try {
        const code = await readCode?.();
        if ((readCode && !code) || !current()) return false;
        const url = await postSupporterLinkStart(provider, code);
        return url !== null && current() && await openExternalUrl(url);
    } catch {
        return false;
    }
}

export function openSupporterGitHubClaim(accountId: string): Promise<boolean> {
    if (!supportsHostedCheckout()) return Promise.resolve(false);
    return openSupporterLink('github', accountId, usesAccountBilling() ? undefined : () => resolvePurchaseRef({ accountId }));
}

export function openSupporterDiscordLink(accountId: string): Promise<boolean> {
    const cloudAccount = isHappierCloudServerUrl(getActiveServerSnapshot().serverUrl);
    return openSupporterLink('discord', accountId, cloudAccount ? undefined : async () => (await fetchAccountSupporter()).record?.code);
}

/** The provider authenticates the account holder by email code in its portal. */
export async function openBillingManage(portalUrl: string | null, native?: { accountId: string; source: string | null }): Promise<boolean> {
    try {
        if (native?.source === 'app_store' || native?.source === 'play') {
            if (supportsHostedCheckout()) {
                const url = native.source === 'app_store'
                    ? 'https://apps.apple.com/account/subscriptions'
                    : 'https://play.google.com/store/account/subscriptions';
                return await openExternalUrl(url);
            }
            const scope = supportsStoreCheckout() ? storeScope(native.accountId) : null;
            const url = scope ? await getManagementURL(scope) : null;
            return Boolean(url && scope?.shouldContinue() && await openExternalUrl(url));
        }
        return portalUrl ? await openExternalUrl(portalUrl) : false;
    } catch {
        return false;
    }
}

export async function restoreStorePurchases(accountId: string): Promise<void> {
    const scope = supportsStoreCheckout() ? storeScope(accountId) : null;
    if (scope && await restorePurchases(scope)) await checkPurchaseAgain(scope.shouldContinue);
}

async function settleSupporterCodeFromCloud(): Promise<void> {
    const own = await fetchAccountSupporter();
    if (!own.record) return;
    const facts = await postSupporterLookup(HAPPIER_CLOUD_SERVER_URL, own.record.code);
    if (facts) await putAccountSupporter({ code: own.record.code, facts });
}

/**
 * Check again: the read-your-own-write after a checkout. For account billing it asks the provider through the
 * server; elsewhere no server talks to Cloud, so the app asks Cloud about its code and stores the
 * answer on its own server. Either way the page then re-reads the plan once.
 */
export async function checkPurchaseAgain(shouldContinue: () => boolean = () => true): Promise<void> {
    if (!shouldContinue()) return;
    try {
        if (usesAccountBilling()) await postBillingRefresh();
        else await settleSupporterCodeFromCloud();
    } finally {
        if (shouldContinue()) await refreshAccountPlan();
    }
}

/** "Already a supporter? Paste your code" (web and desktop, self-hosted). */
export async function applySupporterCode(input: string): Promise<SupporterCodeApplyResult> {
    const parsed = SupporterCodeV1Schema.safeParse(input.trim().toLowerCase());
    if (!parsed.success) return 'invalid';
    try {
        const facts = await postSupporterLookup(HAPPIER_CLOUD_SERVER_URL, parsed.data);
        if (!facts) return 'not_found';
        await putAccountSupporter({ code: parsed.data, facts });
    } catch (error) {
        if (error instanceof PlanSurfaceRequestError && error.code === 'supporter_record_conflict') return 'conflict';
        return 'failed';
    }
    await refreshAccountPlan();
    return 'applied';
}
