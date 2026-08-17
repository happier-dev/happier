import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  sentryPagedInitialState,
  sentryPagedReducer,
  type SentryPagedStateV1,
} from './panelState.js';
import {
  SENTRY_DEFAULT_DETAIL_TAB_V1,
  SENTRY_DETAIL_TABS_V1,
  sentryDetailTabDeclaration,
  sentryResolveSelectedTab,
  sentryVisibleDetailTabs,
} from './tabDeclarations.js';

type Row = Readonly<{ id: string }>;

const PERMISSION: TriageSourceFailureV1 = Object.freeze({
  class: 'permission',
  code: 'sentry-insufficient-permission',
});

function page(rows: readonly Row[], continuation: string | null) {
  return { rows, omittedRowCount: 0, projectionTruncated: false, continuation };
}

function settled(state: SentryPagedStateV1<Row>, rows: readonly Row[], continuation: string | null) {
  return sentryPagedReducer(
    sentryPagedReducer(state, { kind: 'requestStarted', token: state.token + 1 }),
    { kind: 'pageSettled', token: state.token + 1, page: page(rows, continuation) },
  );
}

describe('Sentry paged panel state', () => {
  it('reports a provider-stated empty page as ready with no rows', () => {
    const state = settled(sentryPagedInitialState<Row>(), [], null);
    expect(state.kind).toBe('ready');
    expect(state.rows).toEqual([]);
    expect(state.failure).toBeNull();
    expect(state.canLoadMore).toBe(false);
  });

  it('reports a failed first page as unavailable, naming itself', () => {
    const started = sentryPagedReducer(sentryPagedInitialState<Row>(), {
      kind: 'requestStarted',
      token: 1,
    });
    expect(started.kind).toBe('loading');
    const failed = sentryPagedReducer(started, {
      kind: 'pageFailed',
      token: 1,
      failure: PERMISSION,
    });
    expect(failed.kind).toBe('unavailable');
    expect(failed.failure).toEqual(PERMISSION);
    expect(failed.rows).toEqual([]);
  });

  it('keeps the rows a reader already had when a later page fails', () => {
    const first = settled(sentryPagedInitialState<Row>(), [{ id: 'a' }], 'next-1');
    const started = sentryPagedReducer(first, { kind: 'requestStarted', token: first.token + 1 });
    const failed = sentryPagedReducer(started, {
      kind: 'pageFailed',
      token: first.token + 1,
      failure: PERMISSION,
    });

    expect(failed.kind).toBe('ready');
    expect(failed.rows).toEqual([{ id: 'a' }]);
    expect(failed.failure).toEqual(PERMISSION);
    // The position survives, so the reader can try the same page again.
    expect(failed.canLoadMore).toBe(true);
  });

  it('keeps the load-more affordance mounted while a page is in flight', () => {
    const first = settled(sentryPagedInitialState<Row>(), [{ id: 'a' }], 'next-1');
    const started = sentryPagedReducer(first, { kind: 'requestStarted', token: first.token + 1 });
    expect(started.pending).toBe(true);
    expect(started.canLoadMore).toBe(true);
  });

  it('appends a following page and carries its shortening forward', () => {
    const first = settled(sentryPagedInitialState<Row>(), [{ id: 'a' }], 'next-1');
    const second = sentryPagedReducer(
      sentryPagedReducer(first, { kind: 'requestStarted', token: first.token + 1 }),
      {
        kind: 'pageSettled',
        token: first.token + 1,
        page: {
          rows: [{ id: 'b' }],
          omittedRowCount: 2,
          projectionTruncated: true,
          continuation: null,
        },
      },
    );
    expect(second.rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(second.omittedRowCount).toBe(2);
    expect(second.projectionTruncated).toBe(true);
    expect(second.canLoadMore).toBe(false);
  });

  it('discards a result belonging to a request the panel already replaced', () => {
    const first = settled(sentryPagedInitialState<Row>(), [{ id: 'a' }], 'next-1');
    const stale = sentryPagedReducer(first, {
      kind: 'pageSettled',
      token: first.token + 99,
      page: page([{ id: 'ghost' }], null),
    });
    expect(stale).toBe(first);
  });

  it('keeps nothing at all when the panel is left', () => {
    const first = settled(sentryPagedInitialState<Row>(), [{ id: 'a' }], 'next-1');
    expect(sentryPagedReducer(first, { kind: 'panelLeft' }))
      .toEqual(sentryPagedInitialState<Row>());
  });
});

describe('Sentry detail tab declarations', () => {
  it('states a retention and a read plane for every tab', () => {
    for (const tab of SENTRY_DETAIL_TABS_V1) {
      expect(['retain', 'discard']).toContain(tab.retention);
      expect(tab.readPlane.length).toBeGreaterThan(0);
      expect(sentryDetailTabDeclaration(tab.id)).toBe(tab);
    }
    expect(SENTRY_DETAIL_TABS_V1.map((tab) => tab.id))
      .toEqual(['overview', 'occurrences', 'stack-trace', 'release', 'activity']);
  });

  it('gives every tab that reads a provider its own plane', () => {
    const planes = SENTRY_DETAIL_TABS_V1.map((tab) => tab.readPlane);
    // No two panels share a plane, so no panel is a second owner of another's
    // rows — the way a duplicate fetch or a cancellation that kills a sibling's
    // data gets introduced.
    expect(new Set(planes).size).toBe(planes.length);
    // Overview and Release read two different closed projections of the same
    // issue on two different lifetimes; only Release borrows the root's.
    expect(sentryDetailTabDeclaration('release').readPlane).toBe('issueSummary');
    expect(sentryDetailTabDeclaration('overview').readPlane).toBe('issueTags');
    // Stack Trace adds no read of its own: it renders the detail-root
    // controller's one selected-event projection, which is why it can be a peer
    // tab without costing a second event body.
    expect(sentryDetailTabDeclaration('stack-trace').readPlane).toBe('selectedEvent');
  });

  it('hides a conditional tab whose evidence is absent and keeps selection valid', () => {
    const without = sentryVisibleDetailTabs({
      hasReleaseAssociation: false,
      hasTraceEvidence: false,
    });
    expect(without.map((tab) => tab.id)).toEqual(['overview', 'occurrences', 'activity']);
    const with_ = sentryVisibleDetailTabs({
      hasReleaseAssociation: true,
      hasTraceEvidence: true,
    });
    expect(with_.map((tab) => tab.id))
      .toEqual(['overview', 'occurrences', 'stack-trace', 'release', 'activity']);

    // A live selection whose tab disappeared falls back once to the default.
    expect(sentryResolveSelectedTab('release', without)).toBe(SENTRY_DEFAULT_DETAIL_TAB_V1);
    expect(sentryResolveSelectedTab('release', with_)).toBe('release');
    expect(sentryResolveSelectedTab('activity', without)).toBe('activity');
    expect(sentryResolveSelectedTab('stack-trace', without))
      .toBe(SENTRY_DEFAULT_DETAIL_TAB_V1);
  });

  it('gives a performance or feedback issue no empty error-specific tab', () => {
    // An issue whose selected occurrence carries no exception or stacktrace
    // section is not given a Stack Trace tab at all: an empty tab and an
    // inapplicable one look identical to a reader, and only one of them is true.
    const traceless = sentryVisibleDetailTabs({
      hasReleaseAssociation: true,
      hasTraceEvidence: false,
    });
    expect(traceless.map((tab) => tab.id)).not.toContain('stack-trace');
    expect(traceless.map((tab) => tab.id)).toContain('release');
  });

  it('lets retention buy list geometry and never a loaded projection', () => {
    const retained = SENTRY_DETAIL_TABS_V1.filter((tab) => tab.retention === 'retain');
    expect(retained.map((tab) => tab.id)).toEqual(['occurrences', 'stack-trace']);
    for (const tab of retained) expect(tab.retainedState).toContain('discarded');
  });
});
