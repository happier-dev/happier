import * as React from 'react';
import type { HomeAdministrationEventV1 } from '@happier-dev/protocol/home/governance';

import type { HomeActionFailure as HomeDomainFailure } from '@/sync/ops/home/homeActionOutcome';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { listHomeAudit } from '@/sync/ops/home/homeGovernanceOperations';
import { applyHomeActivityObservation, getHomeActivityObservation, homeActivityQueryKey } from '@/sync/store/home/governance/homeGovernanceSnapshots';

type HomePagedListStatus = 'loading' | 'refreshing' | 'loading_more' | 'ready' | 'error';

type HomePagedList = Readonly<{
    rows: readonly HomeAdministrationEventV1[];
    status: HomePagedListStatus;
    /** Retained across a failed page load so the list never blanks. */
    error: HomeDomainFailure | null;
    hasMore: boolean;
    loadMore: () => void;
    reload: () => void;
}>;

type PagedState = Readonly<{
    rows: readonly HomeAdministrationEventV1[];
    status: HomePagedListStatus;
    error: HomeDomainFailure | null;
    cursor: string | null;
    /** False once the Home has answered with no further cursor. */
    hasMore: boolean;
}>;

const INITIAL: PagedState = Object.freeze({
    rows: Object.freeze([]),
    status: 'loading' as const,
    error: null,
    cursor: null,
    hasMore: false,
});

/**
 * A keyset-paged audit list for one exact Home, Account and optional person.
 *
 * The governance snapshot supplies the last answer while a new read starts.
 * Its rows are withdrawn on authoritative refusal.
 */
export function useHomePagedList(input: Readonly<{
    scope: ServerAccountScope; targetId?: string; enabled: boolean; lifetime: ServerAccountScopeLifetime | null | undefined;
}>): HomePagedList {
    const { scope, targetId, enabled, lifetime } = input;
    const { serverId, accountId } = scope;
    const key = homeActivityQueryKey(scope, targetId);
    const current = enabled && (lifetime === undefined || lifetime?.isCurrent() === true);
    const retained = current ? getHomeActivityObservation(key) : undefined;
    const seed = React.useMemo<PagedState>(() => retained === undefined ? INITIAL
        : { ...INITIAL, rows: retained, status: 'refreshing' }, [retained]);
    const [sequence, setSequence] = React.useState(() => ({ key, lifetime, state: seed }));
    const state = !current ? INITIAL : sequence.key === key && sequence.lifetime === lifetime ? sequence.state : seed;
    // Answers for a superseded Home or a superseded reload must not be applied.
    const generation = React.useRef(0);
    // The position the Home last handed back. A continuation has to read it
    // before the request is composed, so it cannot be taken from inside a state
    // updater: React runs those during the next render, by which time the
    // request would already have been sent without a cursor and would have
    // re-read the first page forever.
    const latest = React.useRef(state);
    const seedRef = React.useRef(seed);
    seedRef.current = seed;
    const publish = React.useCallback((next: PagedState) => {
        latest.current = next;
        setSequence({ key, lifetime, state: next });
    }, [key, lifetime]);

    const load = React.useCallback((mode: 'reset' | 'refresh' | 'more') => {
        if (!current) return;
        const previous = latest.current;
        if (mode === 'more'
            && (!previous.hasMore || previous.status === 'loading_more')) {
            return;
        }
        const cursor = mode === 'more' ? previous.cursor : null;
        const currentGeneration = mode === 'more' ? generation.current : (generation.current += 1);
        publish(mode === 'reset' ? seedRef.current
            : mode === 'refresh' ? {
                ...INITIAL, rows: previous.rows, status: previous.status === 'loading' ? 'loading' : 'refreshing',
            }
                : { ...previous, status: 'loading_more', error: null });

        void (async () => {
            const outcome = await listHomeAudit({ scope: { serverId, accountId }, cursor, ...(targetId ? { targetId } : {}) });
            if (currentGeneration !== generation.current || (lifetime && !lifetime.isCurrent())) return;
            if (outcome.kind === 'failed') {
                const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(outcome.failure.kind);
                if (withdrawn && lifetime) applyHomeActivityObservation(key, lifetime, null);
                publish({ ...(withdrawn ? INITIAL : latest.current), status: 'error', error: outcome.failure });
                return;
            }
            const rows = mode === 'more' ? [...previous.rows, ...outcome.value.items] : outcome.value.items;
            if (lifetime) applyHomeActivityObservation(key, lifetime, rows);
            publish({
                rows, status: 'ready', error: null,
                cursor: outcome.value.nextCursor,
                hasMore: outcome.value.nextCursor !== null,
            });
        })();
    }, [current, serverId, accountId, key, targetId, lifetime, publish]);

    React.useEffect(() => {
        load('reset');
        return () => { generation.current += 1; };
    }, [load]);

    const loadMore = React.useCallback(() => { load('more'); }, [load]);
    const reload = React.useCallback(() => { load('refresh'); }, [load]);

    return React.useMemo(() => Object.freeze({
        rows: state.rows,
        status: state.status,
        error: state.error,
        hasMore: state.hasMore,
        loadMore,
        reload,
    }), [state, loadMore, reload]);
}
