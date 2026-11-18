import * as React from 'react';
import type { ManagedGitHubAppOwnerV1, ManagedGitHubAppsListOutputV1 } from '@happier-dev/protocol/identity/githubApps';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { managedGitHubAppsObservations } from '@/sync/store/home/governance/homeGovernanceSnapshots';

import { useManagedIdentityObservationTarget, useManagedIdentityWake } from '../identity/useManagedIdentityObservationTarget';
import { createManagedGitHubAppsClient } from './managedGitHubAppsClient';
import {
    beginManagedGitHubAppsRefresh,
    INITIAL_MANAGED_GITHUB_APPS_STATE,
    settleManagedGitHubAppsRefresh,
    type ManagedGitHubAppsState,
} from './managedGitHubAppsState';

export const HOME_GITHUB_APP_OWNER: ManagedGitHubAppOwnerV1 = Object.freeze({ kind: 'home' });

export function useManagedGitHubAppsClient(scope: ServerAccountScope) {
    return React.useMemo(() => createManagedGitHubAppsClient(scope), [scope.accountId, scope.serverId]);
}

function retainedState(data: ManagedGitHubAppsListOutputV1 | undefined): ManagedGitHubAppsState {
    return data === undefined ? INITIAL_MANAGED_GITHUB_APPS_STATE : beginManagedGitHubAppsRefresh(
        settleManagedGitHubAppsRefresh(INITIAL_MANAGED_GITHUB_APPS_STATE, { kind: 'succeeded', value: data }),
    );
}

/**
 * The registrations one owner may administer on one Home.
 *
 * Owner is a parameter rather than a fixed Home because a Team-owned App is the
 * same record read through the same Action; giving the Team its own hook would
 * be a second reader of one list.
 */
export function useManagedGitHubApps(
    scope: ServerAccountScope,
    owner: ManagedGitHubAppOwnerV1 = HOME_GITHUB_APP_OWNER,
    requiredRegistrationId?: string,
): Readonly<{
    state: ManagedGitHubAppsState;
    refresh: () => void;
}> {
    const client = useManagedGitHubAppsClient(scope);
    const ownerTeamId = owner.kind === 'team' ? owner.teamId : null;
    const { queryKey, binding, resolving } = useManagedIdentityObservationTarget(scope, ownerTeamId);
    const [observation, setObservation] = React.useState(() => ({
        queryKey, binding,
        state: retainedState(binding ? managedGitHubAppsObservations.get(queryKey) : undefined),
    }));
    const [generation, setGeneration] = React.useState(0);
    const hasMountedObservation = !resolving && observation.queryKey === queryKey && observation.binding === binding;
    const retained = !hasMountedObservation && (binding || resolving) ? managedGitHubAppsObservations.get(queryKey) : undefined;
    const seed = React.useMemo(() => retainedState(retained), [retained]);
    const projected = hasMountedObservation ? observation.state : seed;
    const state = React.useMemo<ManagedGitHubAppsState>(() => {
        if (!requiredRegistrationId || projected.kind !== 'ready'
            || projected.registrations.some(registration => registration.id === requiredRegistrationId)) return projected;
        if (projected.refreshing) return INITIAL_MANAGED_GITHUB_APPS_STATE;
        return projected.failure ? { kind: 'unavailable', failure: projected.failure } : projected;
    }, [projected, requiredRegistrationId]);

    React.useEffect(() => {
        if (resolving) return;
        const controller = new AbortController();
        const stored = binding ? managedGitHubAppsObservations.get(queryKey) : undefined;
        setObservation(current => ({
            queryKey, binding,
            state: current.queryKey === queryKey && current.binding === binding
                ? beginManagedGitHubAppsRefresh(current.state) : retainedState(stored),
        }));
        const exactOwner: ManagedGitHubAppOwnerV1 = ownerTeamId === null
            ? HOME_GITHUB_APP_OWNER
            : { kind: 'team', teamId: ownerTeamId };
        void client.execute('identity.githubApps.list', { owner: exactOwner }, { signal: controller.signal })
            .then(result => {
                if (controller.signal.aborted || (binding && !binding.isCurrent())) return;
                if (binding && result.kind === 'succeeded') managedGitHubAppsObservations.apply(queryKey, binding, result.value);
                if (binding && result.kind === 'failed' && result.failure.withdrawsObservation) {
                    managedGitHubAppsObservations.apply(queryKey, binding, null);
                }
                setObservation(current => ({
                    queryKey, binding, state: settleManagedGitHubAppsRefresh(current.state, result),
                }));
            }, error => {
                if (!controller.signal.aborted) throw error;
            });
        return () => controller.abort();
    }, [binding, client, generation, ownerTeamId, queryKey, resolving]);
    const refresh = React.useCallback(() => setGeneration((value) => value + 1), []);
    useManagedIdentityWake(scope.serverId, ownerTeamId, refresh);
    return React.useMemo(() => ({ state, refresh }), [refresh, state]);
}
