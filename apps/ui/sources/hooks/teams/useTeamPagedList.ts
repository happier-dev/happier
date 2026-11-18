import * as React from 'react';

import type { HomeDomainFailure } from '@/sync/ops/teams/teamActionClient';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { loadTeamPageRange, type TeamPageOutcome } from '@/sync/engine/teams/loadTeamPageRange';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * The paged lifetime for Team reads with one mounted owner.
 *
 * Group members, invitations, credential activity and directory adjuncts share
 * the same lifetime: accumulate pages in the Home's own order, retain them
 * across transport failure, withdraw them after authoritative access loss,
 * restart when the sequence identity changes, consume the existing AccountChange
 * wake, and refuse a second continuation while one is in flight.
 * Separate copies would eventually disagree about the one behaviour that
 * matters — whether a partial roster survives a failure — so it lives here once.
 *
 * Members and Groups collections use the shared Teams snapshot owner instead.
 * This pager holds no cross-surface state. The caller
 * supplies the exact Home/entity identity for the canonical wake, while the
 * Home's HTTP page remains the sole data and authority source.
 */

export type { TeamPage, TeamPageOutcome } from '@/sync/engine/teams/loadTeamPageRange';

export type TeamPagedListStatus = 'loading' | 'loading_more' | 'ready' | 'error';

export type TeamPagedList<TRow> = Readonly<{
    rows: readonly TRow[];
    status: TeamPagedListStatus;
    /** Retained across transport failure; authoritative access loss withdraws rows. */
    error: HomeDomainFailure | null;
    hasMore: boolean;
    loadMore: () => Promise<void>;
    reload: () => Promise<void>;
}>;

export type TeamPagedListState<TRow> = Readonly<{
    rows: readonly TRow[];
    status: TeamPagedListStatus;
    error: HomeDomainFailure | null;
    cursor: string | null;
    hasMore: boolean;
}>;

function initialState<TRow>(rows: readonly TRow[] = []): TeamPagedListState<TRow> {
    return Object.freeze({
        rows,
        status: 'loading' as const,
        error: null,
        cursor: null,
        hasMore: true,
    });
}

export function useTeamPagedList<TRow>(params: Readonly<{
    /**
     * The identity of the sequence. A cursor names a position inside one
     * sequence, so any change here — a different Team, filter or Group — starts
     * a new one rather than continuing a position that no longer exists.
     */
    key: string;
    enabled: boolean;
    loadPage: (cursor: string | null, signal: AbortSignal) => Promise<TeamPageOutcome<TRow>>;
    /** Domain identity for admitted rows whose consumers require reference reuse. */
    getRowKey?: (row: TRow) => string;
    /** Last-known rows owned by a retained snapshot, shown while this observer refreshes. */
    initialRows?: readonly TRow[];
    /** Persists each settled projection through the caller's canonical owner. */
    onStateChange?: (state: TeamPagedListState<TRow>) => void;
    /** Optional AccountChange invalidation for the exact Home owning this page. */
    accountChange?: Readonly<{ serverId: string }> & (
        | Readonly<{ entityId: string; affects?: never }>
        | Readonly<{ entityId?: never; affects: (event: HomeAccountChangeEvent) => boolean }>
    );
}>): TeamPagedList<TRow> {
    const { key, enabled, getRowKey } = params;
    const [state, setState] = React.useState<TeamPagedListState<TRow>>(() => initialState(params.initialRows ?? []));

    // Answers for a superseded sequence must never be applied over its successor.
    const generation = React.useRef(0);
    // The caller may rebuild its closure on every render; only the latest is used.
    const loadPageRef = React.useRef(params.loadPage);
    loadPageRef.current = params.loadPage;
    const initialRowsRef = React.useRef(params.initialRows ?? []);
    initialRowsRef.current = params.initialRows ?? [];
    const onStateChangeRef = React.useRef(params.onStateChange);
    onStateChangeRef.current = params.onStateChange;
    const inFlight = React.useRef(false);
    const request = React.useRef<AbortController | null>(null);
    /**
     * The paging position has to be readable synchronously: a continuation must
     * decide which cursor it continues before it awaits, and React state is not
     * settled at that moment. This ref and `state` are written together and are
     * always the same value; only the ref is read by the loader.
     */
    const stateRef = React.useRef<TeamPagedListState<TRow>>(state);

    const publish = React.useCallback((next: TeamPagedListState<TRow>) => {
        stateRef.current = next;
        setState(next);
        onStateChangeRef.current?.(next);
    }, []);

    const load = React.useCallback(async (mode: 'reset' | 'refresh' | 'more'): Promise<void> => {
        if (!enabled) return;
        if (inFlight.current && mode === 'more') return;

        const previous = stateRef.current;
        if (mode === 'more' && (!previous.hasMore || previous.status === 'loading')) return;

        const cursor = mode === 'more' ? previous.cursor : null;
        publish(mode === 'reset'
            ? { ...initialState(initialRowsRef.current), status: 'loading' }
            : mode === 'refresh'
                ? { ...previous, status: 'loading', error: null }
                : { ...previous, status: 'loading_more', error: null });

        const currentGeneration = mode === 'more' ? generation.current : (generation.current += 1);
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        inFlight.current = true;
        try {
            const isCancelled = () => controller.signal.aborted || currentGeneration !== generation.current;
            const outcome = mode === 'refresh'
                ? await loadTeamPageRange({
                    loadedRowCount: previous.rows.length,
                    loadPage: (freshCursor) => loadPageRef.current(freshCursor, controller.signal),
                    isCancelled,
                })
                : await loadPageRef.current(cursor, controller.signal);
            if (outcome === null || isCancelled()) return;
            const base = stateRef.current;
            if (outcome.kind === 'failed') {
                const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(outcome.failure.kind);
                // A rendered retry/load-more control must observe that the
                // request producing this committed state has already released
                // its slot. React can commit `publish` before this async frame
                // reaches `finally`.
                inFlight.current = false;
                publish({
                    ...base,
                    rows: withdrawn ? initialState<TRow>().rows : base.rows,
                    cursor: withdrawn ? null : base.cursor,
                    hasMore: withdrawn ? false : base.hasMore,
                    status: 'error',
                    error: outcome.failure,
                });
                return;
            }
            inFlight.current = false;
            const incoming = mode === 'more' ? [...base.rows, ...outcome.value.items] : outcome.value.items;
            publish({
                rows: getRowKey ? retainKeyedRows(base.rows, incoming, getRowKey) : incoming,
                status: 'ready',
                error: null,
                cursor: outcome.value.nextCursor,
                hasMore: outcome.value.nextCursor !== null,
            });
        } catch (error) {
            if (!controller.signal.aborted) throw error;
        } finally {
            if (currentGeneration === generation.current) inFlight.current = false;
        }
    }, [enabled, publish, getRowKey]);

    React.useEffect(() => {
        if (!enabled) {
            request.current?.abort();
            generation.current += 1;
            inFlight.current = false;
            publish(initialState<TRow>());
            return;
        }
        void load('reset');
        return () => {
            generation.current += 1;
            request.current?.abort();
            inFlight.current = false;
        };
        // `key` is the sequence identity; the domain's row identity callback is stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, key, load]);

    const accountChangeServerId = params.accountChange?.serverId ?? '';
    const accountChangeEntityId = params.accountChange?.entityId ?? '';
    const accountChangeHasPredicate = params.accountChange?.affects !== undefined;
    const accountChangeAffects = React.useRef(params.accountChange?.affects);
    accountChangeAffects.current = params.accountChange?.affects;
    React.useEffect(() => {
        if (!enabled || accountChangeServerId === '' || (!accountChangeHasPredicate && accountChangeEntityId === '')) return;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId !== accountChangeServerId) return;
            const affects = accountChangeAffects.current;
            if (affects) {
                if (!affects(event)) return;
            } else if (event.entityIds !== undefined && !event.entityIds.includes(accountChangeEntityId)) return;
            void load('refresh');
        }, { serverIds: [accountChangeServerId], reconnect: { readNotCurrent: () => stateRef.current.status !== 'ready' } });
    }, [enabled, accountChangeServerId, accountChangeEntityId, accountChangeHasPredicate, load]);

    const loadMore = React.useCallback(() => load('more'), [load]);
    const reload = React.useCallback(() => load('refresh'), [load]);

    return React.useMemo(() => Object.freeze({
        rows: state.rows,
        status: state.status,
        error: state.error,
        hasMore: state.hasMore,
        loadMore,
        reload,
    }), [state, loadMore, reload]);
}
