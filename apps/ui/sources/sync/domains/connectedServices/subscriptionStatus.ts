import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol';

import { t } from '@/text';

export type ConnectedServiceSubscriptionStatus = 'renewing' | 'ending' | 'active' | 'none' | 'unavailable';
export type ConnectedServiceSubscriptionStatusTone = 'on' | 'off' | 'unknown';

/** One status for every subscription surface (account settings and the session usage popover). */
export function resolveConnectedServiceSubscriptionStatus(
    subscription: Pick<ProviderAccountSubscriptionV1, 'status' | 'renewal'>,
): ConnectedServiceSubscriptionStatus {
    if (subscription.status === 'none') return 'none';
    if (subscription.status === 'unavailable') return 'unavailable';
    if (subscription.renewal === 'on') return 'renewing';
    if (subscription.renewal === 'off') return 'ending';
    // Some providers (Claude) attest an active subscription but expose no renewal or period end.
    return 'active';
}

export function resolveConnectedServiceSubscriptionStatusTone(
    status: ConnectedServiceSubscriptionStatus,
): ConnectedServiceSubscriptionStatusTone {
    if (status === 'renewing' || status === 'active') return 'on';
    if (status === 'ending' || status === 'none') return 'off';
    return 'unknown';
}

export function resolveConnectedServiceSubscriptionStatusLabel(status: ConnectedServiceSubscriptionStatus): string {
    switch (status) {
        case 'renewing': return t('connectedServices.subscription.renewalOn');
        case 'ending': return t('connectedServices.subscription.renewalOff');
        case 'active': return t('connectedServices.subscription.active');
        case 'none': return t('connectedServices.subscription.none');
        case 'unavailable': return t('connectedServices.subscription.unavailable');
    }
}
