/**
 * Sentry's binding of the shared Triage detail-panel state machines.
 *
 * The four-outcome paged rule — provider-stated empty, first read failed, later
 * page failed over visible rows, and a walk that stopped short of the whole
 * collection — is one product contract for every Triage source and lives at
 * `@happier-dev/triage-protocol` (`REQ-04`), because every copy is one more
 * place for "nothing here" to start looking like "we could not look". This file
 * held such a copy, and the copy had no fourth outcome at all: a Sentry walk
 * that stopped short rendered as a finished one.
 *
 * What Sentry supplies is the vocabulary that is genuinely its own: its published
 * failure shape, and the three reasons a detail walk stops short. Those three
 * names are deliberately the ones its SCAN plane already emits
 * (`scan/scanIssuesPage.ts`), because a cursor that Sentry would not follow means
 * the same thing on both planes and should not acquire a second spelling.
 */

import type {
  TriagePagedPanelEventV1,
  TriagePagedPanelPageV1,
  TriagePagedPanelStateV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import {
  triagePagedPanelInitialState,
  triagePagedPanelReducer,
} from '@happier-dev/triage-protocol/v1';

/* ----------------------------------------------------------- single reads */

/** A read that settles once for the lifetime that owns it. */
export type SentryReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

/* ------------------------------------------------------------ paged reads */

/**
 * Why a Sentry detail walk stopped before the end of its collection.
 *
 * The first three are a page Sentry advertised in a form this build will not
 * follow. The last is this side's own bound: the walk is open and the provider's
 * cursor is intact, but that cursor is wider than the bounded continuation can
 * carry, so this page is the last one the panel can ask for. It is a fact about
 * one provider position, never about how far the walk has come — the walk's own
 * cycle evidence is a fixed two cursors (`api/sentryCursorCycle.ts`). None of them is a statement that the collection ended —
 * presenting any of them as a finished walk is what makes a truncated list
 * indistinguishable from a complete one.
 */
export type SentryDetailIncompleteReasonV1 =
  | 'paginationHeaderAbsent'
  | 'paginationCursorMalformed'
  | 'paginationCursorNotAdvancing'
  | 'continuationUnavailable';

export type SentryPagedStateV1<TRow> = TriagePagedPanelStateV1<
  TRow,
  TriageSourceFailureV1,
  SentryDetailIncompleteReasonV1
>;
export type SentryPagedPageV1<TRow> = TriagePagedPanelPageV1<
  TRow,
  SentryDetailIncompleteReasonV1
>;
export type SentryPagedEventV1<TRow> = TriagePagedPanelEventV1<
  TRow,
  TriageSourceFailureV1,
  SentryDetailIncompleteReasonV1
>;

export function sentryPagedInitialState<TRow>(): SentryPagedStateV1<TRow> {
  return triagePagedPanelInitialState<
    TRow,
    TriageSourceFailureV1,
    SentryDetailIncompleteReasonV1
  >();
}

export function sentryPagedReducer<TRow>(
  state: SentryPagedStateV1<TRow>,
  event: SentryPagedEventV1<TRow>,
): SentryPagedStateV1<TRow> {
  return triagePagedPanelReducer<
    TRow,
    TriageSourceFailureV1,
    SentryDetailIncompleteReasonV1
  >(state, event);
}
