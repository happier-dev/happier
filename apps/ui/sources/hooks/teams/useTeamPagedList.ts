import * as React from 'react';

import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * The one paged-list lifetime for Team rosters.
 *
 * Members, Groups, Group members and invitations are four different reads with
 * the same lifetime: accumulate pages in the Home's own order, retain them
 * across transport failure, withdraw them after authoritative access loss,
 * restart when the sequence identity changes, consume the existing AccountChange
 * wake, and refuse a second continuation while one is in flight.
 * Four copies of that would eventually disagree about the one behaviour that
 * matters — whether a partial roster survives a failure — so it lives here once.
 *
 * This is a paged read, not a cache: it holds no cross-surface state. The caller
 * supplies the exact Home/entity identity for the canonical wake, while the
 * Home's HTTP page remains the sole data and authority source.
 */

export type TeamPage<TRow> = Readonly<{
    items: readonly TRow[];
    nextCursor: string | null;
}>;

export type TeamPageOutcome<TRow> =
    | Readonly<{ kind: 'succeeded'; value: TeamPage<TRow> }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

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

type ListState<TRow> = Readonly<{
    rows: readonly TRow[];
    status: TeamPagedListStatus;
    error: HomeDomainFailure | null;
    cursor: string | null;
    hasMore: boolean;
}>;

function initialState<TRow>(): ListState<TRow> {
    return Object.freeze({
        rows: Object.freeze([]) as readonly TRow[],
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
    /** Optional AccountChange invalidation for the exact Home owning this page. */
    accountChange?: Readonly<{ serverId: string; entityId: string }>;
}>): TeamPagedList<TRow> {
    const { key, enabled } = params;
    const [state, setState] = React.useState<ListState<TRow>>(initialState<TRow>);

    // Answers for a superseded sequence must never be applied over its successor.
    const generation = React.useRef(0);
    // The caller may rebuild its closure on every render; only the latest is used.
    const loadPageRef = React.useRef(params.loadPage);
    loadPageRef.current = params.loadPage;
    const inFlight = React.useRef(false);
    const request = React.useRef<AbortController | null>(null);
    /**
     * The paging position has to be readable synchronously: a continuation must
     * decide which cursor it continues before it awaits, and React state is not
     * settled at that moment. This ref and `state` are written together and are
     * always the same value; only the ref is read by the loader.
     */
    const stateRef = React.useRef<ListState<TRow>>(state);

    const publish = React.useCallback((next: ListState<TRow>) => {
        stateRef.current = next;
        setState(next);
    }, []);

    const load = React.useCallback(async (mode: 'reset' | 'refresh' | 'more'): Promise<void> => {
        if (!enabled) return;
        if (inFlight.current && mode === 'more') return;

        const previous = stateRef.current;
        if (mode === 'more' && (!previous.hasMore || previous.status === 'loading')) return;

        const cursor = mode === 'more' ? previous.cursor : null;
        publish(mode === 'reset'
            ? { ...initialState<TRow>(), status: 'loading' }
            : mode === 'refresh'
                ? { ...previous, status: 'loading', error: null }
                : { ...previous, status: 'loading_more', error: null });

        const currentGeneration = mode === 'more' ? generation.current : (generation.current += 1);
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        inFlight.current = true;
        try {
            let outcome = await loadPageRef.current(cursor, controller.signal);
            const refreshedRows: TRow[] = [];
            // Re-read the visible range using fresh continuation positions. The
            // Home remains authoritative: removed rows disappear, while later
            // loaded rows do not collapse to the first page on a background wake.
            if (mode === 'refresh') {
                while (outcome.kind === 'succeeded') {
                    if (controller.signal.aborted || currentGeneration !== generation.current) return;
                    refreshedRows.push(...outcome.value.items);
                    if (refreshedRows.length >= previous.rows.length || outcome.value.nextCursor === null) break;
                    outcome = await loadPageRef.current(outcome.value.nextCursor, controller.signal);
                }
            }
            if (controller.signal.aborted || currentGeneration !== generation.current) return;
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
            publish({
                rows: mode === 'more' ? [...base.rows, ...outcome.value.items]
                    : mode === 'refresh' ? refreshedRows : outcome.value.items,
                status: 'ready',
                error: null,
                cursor: outcome.value.nextCursor,
                hasMore: outcome.value.nextCursor !== null,
            });
        } finally {
            if (currentGeneration === generation.current) inFlight.current = false;
        }
    }, [enabled, publish]);

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
        // `key` is the sequence identity; `load` only closes over `enabled`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, key, load]);

    const accountChangeServerId = params.accountChange?.serverId ?? '';
    const accountChangeEntityId = params.accountChange?.entityId ?? '';
    React.useEffect(() => {
        if (!enabled || accountChangeServerId === '' || accountChangeEntityId === '') return;
        return subscribeHomeAccountChange((event) => {
            if (event.serverId !== accountChangeServerId) return;
            if (event.entityIds !== undefined && !event.entityIds.includes(accountChangeEntityId)) return;
            void load('refresh');
        });
    }, [enabled, accountChangeServerId, accountChangeEntityId, load]);

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
