import * as React from 'react';

import { useHomeGovernanceEligibilitySnapshots } from '@/hooks/home/useHomeGovernanceEligibilitySnapshots';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveTeamsDestinationShown } from '@/sync/domains/teams/teamsSettingsAdmission';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

const EMPTY_SCOPES: readonly ServerAccountScope[] = Object.freeze([]);

/**
 * Whether navigation lists Teams for the capable Homes the feature admission found, as each Home
 * answers for this viewer. Observes only those Homes' small eligibility answers; the Teams directory
 * itself is not read.
 */
export function useTeamsDestinationShown(capableServerIds: readonly string[]): boolean {
    const scopeResolutions = useServerCredentialAccountScopeResolutions(capableServerIds);
    const scopes = React.useMemo(() => {
        const out: ServerAccountScope[] = [];
        for (const serverId of capableServerIds) {
            const resolution = scopeResolutions.get(resolveServerProfileScopeIdForIdentifier(serverId));
            if (resolution?.kind === 'bound') out.push(resolution.scope);
        }
        return out.length > 0 ? out : EMPTY_SCOPES;
    }, [capableServerIds, scopeResolutions]);
    const eligibility = useHomeGovernanceEligibilitySnapshots(scopes);

    return React.useMemo(() => {
        const showTeamsByServerId = new Map<string, boolean | undefined>();
        for (const serverId of capableServerIds) {
            const snapshot = eligibility.snapshotsByServerId.get(resolveServerProfileScopeIdForIdentifier(serverId));
            showTeamsByServerId.set(serverId, snapshot?.data?.showTeams);
        }
        return resolveTeamsDestinationShown({ capableServerIds, showTeamsByServerId });
    }, [capableServerIds, eligibility.snapshotsByServerId]);
}
