import { t } from '@/text';
import type { ConnectedServiceCredentialHealthStatusV1 } from '@happier-dev/protocol';

/**
 * The one credential-health → user-facing label mapping for connected accounts.
 * Every surface that names a credential status (account detail, service detail)
 * reads it here so the four states can never drift into per-screen wording.
 */
export function resolveConnectedAccountCredentialStatusLabel(
    status: ConnectedServiceCredentialHealthStatusV1,
): string {
    if (status === 'connected') return t('connectedServices.detail.profiles.connected');
    if (status === 'refreshing') return t('connectedServices.detail.profiles.refreshing');
    if (status === 'refresh_failed_retryable') {
        return t('connectedServices.detail.profiles.refreshFailedRetryable');
    }
    return t('connectedServices.detail.profiles.needsReauth');
}
