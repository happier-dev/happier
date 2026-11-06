import { describe, expect, it } from 'vitest';

import {
    triagePagedPanelInitialState,
    triagePagedPanelReducer,
    type TriagePagedPanelStateV1,
} from './pagedPanel.js';

/**
 * The four outcomes this reducer exists to keep apart, and the transitions
 * between them.
 *
 * The outcomes look alike on screen if a reducer confuses them, and every source
 * detail body in this repository must distinguish all four. That is why the rule
 * lives here rather than in one copy per source: a copy is a place for "nothing
 * here" to start looking like "we could not look".
 *
 * The `requestStarted` cases below exist because the copies this module replaced
 * drifted on exactly that transition while every outcome assertion stayed green:
 * two of them dropped `canLoadMore` for the whole in-flight page, which unmounts
 * the reader's **Load more** control mid-flight and makes its `busy` state
 * unreachable. An assertion on the settled outcomes cannot see that, so the
 * transition is asserted here.
 */

type Row = Readonly<{ id: string }>;
type Failure = Readonly<{ code: string }>;
type Incomplete = 'ceiling' | 'pagination';

function initial(): TriagePagedPanelStateV1<Row, Failure, Incomplete> {
    return triagePagedPanelInitialState<Row, Failure, Incomplete>();
}

function reduce(
    state: TriagePagedPanelStateV1<Row, Failure, Incomplete>,
    ...events: readonly Parameters<typeof triagePagedPanelReducer<Row, Failure, Incomplete>>[1][]
): TriagePagedPanelStateV1<Row, Failure, Incomplete> {
    return events.reduce((current, event) => triagePagedPanelReducer(current, event), state);
}

describe('triage paged panel state', () => {
    it('lets the domain producer retain equal refreshed rows and reconcile appended pages before publication', () => {
        const page = (rows: readonly Row[]) => ({ rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null });
        const oldRows = [{ id: 'a' }, { id: 'b' }];
        const old = reduce(initial(), { kind: 'requestStarted', token: 1 }, { kind: 'pageSettled', token: 1, page: page(oldRows) });
        const policy = {
            reconcileRows(previous: readonly Row[], incoming: readonly Row[], { replacing }: Readonly<{ replacing: boolean }>) {
                const byId = new Map(previous.map(row => [row.id, row]));
                const next = incoming.map(row => byId.get(row.id) ?? row);
                const rows = replacing ? next : [...previous, ...next];
                return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
            },
        };
        const refresh = triagePagedPanelReducer(old, { kind: 'refreshStarted', token: 2 });
        const equal = triagePagedPanelReducer(refresh, { kind: 'pageSettled', token: 2, page: page([{ id: 'a' }, { id: 'b' }]) }, policy);
        expect(equal.rows).toBe(old.rows);
        expect(equal.pending).toBe(false);
        const changed = triagePagedPanelReducer(
            triagePagedPanelReducer(equal, { kind: 'refreshStarted', token: 3 }),
            { kind: 'pageSettled', token: 3, page: page([{ id: 'b' }, { id: 'c' }, { id: 'a' }]) }, policy,
        );
        expect(changed.rows[0]).toBe(old.rows[1]);
        expect(changed.rows[2]).toBe(old.rows[0]);
        const appended = triagePagedPanelReducer(
            triagePagedPanelReducer(changed, { kind: 'requestStarted', token: 4 }),
            { kind: 'pageSettled', token: 4, page: page([{ id: 'd' }]) }, policy,
        );
        expect(appended.rows).toEqual([{ id: 'b' }, { id: 'c' }, { id: 'a' }, { id: 'd' }]);
        expect(appended.rows[0]).toBe(old.rows[1]);
        expect(triagePagedPanelReducer(appended, { kind: 'pageSettled', token: 3, page: page([]) }, policy)).toBe(appended);
    });

    it('keeps Load more mounted and busy while the next page is in flight', () => {
        const inFlight = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
        );
        // The reader pressed Load more. The control they pressed must still be
        // there, showing that it is working — not vanish and reappear.
        expect(inFlight.canLoadMore).toBe(true);
        expect(inFlight.pending).toBe(true);
    });

    it('does not flash a loading state over rows the reader already has', () => {
        const inFlight = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
        );
        expect(inFlight.kind).toBe('ready');
        expect(inFlight.rows).toEqual([{ id: 'a' }]);
    });

    it('stops waiting for an abandoned request without dropping the settled pages', () => {
        const abandoned = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
            { kind: 'walkAbandoned' },
        );
        // The aborted request can never answer, so nothing is pending. What it
        // was reading on top of is untouched, and the position it never reached
        // is offered again rather than left behind a permanently busy control.
        expect(abandoned.pending).toBe(false);
        expect(abandoned.refreshing).toBe(false);
        expect(abandoned.kind).toBe('ready');
        expect(abandoned.rows).toEqual([{ id: 'a' }]);
        expect(abandoned.continuation).toBe('cursor-1');
        expect(abandoned.canLoadMore).toBe(true);
        // It is not a failure: the provider refused nothing.
        expect(abandoned.failure).toBeNull();
    });

    it('leaves a walk with no request in flight exactly as it was', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: null,
                    incomplete: null,
                },
            },
        );
        expect(reduce(settled, { kind: 'walkAbandoned' })).toBe(settled);
    });

    it('ignores a FAILURE belonging to a request the panel already replaced', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
            // A page abandoned when the reader restarted the panel must not put its
            // failure banner over the request that replaced it.
            { kind: 'pageFailed', token: 1, failure: { code: 'stale' } },
        );
        expect(settled.failure).toBeNull();
        expect(settled.pending).toBe(true);
    });

    it('reports a provider-stated empty collection as ready rather than unavailable', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: null,
                    incomplete: null,
                },
            },
        );
        // "The provider says there is nothing" is a real answer, and it is not the
        // same answer as "we could not look".
        expect(settled.kind).toBe('ready');
        expect(settled.rows).toHaveLength(0);
        expect(settled.failure).toBeNull();
    });

    it('reports a first read that failed as unavailable, naming itself', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            { kind: 'pageFailed', token: 1, failure: { code: 'forbidden' } },
        );
        expect(settled.kind).toBe('unavailable');
        expect(settled.failure).toEqual({ code: 'forbidden' });
    });

    it('keeps the rows a reader already had when a LATER page fails', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
            { kind: 'pageFailed', token: 2, failure: { code: 'unauthorized' } },
        );
        // A mid-panel reconnect must not blank the list the reader is looking at.
        expect(settled.kind).toBe('ready');
        expect(settled.rows).toEqual([{ id: 'a' }]);
        expect(settled.failure).toEqual({ code: 'unauthorized' });
        // The frontier survives, so the reader can ask again rather than restart.
        expect(settled.canLoadMore).toBe(true);
    });

    it('retains a provider-stated empty page during refresh and after its failure', () => {
        const empty = reduce(initial(), { kind: 'requestStarted', token: 1 },
            { kind: 'pageSettled', token: 1, page: {
                rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
            } });
        const refreshing = triagePagedPanelReducer(empty, { kind: 'refreshStarted', token: 2 });
        expect(refreshing).toMatchObject({ kind: 'ready', rows: [], pending: true });
        const failed = triagePagedPanelReducer(refreshing, { kind: 'pageFailed', token: 2, failure: { code: 'forbidden' } });
        expect(failed).toMatchObject({ kind: 'ready', rows: [], pending: false, failure: { code: 'forbidden' } });
    });

    it('keeps the last-known-good walk visible when an explicit refresh fails', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'old' }],
                    omittedRowCount: 2,
                    projectionTruncated: true,
                    continuation: 'old-cursor',
                    incomplete: 'pagination',
                },
            },
            { kind: 'refreshStarted', token: 2 },
            { kind: 'pageFailed', token: 2, failure: { code: 'forbidden' } },
        );

        expect(settled.kind).toBe('ready');
        expect(settled.rows).toEqual([{ id: 'old' }]);
        expect(settled.continuation).toBe('old-cursor');
        expect(settled.incomplete).toBe('pagination');
        expect(settled.failure).toEqual({ code: 'forbidden' });
    });

    it('atomically replaces a last-known-good walk when its refreshed first page succeeds', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'old' }],
                    omittedRowCount: 2,
                    projectionTruncated: true,
                    continuation: 'old-cursor',
                    incomplete: 'pagination',
                },
            },
            { kind: 'refreshStarted', token: 2 },
            {
                kind: 'pageSettled',
                token: 2,
                page: {
                    rows: [{ id: 'fresh' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: null,
                    incomplete: null,
                },
            },
        );

        expect(settled.rows).toEqual([{ id: 'fresh' }]);
        expect(settled.omittedRowCount).toBe(0);
        expect(settled.projectionTruncated).toBe(false);
        expect(settled.continuation).toBeNull();
        expect(settled.incomplete).toBeNull();
    });

    it('never retracts a short walk when a later page says nothing about it', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: 'ceiling',
                },
            },
            { kind: 'requestStarted', token: 2 },
            {
                kind: 'pageSettled',
                token: 2,
                page: {
                    rows: [{ id: 'b' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: null,
                    incomplete: null,
                },
            },
        );
        // A collection that hit a provider ceiling is still short after the reader
        // scrolls; only a fresh walk may retract that.
        expect(settled.incomplete).toBe('ceiling');
        expect(settled.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    it('ignores a result belonging to a request the panel already replaced', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 2 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'stale' }],
                    omittedRowCount: 0,
                    projectionTruncated: false,
                    continuation: null,
                    incomplete: null,
                },
            },
        );
        expect(settled.rows).toHaveLength(0);
        expect(settled.pending).toBe(true);
    });

    it('discards everything when the panel is left', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 2,
                    projectionTruncated: true,
                    continuation: 'cursor-1',
                    incomplete: 'pagination',
                },
            },
            { kind: 'panelLeft' },
        );
        expect(settled).toEqual(initial());
    });

    it('accumulates omitted rows and truncation across the pages read', () => {
        const settled = reduce(
            initial(),
            { kind: 'requestStarted', token: 1 },
            {
                kind: 'pageSettled',
                token: 1,
                page: {
                    rows: [{ id: 'a' }],
                    omittedRowCount: 1,
                    projectionTruncated: false,
                    continuation: 'cursor-1',
                    incomplete: null,
                },
            },
            { kind: 'requestStarted', token: 2 },
            {
                kind: 'pageSettled',
                token: 2,
                page: {
                    rows: [{ id: 'b' }],
                    omittedRowCount: 2,
                    projectionTruncated: true,
                    continuation: null,
                    incomplete: null,
                },
            },
        );
        expect(settled.omittedRowCount).toBe(3);
        expect(settled.projectionTruncated).toBe(true);
        expect(settled.canLoadMore).toBe(false);
    });
});
