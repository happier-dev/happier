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
    return events.reduce(triagePagedPanelReducer<Row, Failure, Incomplete>, state);
}

describe('triage paged panel state', () => {
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
