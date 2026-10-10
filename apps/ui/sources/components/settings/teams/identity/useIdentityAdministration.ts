import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { serverAccountScopedTeamKey } from '@/sync/domains/teams/teamAddress';
import { isHomeAdministrationAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import { createIdentityAdministrationClient, executeIdentityAdministrationRead, type TeamIdentityActionOutput } from './identityAdministrationClient';
import {
    beginIdentityAdministrationRefresh,
    INITIAL_IDENTITY_ADMINISTRATION_STATE,
    settleIdentityAdministrationRefresh,
    type IdentityAdministrationState,
} from './identityAdministrationState';

export type IdentityAdministrationBinding = Readonly<{
    state: IdentityAdministrationState;
    refresh: () => void;
}>;

type BoundIdentityAdministrationState = Readonly<{
    bindingKey: string;
    value: IdentityAdministrationState;
}>;

/**
 * Route-local identity connection projection for one exact Home/Account/Team.
 *
 * The server remains the authority. This hook retains only the last list answer
 * needed to preserve same-scope refresh continuity. State is qualified by the
 * canonical exact-Team key, so an old render or answer cannot cross scope.
 */
export function useIdentityAdministration(
    scope: ServerAccountScope,
    teamId: string | null,
    onApprovalPending?: (registration: ActionApprovalRegistration) => void,
): IdentityAdministrationBinding {
    const bindingKey = teamId === null
        ? `${serverAccountScopeKeySuffix(scope)}:home-identity`
        : serverAccountScopedTeamKey(scope, { serverId: scope.serverId, teamId });
    const [boundState, setBoundState] = React.useState<BoundIdentityAdministrationState>(() => ({
        bindingKey,
        value: INITIAL_IDENTITY_ADMINISTRATION_STATE,
    }));
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(scope, { onApprovalPending }),
        [scope.serverId, scope.accountId, onApprovalPending],
    );
    const state = boundState.bindingKey === bindingKey
        ? boundState.value
        : INITIAL_IDENTITY_ADMINISTRATION_STATE;

    React.useEffect(() => {
        const controller = new AbortController();
        setBoundState((current) => ({
            bindingKey,
            value: current.bindingKey === bindingKey
                ? beginIdentityAdministrationRefresh(current.value)
                : INITIAL_IDENTITY_ADMINISTRATION_STATE,
        }));
        void executeIdentityAdministrationRead<TeamIdentityActionOutput<'teams.identity.connections.list'>>((options) => client.execute(
            'teams.identity.connections.list',
            { v: 1, teamId },
            options,
        ), controller.signal).then((result) => {
            if (controller.signal.aborted) return;
            setBoundState((current) => current.bindingKey !== bindingKey
                ? current
                : {
                    bindingKey,
                    value: settleIdentityAdministrationRefresh(
                        current.value,
                        result.ok
                            ? {
                                ok: true,
                                items: result.value.items,
                                eligibleProviders: result.value.eligibleProviders,
                                admissionModeApplicability: 'admissionModeApplicability' in result.value ? result.value.admissionModeApplicability : null,
                                memberSignInUrl: 'memberSignInUrl' in result.value ? result.value.memberSignInUrl : null,
                            }
                            : { ok: false, failure: result.failure },
                    ),
                });
        });
        return () => controller.abort();
    }, [bindingKey, client, teamId, refreshGeneration]);

    const refresh = React.useCallback(() => {
        // Publish the transition synchronously so return-to-app consumers can
        // wait for the new authoritative projection instead of acting on the
        // last screen snapshot while the request effect is being scheduled.
        setBoundState((current) => current.bindingKey !== bindingKey
            ? current
            : { bindingKey, value: beginIdentityAdministrationRefresh(current.value) });
        setRefreshGeneration((current) => current + 1);
    }, [bindingKey]);

    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId !== scope.serverId) return;
        if (teamId === null ? !isHomeAdministrationAccountChange(event)
            : event.entityIds !== undefined && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
        refresh();
    }), [refresh, scope.serverId, teamId]);

    return React.useMemo(() => ({ state, refresh }), [state, refresh]);
}
