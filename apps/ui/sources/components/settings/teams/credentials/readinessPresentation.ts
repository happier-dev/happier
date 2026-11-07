import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import { teamCredentialReconnectPresentation } from './sourceHealthPresentation';

export type TeamCredentialResourceState = TeamCredentialResourceReadinessV1['kind'];

/** Keep the Home's typed reason rather than reducing readiness to its kind at the UI boundary. */
export function resourceStateLabel(
    readiness: TeamCredentialResourceState | TeamCredentialResourceReadinessV1,
    sourceOwnerDisplayName?: string | null,
): string {
    const state = typeof readiness === 'string' ? readiness : readiness.kind;
    if (typeof readiness !== 'string' && readiness.kind === 'source_unavailable') {
        const reconnect = teamCredentialReconnectPresentation(readiness.reason, sourceOwnerDisplayName);
        if (reconnect) return reconnect.message;
    }
    switch (state) {
        case 'available': return t('teams.credentials.state.available');
        case 'resource_unavailable': return t('teams.credentials.state.disabled');
        case 'resource_corrupt':
        case 'source_unavailable': return t('teams.credentials.errors.sourceMissing');
        case 'broker_unavailable': return t('teams.credentials.errors.brokerUnavailable');
        case 'update_required': return t('teams.unavailable.updateRequired');
        case 'policy_denied': return t('teams.credentials.forbidden');
        case 'limit_reached': return t('teams.credentials.limits.reached');
    }
}
