import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import type { TeamCredentialResourceStatus } from '@/sync/domains/teams/teamCredentialResourceStatus';
import { presentConnectedAccountSignedOut } from '@/components/settings/connectedServices/account/connectedAccountCredentialStatusLabel';
import { teamCredentialReconnectPresentation } from './sourceHealthPresentation';
import type { TeamCredentialRecoveryPresentation } from './teamCredentialPresentation';

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

/**
 * A few words for why a shared credential can't be used right now, for rows grouped under "Unavailable" in a
 * picker. The full sentence stays the row's accessible description; a source whose account is signed out reads
 * like every other signed-out account.
 */
export function resourceShortUnavailableLabel(
    readiness: TeamCredentialResourceReadinessV1,
    status?: TeamCredentialResourceStatus,
): string {
    if (status?.kind === 'homeUnreachable') return t('teams.credentials.unavailableShort.homeOffline');
    if (status?.kind === 'pending') return t('common.loading');
    if (status?.kind === 'failed') return t('common.unavailable');
    switch (readiness.kind) {
        case 'available': return t('common.unavailable');
        case 'broker_unavailable': return t('teams.credentials.unavailableShort.brokerOffline');
        case 'source_unavailable': return teamCredentialReconnectPresentation(readiness.reason)
            ? presentConnectedAccountSignedOut().state
            : t('teams.credentials.unavailableShort.sourceRemoved');
        case 'resource_corrupt':
        case 'resource_unavailable': return t('teams.credentials.unavailableShort.sourceRemoved');
        case 'update_required': return t('teams.credentials.unavailableShort.updateNeeded');
        case 'policy_denied': return t('teams.credentials.unavailableShort.notAllowed');
        case 'limit_reached': return t('teams.credentials.limits.reached');
    }
}

/** The short next step beside that reason: a member who can't repair the source is told who can. */
export function recoveryShortLabel(recovery: TeamCredentialRecoveryPresentation): string {
    return recovery.destination === 'source_owner_handoff'
        ? t('teams.credentials.unavailableShort.askOwner')
        : t(recovery.labelKey);
}
