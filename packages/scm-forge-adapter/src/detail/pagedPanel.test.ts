import { describe, expect, it } from 'vitest';

import {
  forgePagedInitialState,
  forgePagedReducer,
  type ForgePagedStateV1,
} from './pagedPanel.js';

/**
 * The four outcomes this reducer exists to keep apart.
 *
 * They look alike on screen if a reducer confuses them, and every forge detail
 * body in this repository must distinguish all four. That is why the rule lives
 * here rather than in four copies: four copies are four places for "nothing
 * here" to start looking like "we could not look".
 */

type Row = Readonly<{ id: string }>;
type Failure = Readonly<{ code: string }>;
type Incomplete = 'ceiling' | 'pagination';

function initial(): ForgePagedStateV1<Row, Failure, Incomplete> {
  return forgePagedInitialState<Row, Failure, Incomplete>();
}

function reduce(
  state: ForgePagedStateV1<Row, Failure, Incomplete>,
  ...events: readonly Parameters<typeof forgePagedReducer<Row, Failure, Incomplete>>[1][]
): ForgePagedStateV1<Row, Failure, Incomplete> {
  return events.reduce(forgePagedReducer<Row, Failure, Incomplete>, state);
}

describe('forge paged panel state', () => {
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
