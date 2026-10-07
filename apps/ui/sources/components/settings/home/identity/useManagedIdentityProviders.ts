import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ManagedIdentityProviderOwnerV1, ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

import {
    createManagedIdentityProviderClient,
    executeManagedIdentityProviderRead,
    type ManagedIdentityProviderActionOutput,
    type ManagedIdentityProviderSettledResult,
} from './managedIdentityProviderClient';
import {
    beginManagedIdentityProviderRefresh,
    INITIAL_MANAGED_IDENTITY_PROVIDER_STATE,
    settleManagedIdentityProviderRefresh,
    type ManagedIdentityProviderState,
} from './managedIdentityProviderState';

export function useManagedIdentityProviderClient(scope: ServerAccountScope) {
    return React.useMemo(
        () => createManagedIdentityProviderClient(scope),
        [scope.accountId, scope.serverId],
    );
}

export function useManagedIdentityProviders(
    scope: ServerAccountScope,
    owner: ManagedIdentityProviderOwnerV1 = { kind: 'home' },
    onApprovalPending?: (registration: ActionApprovalRegistration) => void,
): Readonly<{
    state: ManagedIdentityProviderState;
    refresh: () => void;
}> {
    const client = useManagedIdentityProviderClient(scope);
    const [state, setState] = React.useState(INITIAL_MANAGED_IDENTITY_PROVIDER_STATE);
    const [generation, setGeneration] = React.useState(0);
    const ownerTeamId = owner.kind === 'team' ? owner.teamId : null;
    const queryKey = `${scope.serverId}\u0000${scope.accountId}\u0000${ownerTeamId ?? 'home'}`;
    const previousQueryKeyRef = React.useRef(queryKey);
    const onApprovalPendingRef = React.useRef(onApprovalPending);
    onApprovalPendingRef.current = onApprovalPending;
    const refresh = React.useCallback(() => setGeneration((value) => value + 1), []);

    React.useEffect(() => {
        const controller = new AbortController();
        const queryChanged = previousQueryKeyRef.current !== queryKey;
        previousQueryKeyRef.current = queryKey;
        setState((current) => queryChanged
            ? INITIAL_MANAGED_IDENTITY_PROVIDER_STATE
            : beginManagedIdentityProviderRefresh(current));
        const exactOwner: ManagedIdentityProviderOwnerV1 = ownerTeamId === null
            ? { kind: 'home' }
            : { kind: 'team', teamId: ownerTeamId };
        const settle = (result: ManagedIdentityProviderSettledResult<Readonly<{
            items: readonly ManagedIdentityProviderV1[];
            unreadableCount: number;
        }>>) => {
            if (controller.signal.aborted) return;
            setState((current) => settleManagedIdentityProviderRefresh(current, result));
        };
        void executeManagedIdentityProviderRead<ManagedIdentityProviderActionOutput<'identity.providers.list'>>(
            (options) => client.execute('identity.providers.list', { owner: exactOwner }, options),
            {
                signal: controller.signal,
                onApprovalPending: (registration) => onApprovalPendingRef.current?.(registration),
            },
        ).then(settle);
        return () => controller.abort();
    }, [client, generation, ownerTeamId, queryKey]);

    React.useEffect(() => {
        return subscribeHomeAccountChange((event) => {
            if (event.serverId !== scope.serverId) return;
            if (ownerTeamId === null) {
                if (
                    !isHomeAdministrationAccountChange(event)
                    && !(event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) ?? false)
                ) return;
            } else if (
                event.entityIds !== undefined
                && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)
            ) return;
            refresh();
        });
    }, [ownerTeamId, refresh, scope.serverId]);

    return React.useMemo(() => ({ state, refresh }), [refresh, state]);
}
