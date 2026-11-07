import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';
import type { ConnectedServiceCredentialHealthStatusV1, ConnectedServiceCredentialRefreshFailureKindV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { isConnectedServiceCredentialHealthStatusUsable } from '@happier-dev/protocol/connect/connected-service-schemas';

/**
 * The one credential-health → user-facing label mapping for connected accounts.
 * Every surface reads the producer's optional reason here, without inferring
 * expiry, revocation or plan from a credential failure category.
 */
export function resolveConnectedAccountCredentialStatusLabel(
    status: ConnectedServiceCredentialHealthStatusV1,
    statusReason?: ConnectedServiceCredentialRefreshFailureKindV1,
): string {
    if (status === 'connected') return t('connectedServices.detail.profiles.connected');
    if (status === 'refreshing') return t('connectedServices.detail.profiles.refreshing');
    if (status === 'refresh_failed_retryable') {
        return t('connectedServices.detail.profiles.refreshFailedRetryable');
    }
    let reason: string;
    switch (statusReason) {
        case 'invalid_grant':
        case 'provider_401':
        case 'provider_403':
            reason = t('connectedServicesSettings.signInNoLongerAccepted');
            break;
        case 'invalid_client':
            reason = t('connectedServicesSettings.appAccessRemoved');
            break;
        case 'missing_refresh_token':
            reason = t('connectedServicesSettings.cannotRefreshByItself');
            break;
        default:
            return presentConnectedAccountSignedOut().state;
    }
    return t('connectedServicesSettings.signedOutWithReason', { reason });
}

/** Whether a connected account's credential has stopped working until someone signs in again. */
export function isConnectedAccountSignedOut(status: ConnectedServiceCredentialHealthStatusV1 | null | undefined): boolean {
    return status != null && !isConnectedServiceCredentialHealthStatusUsable(status);
}

/**
 * The one vocabulary for a signed-out connected account, on every surface (rail, pool members, Runs through,
 * Home): the state, its next step, and the two joined where a row has no room for a button.
 */
export function presentConnectedAccountSignedOut(): Readonly<{ state: string; action: string; phrase: string }> {
    const state = t('connectedServicesSettings.signedOut');
    const action = t('connectedServicesSettings.signInAgain');
    return { state, action, phrase: joinHappierFacts(state, action) };
}
