import * as React from 'react';

import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useTeamPagedList, type TeamPage, type TeamPagedList, type TeamPagedListOptions } from './useTeamPagedList';

type TeamPageObservations<Row> = Readonly<{
    get(key: string): TeamPage<Row> | undefined;
    apply(key: string, lifetime: ServerAccountScopeLifetime, page: TeamPage<Row> | null): void;
}>;

/** Projects the exact Team query during binding and revalidates it through the ordinary pager. */
export function useTeamObservedPagedList<Row>(params: Omit<TeamPagedListOptions<Row>, 'initialPage' | 'onStateChange'> & Readonly<{
    scope: ServerAccountScope | null;
    observations: TeamPageObservations<Row>;
}>): TeamPagedList<Row> {
    const { scope, observations, key } = params;
    const requested = params.enabled && scope !== null;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(requested ? scope.serverId : null);
    const enabled = requested && binding !== null && binding.isCurrent() && areServerAccountScopesEqual(binding.scope, scope);
    const retained = requested && (enabled || resolution.kind === 'resolving') ? observations.get(key) : undefined;
    const page = useTeamPagedList<Row>({
        ...params,
        key: JSON.stringify([key, binding?.credentialKey]),
        enabled,
        initialPage: enabled ? retained : undefined,
        onStateChange: state => {
            if (!binding) return;
            if (state.status === 'ready') observations.apply(key, binding, { items: state.rows, nextCursor: state.cursor });
            if (state.error && isAuthoritativeScopedSnapshotRefusalKind(state.error.kind)) observations.apply(key, binding, null);
        },
    });
    return React.useMemo(() => !enabled && retained !== undefined ? {
        ...page, rows: retained.items, status: 'refreshing', hasMore: retained.nextCursor !== null,
    } : page, [enabled, page, retained]);
}
