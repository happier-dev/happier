import type { TeamCredentialResourceStatus } from '@/sync/domains/teams/teamCredentialResourceStatus';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { t } from '@/text';
import { credentialFailureMessage } from './teamCredentialPresentation';

/** Present the catalog's decision without inferring a cause from missing rows. */
export function teamCredentialCatalogStatusLabel(status: TeamCredentialResourceStatus): string | null {
    switch (status.kind) {
        case 'current': return null;
        case 'pending': return t('common.loading');
        case 'homeUnreachable': return t('teams.unavailable.offline');
        case 'failed': return status.reason
            ? credentialFailureMessage({ kind: status.reason, code: status.code, retryable: false })
            : t(presentProviderError(status.code).descriptionKey);
    }
}
