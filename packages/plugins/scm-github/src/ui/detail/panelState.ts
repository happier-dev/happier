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

import type { GithubDetailIncompleteReasonV1 } from '../../triage/detail/reads.js';

/**
 * GitHub's binding of the shared Triage paged-panel state machine.
 *
 * The four-outcome rule — provider-stated empty, first read failed, later page
 * failed over visible rows, walk stopped short — is one product contract for every
 * Triage source and lives at `@happier-dev/triage-protocol`, because every copy
 * is one more place for "nothing here" to start looking like "we could not
 * look". What GitHub supplies is the vocabulary that is genuinely its own: its
 * published failure shape, and its two short-walk reasons — GitHub's documented
 * 3,000-file changed-file ceiling, and a next page this source refused to
 * follow. No other forge in this repository has the first of those.
 */

/** A read that settles once for the lifetime that owns it. */
export type GithubReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type GithubPagedStateV1<TRow> = TriagePagedPanelStateV1<
  TRow,
  TriageSourceFailureV1,
  GithubDetailIncompleteReasonV1
>;
export type GithubPagedPageV1<TRow> = TriagePagedPanelPageV1<TRow, GithubDetailIncompleteReasonV1>;
export type GithubPagedEventV1<TRow> = TriagePagedPanelEventV1<
  TRow,
  TriageSourceFailureV1,
  GithubDetailIncompleteReasonV1
>;

export function githubPagedInitialState<TRow>(): GithubPagedStateV1<TRow> {
  return triagePagedPanelInitialState<TRow, TriageSourceFailureV1, GithubDetailIncompleteReasonV1>();
}

export function githubPagedReducer<TRow>(
  state: GithubPagedStateV1<TRow>,
  event: GithubPagedEventV1<TRow>,
): GithubPagedStateV1<TRow> {
  return triagePagedPanelReducer<TRow, TriageSourceFailureV1, GithubDetailIncompleteReasonV1>(
    state,
    event,
  );
}
