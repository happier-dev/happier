import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  githubPagedInitialState,
  githubPagedReducer,
  type GithubPagedPageV1,
  type GithubPagedStateV1,
} from './panelState.js';

type Row = Readonly<{ id: string }>;

const PERMISSION_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'permission',
  code: 'insufficient_scope',
});

function page(input: Partial<GithubPagedPageV1<Row>> = {}): GithubPagedPageV1<Row> {
  return {
    rows: [],
    omittedRowCount: 0,
    projectionTruncated: false,
    continuation: null,
    incomplete: null,
    ...input,
  };
}

function afterFirstRequest(): GithubPagedStateV1<Row> {
  return githubPagedReducer(githubPagedInitialState<Row>(), { kind: 'requestStarted', token: 1 });
}

describe('GitHub detail paged panel state', () => {
  it('settles a provider-stated empty collection as ready with no rows', () => {
    const settled = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page(),
    });

    // "Nothing here" is a real answer and must never be the unavailable one.
    expect(settled.kind).toBe('ready');
    expect(settled.rows).toEqual([]);
    expect(settled.failure).toBeNull();
    expect(settled.canLoadMore).toBe(false);
  });

  it('makes a first-page failure unavailable and names it', () => {
    const failed = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageFailed',
      token: 1,
      failure: PERMISSION_FAILURE,
    });

    expect(failed.kind).toBe('unavailable');
    expect(failed.failure).toEqual(PERMISSION_FAILURE);
    expect(failed.rows).toEqual([]);
  });

  it('keeps the rows a reader already had when a later page fails', () => {
    const first = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'a' }], continuation: 'token-1' }),
    });
    const second = githubPagedReducer(first, { kind: 'requestStarted', token: 2 });
    const failed = githubPagedReducer(second, {
      kind: 'pageFailed',
      token: 2,
      failure: PERMISSION_FAILURE,
    });

    // A mid-walk failure — including the authentication failure a reconnect
    // produces — never blanks a list the reader is already reading.
    expect(failed.kind).toBe('ready');
    expect(failed.rows).toEqual([{ id: 'a' }]);
    expect(failed.failure).toEqual(PERMISSION_FAILURE);
    expect(failed.canLoadMore).toBe(true);
    expect(failed.pending).toBe(false);
  });

  it('appends a later page and accumulates what it could not read', () => {
    const first = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'a' }], omittedRowCount: 1, continuation: 'token-1' }),
    });
    const second = githubPagedReducer(
      githubPagedReducer(first, { kind: 'requestStarted', token: 2 }),
      {
        kind: 'pageSettled',
        token: 2,
        page: page({ rows: [{ id: 'b' }], omittedRowCount: 2, projectionTruncated: true }),
      },
    );

    expect(second.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(second.omittedRowCount).toBe(3);
    expect(second.projectionTruncated).toBe(true);
    expect(second.canLoadMore).toBe(false);
  });

  it('keeps a known-incomplete walk incomplete once a later page settles', () => {
    const ceiling = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'a' }], incomplete: 'ceiling', continuation: 'token-1' }),
    });
    const later = githubPagedReducer(
      githubPagedReducer(ceiling, { kind: 'requestStarted', token: 2 }),
      { kind: 'pageSettled', token: 2, page: page({ rows: [{ id: 'b' }] }) },
    );

    // A collection that hit GitHub's ceiling is still short after the reader
    // scrolls; only a fresh walk may retract that.
    expect(later.incomplete).toBe('ceiling');
  });

  it('ignores a result belonging to a request it already replaced', () => {
    const first = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'a' }], continuation: 'token-1' }),
    });
    const second = githubPagedReducer(first, { kind: 'requestStarted', token: 2 });

    expect(githubPagedReducer(second, {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'stale' }] }),
    })).toBe(second);
    expect(githubPagedReducer(second, {
      kind: 'pageFailed',
      token: 1,
      failure: PERMISSION_FAILURE,
    })).toBe(second);
  });

  it('discards everything a panel held when the panel is left', () => {
    const loaded = githubPagedReducer(afterFirstRequest(), {
      kind: 'pageSettled',
      token: 1,
      page: page({ rows: [{ id: 'a' }], incomplete: 'ceiling', continuation: 'token-1' }),
    });

    // Retention buys list geometry, never permission to keep provider content
    // nobody is looking at.
    expect(githubPagedReducer(loaded, { kind: 'panelLeft' }))
      .toEqual(githubPagedInitialState<Row>());
  });
});
