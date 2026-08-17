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
 * Bitbucket's binding of the shared forge paged-panel state machine.
 *
 * The four-outcome rule — provider-stated empty, first read failed, later page
 * failed over visible rows, walk stopped short — is one product contract across
 * all four forges and lives at `@happier-dev/scm-forge-adapter`. What Bitbucket
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

export type BitbucketPagedStateV1<TRow> = ForgePagedStateV1<TRow, TriageSourceFailureV1>;
export type BitbucketPagedPageV1<TRow> = ForgePagedPageV1<TRow>;
export type BitbucketPagedEventV1<TRow> = ForgePagedEventV1<TRow, TriageSourceFailureV1>;

export function bitbucketPagedInitialState<TRow>(): BitbucketPagedStateV1<TRow> {
  return forgePagedInitialState<TRow, TriageSourceFailureV1>();
}

export function bitbucketPagedReducer<TRow>(
  state: BitbucketPagedStateV1<TRow>,
  event: BitbucketPagedEventV1<TRow>,
): BitbucketPagedStateV1<TRow> {
  return forgePagedReducer<TRow, TriageSourceFailureV1>(state, event);
}
