import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ManagedIdentityProviderOwnerV1 } from '@happier-dev/protocol/identity/providers';

import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import {
    applyManagedIdentityProviderObservation,
    getManagedIdentityProviderObservation,
    managedIdentityProviderQueryKey,
} from '@/sync/store/home/governance/homeGovernanceSnapshots';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

import {
    createManagedIdentityProviderClient,
    executeManagedIdentityProviderRead,
    type ManagedIdentityProviderActionOutput,
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
    requiredProviderId?: string,
): Readonly<{
    state: ManagedIdentityProviderState;
    refresh: () => void;
}> {
    const client = useManagedIdentityProviderClient(scope);
    const ownerTeamId = owner.kind === 'team' ? owner.teamId : null;
    const queryKey = managedIdentityProviderQueryKey(scope, ownerTeamId);
    const credential = useServerCredentialAccountScopeBinding(scope.serverId);
    const binding = credential.binding?.isCurrent() && areServerAccountScopesEqual(credential.binding.scope, scope)
        ? credential.binding : null;
    const resolving = credential.resolution.kind === 'resolving';
    const [observation, setObservation] = React.useState(() => ({
        queryKey, binding, state: INITIAL_MANAGED_IDENTITY_PROVIDER_STATE,
    }));
    const [generation, setGeneration] = React.useState(0);
    const hasMountedObservation = !resolving && observation.queryKey === queryKey && observation.binding === binding;
    const retained = !hasMountedObservation && (binding || resolving)
        ? getManagedIdentityProviderObservation(queryKey) : undefined;
    const seed = React.useMemo(() => retained === undefined
        ? INITIAL_MANAGED_IDENTITY_PROVIDER_STATE
        : beginManagedIdentityProviderRefresh(settleManagedIdentityProviderRefresh(
            INITIAL_MANAGED_IDENTITY_PROVIDER_STATE, { kind: 'succeeded', value: retained },
        )), [retained]);
    const projected = hasMountedObservation ? observation.state : seed;
    // An older list can show a known row, but cannot establish that a newly
    // opened provider is missing while its current list is arriving.
    const state = React.useMemo<ManagedIdentityProviderState>(() => {
        if (!requiredProviderId || projected.kind !== 'ready'
            || projected.items.some(provider => provider.id === requiredProviderId)) return projected;
        if (projected.refreshing) return INITIAL_MANAGED_IDENTITY_PROVIDER_STATE;
        return projected.failure ? { kind: 'unavailable', failure: projected.failure } : projected;
    }, [projected, requiredProviderId]);
    const onApprovalPendingRef = React.useRef(onApprovalPending);
    onApprovalPendingRef.current = onApprovalPending;
    const refresh = React.useCallback(() => setGeneration((value) => value + 1), []);

    React.useEffect(() => {
        if (resolving) return;
        const controller = new AbortController();
        setObservation(current => ({
            queryKey, binding,
            state: current.queryKey === queryKey && current.binding === binding
                ? beginManagedIdentityProviderRefresh(current.state) : seed,
        }));
        const exactOwner: ManagedIdentityProviderOwnerV1 = ownerTeamId === null
            ? { kind: 'home' }
            : { kind: 'team', teamId: ownerTeamId };
        void executeManagedIdentityProviderRead<ManagedIdentityProviderActionOutput<'identity.providers.list'>>(
            (options) => client.execute('identity.providers.list', { owner: exactOwner }, options),
            {
                signal: controller.signal,
                onApprovalPending: (registration) => onApprovalPendingRef.current?.(registration),
            },
        ).then(result => {
            if (controller.signal.aborted || (binding && !binding.isCurrent())) return;
            if (binding && result.kind === 'succeeded') applyManagedIdentityProviderObservation(queryKey, binding, result.value);
            if (binding && result.kind === 'failed' && result.failure.withdrawsObservation) {
                applyManagedIdentityProviderObservation(queryKey, binding, null);
            }
            setObservation(current => ({
                queryKey, binding, state: settleManagedIdentityProviderRefresh(current.state, result),
            }));
        });
        return () => controller.abort();
        // The retained answer supplies the first view and never triggers a request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [binding, client, generation, ownerTeamId, queryKey, resolving]);

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
        }, { reconnect: 'refresh' });
    }, [ownerTeamId, refresh, scope.serverId]);

    return React.useMemo(() => ({ state, refresh }), [refresh, state]);
}
