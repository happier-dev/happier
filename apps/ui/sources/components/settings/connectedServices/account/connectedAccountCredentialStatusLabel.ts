import { t } from '@/text';
import type { ConnectedServiceCredentialHealthStatusV1, ConnectedServiceCredentialRefreshFailureKindV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

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
            return t('connectedServicesSettings.signedOut');
    }
    return t('connectedServicesSettings.signedOutWithReason', { reason });
}
