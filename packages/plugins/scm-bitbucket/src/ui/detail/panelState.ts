import {
  triagePagedPanelInitialState,
  triagePagedPanelReducer,
} from '@happier-dev/triage-protocol/v1';
import type {
  TriagePagedPanelEventV1,
  TriagePagedPanelPageV1,
  TriagePagedPanelStateV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * Bitbucket's binding of the shared Triage paged-panel state machine.
 *
 * The four-outcome rule — provider-stated empty, first read failed, later page
 * failed over visible rows, walk stopped short — is one product contract for every
 * Triage source and lives at `@happier-dev/triage-protocol`. What Bitbucket
 * supplies is its own vocabulary, and here that is a deliberate absence: this
 * forge has **no** short-walk reason. Its collections end when `next` is absent
 * and continue when it is present, so `TIncomplete` is `never` and no panel can
 * claim a truncation Bitbucket never reported.
 */

/** A read that settles once for the lifetime that owns it. */
export type BitbucketReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type BitbucketPagedStateV1<TRow> = TriagePagedPanelStateV1<TRow, TriageSourceFailureV1>;
export type BitbucketPagedPageV1<TRow> = TriagePagedPanelPageV1<TRow>;
export type BitbucketPagedEventV1<TRow> = TriagePagedPanelEventV1<TRow, TriageSourceFailureV1>;

export function bitbucketPagedInitialState<TRow>(): BitbucketPagedStateV1<TRow> {
  return triagePagedPanelInitialState<TRow, TriageSourceFailureV1>();
}

export function bitbucketPagedReducer<TRow>(
  state: BitbucketPagedStateV1<TRow>,
  event: BitbucketPagedEventV1<TRow>,
): BitbucketPagedStateV1<TRow> {
  return triagePagedPanelReducer<TRow, TriageSourceFailureV1>(state, event);
}
