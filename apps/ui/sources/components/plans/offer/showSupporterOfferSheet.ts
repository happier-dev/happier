import type { SupporterOfferV1 } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { supportsHostedCheckout, supportsStoreCheckout, usesAccountBilling } from '@/sync/domains/purchases/purchaseFlow';

import { OfferSheet } from './OfferSheet';

/** Whether this device can pay for the Supporter offer: hosted checkout, or a store offering on native. */
export function canPurchaseSupporterOffer(offer: SupporterOfferV1): boolean {
    return supportsHostedCheckout() || (supportsStoreCheckout() && Boolean(offer.storeOfferingId));
}

/**
 * Opens the Supporter sheet. One opener for every entry point (Plans & Supporter, a locked app icon),
 * so the account, the code-paste rule and the greeting are decided in one place.
 */
export function showSupporterOfferSheet(params: Readonly<{ offer: SupporterOfferV1; prefilledCode?: string | null }>): void {
    const { profile } = storage.getState();
    Modal.show({
        component: OfferSheet,
        props: {
            offer: params.offer,
            accountId: profile.id,
            allowCodePaste: supportsHostedCheckout() && !usesAccountBilling(),
            prefilledCode: params.prefilledCode ?? null,
            profileName: profile.firstName,
        },
    });
}
