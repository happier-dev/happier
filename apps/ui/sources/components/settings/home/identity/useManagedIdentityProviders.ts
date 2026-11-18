import * as React from 'react';
import type { ManagedIdentityProviderOwnerV1 } from '@happier-dev/protocol/identity/providers';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { managedIdentityProviderObservations } from '@/sync/store/home/governance/homeGovernanceSnapshots';

import { useManagedIdentityObservationTarget, useManagedIdentityWake } from './useManagedIdentityObservationTarget';
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

function retainedState(data: ReturnType<typeof managedIdentityProviderObservations.get>): ManagedIdentityProviderState {
    return data === undefined ? INITIAL_MANAGED_IDENTITY_PROVIDER_STATE : beginManagedIdentityProviderRefresh(
        settleManagedIdentityProviderRefresh(INITIAL_MANAGED_IDENTITY_PROVIDER_STATE, { kind: 'succeeded', value: data }),
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
    const { queryKey, binding, resolving } = useManagedIdentityObservationTarget(scope, ownerTeamId);
    const [observation, setObservation] = React.useState(() => ({
        queryKey, binding,
        state: retainedState(binding ? managedIdentityProviderObservations.get(queryKey) : undefined),
    }));
    const [generation, setGeneration] = React.useState(0);
    const hasMountedObservation = !resolving && observation.queryKey === queryKey && observation.binding === binding;
    const retained = !hasMountedObservation && (binding || resolving)
        ? managedIdentityProviderObservations.get(queryKey) : undefined;
    const seed = React.useMemo(() => retainedState(retained), [retained]);
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
        const stored = binding ? managedIdentityProviderObservations.get(queryKey) : undefined;
        setObservation(current => ({
            queryKey, binding,
            state: current.queryKey === queryKey && current.binding === binding
                ? beginManagedIdentityProviderRefresh(current.state) : retainedState(stored),
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
            if (binding && result.kind === 'succeeded') managedIdentityProviderObservations.apply(queryKey, binding, result.value);
            if (binding && result.kind === 'failed' && result.failure.withdrawsObservation) {
                managedIdentityProviderObservations.apply(queryKey, binding, null);
            }
            setObservation(current => ({
                queryKey, binding, state: settleManagedIdentityProviderRefresh(current.state, result),
            }));
        });
        return () => controller.abort();
    }, [binding, client, generation, ownerTeamId, queryKey, resolving]);

    useManagedIdentityWake(scope.serverId, ownerTeamId, refresh);

    return React.useMemo(() => ({ state, refresh }), [refresh, state]);
}
