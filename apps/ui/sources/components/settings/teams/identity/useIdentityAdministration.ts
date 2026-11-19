import * as React from 'react';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { useManagedIdentityObservationTarget, useManagedIdentityWake } from '@/components/settings/home/identity/useManagedIdentityObservationTarget';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { identityConnectionObservations } from '@/sync/store/home/governance/homeGovernanceSnapshots';

import { createIdentityAdministrationClient, executeIdentityAdministrationRead, type TeamIdentityActionOutput } from './identityAdministrationClient';
import {
    beginIdentityAdministrationRefresh,
    INITIAL_IDENTITY_ADMINISTRATION_STATE,
    settleIdentityAdministrationRefresh,
    type IdentityAdministrationLoadResult,
    type IdentityAdministrationState,
} from './identityAdministrationState';

export type IdentityAdministrationBinding = Readonly<{
    state: IdentityAdministrationState;
    refresh: () => void;
}>;

function connectionListResult(value: NonNullable<ReturnType<typeof identityConnectionObservations.get>>): IdentityAdministrationLoadResult {
    return {
        ok: true,
        items: value.items,
        eligibleProviders: value.eligibleProviders,
        admissionModeApplicability: value.admissionModeApplicability ?? null,
        memberSignInUrl: value.memberSignInUrl ?? null,
    };
}

function seedConnectionState(value: ReturnType<typeof identityConnectionObservations.get>): IdentityAdministrationState {
    return value === undefined ? INITIAL_IDENTITY_ADMINISTRATION_STATE : beginIdentityAdministrationRefresh(
        settleIdentityAdministrationRefresh(INITIAL_IDENTITY_ADMINISTRATION_STATE, connectionListResult(value)),
    );
}

export function useIdentityAdministration(
    scope: ServerAccountScope,
    teamId: string | null,
    onApprovalPending?: (registration: ActionApprovalRegistration) => void,
    requiredConnectionId?: string,
): IdentityAdministrationBinding {
    const { queryKey, binding, resolving } = useManagedIdentityObservationTarget(scope, teamId);
    const [boundState, setBoundState] = React.useState(() => ({
        queryKey, binding, value: seedConnectionState(binding ? identityConnectionObservations.get(queryKey) : undefined),
    }));
    const [refreshGeneration, setRefreshGeneration] = React.useState(0);
    const client = React.useMemo(
        () => createIdentityAdministrationClient(scope, { onApprovalPending }),
        [scope.serverId, scope.accountId, onApprovalPending],
    );
    const hasMountedObservation = !resolving && boundState.queryKey === queryKey && boundState.binding === binding;
    const retained = !hasMountedObservation && (binding || resolving) ? identityConnectionObservations.get(queryKey) : undefined;
    const seed = React.useMemo(() => seedConnectionState(retained), [retained]);
    const projected = hasMountedObservation ? boundState.value : seed;
    const state = React.useMemo<IdentityAdministrationState>(() => {
        if (!requiredConnectionId || projected.kind !== 'ready'
            || projected.items.some(connection => connection.id === requiredConnectionId)) return projected;
        if (projected.refreshing) return INITIAL_IDENTITY_ADMINISTRATION_STATE;
        return projected.failure ? { kind: 'unavailable', failure: projected.failure } : projected;
    }, [projected, requiredConnectionId]);

    React.useEffect(() => {
        if (resolving) return;
        const controller = new AbortController();
        const stored = binding ? identityConnectionObservations.get(queryKey) : undefined;
        setBoundState((current) => ({
            queryKey, binding,
            value: current.queryKey === queryKey && current.binding === binding
                ? beginIdentityAdministrationRefresh(current.value)
                : seedConnectionState(stored),
        }));
        void executeIdentityAdministrationRead<TeamIdentityActionOutput<'teams.identity.connections.list'>>((options) => client.execute(
            'teams.identity.connections.list',
            { v: 1, teamId },
            options,
        ), controller.signal).then((result) => {
            if (controller.signal.aborted || (binding && !binding.isCurrent())) return;
            const withdrawn = !result.ok && result.failure.domainFailure !== undefined
                && isAuthoritativeScopedSnapshotRefusalKind(result.failure.domainFailure.kind);
            if (binding && result.ok) identityConnectionObservations.apply(queryKey, binding, result.value);
            if (binding && withdrawn) identityConnectionObservations.apply(queryKey, binding, null);
            setBoundState((current) => current.queryKey !== queryKey || current.binding !== binding
                ? current
                : {
                    queryKey, binding,
                    value: settleIdentityAdministrationRefresh(
                        withdrawn ? INITIAL_IDENTITY_ADMINISTRATION_STATE : current.value,
                        result.ok ? connectionListResult(result.value)
                            : { ok: false, failure: result.failure },
                    ),
                });
        });
        return () => controller.abort();
    }, [binding, client, queryKey, resolving, teamId, refreshGeneration]);

    const refresh = React.useCallback(() => {
        // Publish the transition synchronously so return-to-app consumers can
        // wait for the new authoritative projection instead of acting on the
        // last screen snapshot while the request effect is being scheduled.
        setBoundState((current) => current.queryKey !== queryKey || current.binding !== binding
            ? current
            : { queryKey, binding, value: beginIdentityAdministrationRefresh(current.value) });
        setRefreshGeneration((current) => current + 1);
    }, [binding, queryKey]);

    useManagedIdentityWake(scope.serverId, teamId, refresh);

    return React.useMemo(() => ({ state, refresh }), [state, refresh]);
}
