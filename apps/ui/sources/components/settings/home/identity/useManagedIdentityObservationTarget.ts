import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';
import { managedIdentityQueryKey } from '@/sync/store/home/governance/homeGovernanceSnapshots';

export function useManagedIdentityObservationTarget(scope: ServerAccountScope, teamId: string | null) {
    const credential = useServerCredentialAccountScopeBinding(scope.serverId);
    const binding = credential.binding?.isCurrent() && areServerAccountScopesEqual(credential.binding.scope, scope)
        ? credential.binding : null;
    return {
        queryKey: managedIdentityQueryKey(scope, teamId),
        binding,
        resolving: credential.resolution.kind === 'resolving',
    };
}

export function useManagedIdentityWake(serverId: string, teamId: string | null, refresh: () => void): void {
    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId !== serverId) return;
        const teamsChanged = event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1);
        if (teamId === null ? isHomeAdministrationAccountChange(event) || teamsChanged
            : event.entityIds === undefined || teamsChanged) refresh();
    }, { reconnect: 'refresh' }), [refresh, serverId, teamId]);
}
