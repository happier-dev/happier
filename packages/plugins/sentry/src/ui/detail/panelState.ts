/**
 * The two state machines behind every Sentry detail panel.
 *
 * They are separated from the hooks that drive them because this is where the
 * risk is. Three outcomes look alike on screen if a reducer confuses them, and
 * they must not:
 *
 * 1. a collection the provider stated as **empty** — `ready` with no rows;
 * 2. a **first** read that failed — `unavailable`, naming itself;
 * 3. a **later** page that failed after rows were already visible — still
 *    `ready`, keeping what the reader already had, with the failure shown beside
 *    it.
 *
 * An empty panel and an unavailable panel are different answers, and neither is
 * the absence of the feature.
 *
 * One machine is shared by the three paged and unpaged planes rather than
 * copied per panel, because the rule above is a single product contract: three
 * copies would be three places for "nothing here" to start looking like "we
 * could not look".
 */

import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

/* ----------------------------------------------------------- single reads */

/** A read that settles once for the lifetime that owns it. */
export type SentryReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

/* ------------------------------------------------------------ paged reads */

export type SentryPagedStateV1<TRow> = Readonly<{
  kind: 'idle' | 'loading' | 'ready' | 'unavailable';
  rows: readonly TRow[];
  /** Provider rows the pages read returned but could not be understood. */
  omittedRowCount: number;
  /** `true` when this source shortened any content on the pages read. */
  projectionTruncated: boolean;
  /** A request is in flight for this panel interval. */
  pending: boolean;
  /** The source-minted position of the next page, or `null` when the walk ended. */
  continuation: string | null;
  canLoadMore: boolean;
  /**
   * The last failure, kept visible beside whatever rows survived it. A
   * permission or authentication failure is a fact a panel states, never a
   * reason to look empty.
   */
  failure: TriageSourceFailureV1 | null;
  /** Identifies the request whose result this state will accept. */
  token: number;
}>;

export type SentryPagedPageV1<TRow> = Readonly<{
  rows: readonly TRow[];
  omittedRowCount: number;
  projectionTruncated: boolean;
  continuation: string | null;
}>;

export type SentryPagedEventV1<TRow> =
  | Readonly<{ kind: 'requestStarted'; token: number }>
  | Readonly<{ kind: 'pageSettled'; token: number; page: SentryPagedPageV1<TRow> }>
  | Readonly<{ kind: 'pageFailed'; token: number; failure: TriageSourceFailureV1 }>
  /** The panel was left. Every plane here discards, so nothing survives it. */
  | Readonly<{ kind: 'panelLeft' }>;

const INITIAL = Object.freeze({
  kind: 'idle' as const,
  rows: Object.freeze([]),
  omittedRowCount: 0,
  projectionTruncated: false,
  pending: false,
  continuation: null,
  canLoadMore: false,
  failure: null,
  token: 0,
});

export function sentryPagedInitialState<TRow>(): SentryPagedStateV1<TRow> {
  return INITIAL as SentryPagedStateV1<TRow>;
}

export function sentryPagedReducer<TRow>(
  state: SentryPagedStateV1<TRow>,
  event: SentryPagedEventV1<TRow>,
): SentryPagedStateV1<TRow> {
  switch (event.kind) {
    case 'panelLeft':
      return sentryPagedInitialState<TRow>();
    case 'requestStarted':
      return {
        ...state,
        kind: state.rows.length === 0 ? 'loading' : state.kind,
        pending: true,
        // While a page is in flight the reader cannot ask for another one, but
        // the affordance stays mounted in its busy state rather than vanishing.
        canLoadMore: state.canLoadMore,
        failure: null,
        token: event.token,
      };
    case 'pageSettled': {
      if (event.token !== state.token) {
        // The result belongs to a request this panel already replaced.
        return state;
      }
      return {
        kind: 'ready',
        rows: [...state.rows, ...event.page.rows],
        omittedRowCount: state.omittedRowCount + event.page.omittedRowCount,
        projectionTruncated: state.projectionTruncated || event.page.projectionTruncated,
        pending: false,
        continuation: event.page.continuation,
        canLoadMore: event.page.continuation !== null,
        failure: null,
        token: state.token,
      };
    }
    case 'pageFailed': {
      if (event.token !== state.token) return state;
      // Rows a reader already had survive a later failure — including the
      // authentication failure a mid-panel reconnect produces. Only a first
      // page that never arrived leaves the panel with nothing to show, and it
      // says so rather than rendering an empty list.
      return {
        ...state,
        kind: state.rows.length === 0 ? 'unavailable' : 'ready',
        pending: false,
        canLoadMore: state.continuation !== null,
        failure: event.failure,
      };
    }
    default:
      return state;
  }
}
