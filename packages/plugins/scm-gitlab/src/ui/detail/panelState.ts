import type {
  ForgePagedEventV1,
  ForgePagedPageV1,
  ForgePagedStateV1,
} from '@happier-dev/scm-forge-adapter';
import {
  forgePagedInitialState,
  forgePagedReducer,
} from '@happier-dev/scm-forge-adapter';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

/**
 * GitLab's binding of the shared forge paged-panel state machine.
 *
 * The four-outcome rule — provider-stated empty, first read failed, later page
 * failed over visible rows, walk stopped short — is one product contract across
 * all four forges and lives at `@happier-dev/scm-forge-adapter`. What GitLab
 * supplies is the vocabulary that is genuinely its own: its published failure
 * shape, and the single reason one of its walks can stop short. GitLab documents
 * no collection ceiling on these resources, so `pagination` — a next page this
 * build refused to follow — is the only member, and a ceiling arm here would be
 * a provider cap this product invented.
 */

/** A read that settles once for the lifetime that owns it. */
export type GitlabReadStateV1<T> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: T }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

/** The one reason a GitLab detail walk stops short of its whole collection. */
export type GitlabDetailIncompleteReasonV1 = 'pagination';

export type GitlabPagedStateV1<TRow> = ForgePagedStateV1<
  TRow,
  TriageSourceFailureV1,
  GitlabDetailIncompleteReasonV1
>;
export type GitlabPagedPageV1<TRow> = ForgePagedPageV1<TRow, GitlabDetailIncompleteReasonV1>;
export type GitlabPagedEventV1<TRow> = ForgePagedEventV1<
  TRow,
  TriageSourceFailureV1,
  GitlabDetailIncompleteReasonV1
>;

export function gitlabPagedInitialState<TRow>(): GitlabPagedStateV1<TRow> {
  return forgePagedInitialState<TRow, TriageSourceFailureV1, GitlabDetailIncompleteReasonV1>();
}

export function gitlabPagedReducer<TRow>(
  state: GitlabPagedStateV1<TRow>,
  event: GitlabPagedEventV1<TRow>,
): GitlabPagedStateV1<TRow> {
  return forgePagedReducer<TRow, TriageSourceFailureV1, GitlabDetailIncompleteReasonV1>(
    state,
    event,
  );
}
