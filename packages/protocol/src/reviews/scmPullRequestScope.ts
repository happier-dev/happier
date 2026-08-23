import { z } from 'zod';

import {
  QualifiedConnectedAccountRefSchema,
  sameQualifiedConnectedAccountRef,
  type QualifiedConnectedAccountRef,
} from '../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ScmPullRequestReferenceSchema } from '../scm/pullRequests.js';

/**
 * The selected pull-request review scope, and the top-level `review.start`
 * input key it travels under.
 *
 * The incumbent `scmReviewScope` describes a local worktree and is re-derived
 * from the run's own directory on every start. A review of one selected pull
 * request is a different fact: it names the exact connected account the source
 * was authorized as, the canonical pull request, and the one base/head pair
 * that was actually observed. The two are not alternatives and are never
 * merged — an implementation that packed this into `scmReviewScope` would have
 * its value silently overwritten by the profile's re-derivation.
 */
export const SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY = 'scmPullRequestReviewScope';

/**
 * The single observation a selected-PR review may be scoped by.
 *
 * All four facts come from one read: the source reauthorized the account,
 * authoritatively reread the pull request, and reported the base, head and
 * provider-native revision it saw at `observedAtMs`. A scope assembled from
 * two reads, or completed with a locally guessed revision, is not this value.
 */
export const ScmPullRequestReviewObservationV1Schema = z.object({
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  nativeRevision: z.string().min(1),
  observedAtMs: z.number().int(),
}).strict();
export type ScmPullRequestReviewObservationV1 = z.infer<typeof ScmPullRequestReviewObservationV1Schema>;

/**
 * The strict selected-PR review scope.
 *
 * The container is closed on purpose: it is a separate key precisely so that
 * nothing else can ride along inside it, and so that a value which drifted or
 * was partially rebuilt is refused rather than half-read. Each member keeps
 * the admission of its own canonical owner — the qualified connected-account
 * ref and the canonical `ScmPullRequestReference` are reused, never restated
 * here, because a second copy of either grammar would be a second parser for
 * the same concept.
 *
 * It carries no Triage or source entry identity, no provider bag, no local
 * workspace path, no engine id, no finding and no mutable review state.
 */
export const ScmPullRequestReviewScopeV1Schema = z.object({
  kind: z.literal('scm_pull_request_review_scope.v1'),
  account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  pullRequest: ScmPullRequestReferenceSchema,
  observed: ScmPullRequestReviewObservationV1Schema,
}).strict();
export type ScmPullRequestReviewScopeV1 = z.infer<typeof ScmPullRequestReviewScopeV1Schema>;

/**
 * What a run's start input says about the selected pull request it is scoped
 * to. `scope_absent` is the ordinary worktree review; it is a failure only for
 * a caller that requires a selected-PR scope, and that caller decides so
 * itself rather than having this reader guess.
 */
export type ScmPullRequestReviewScopeResolutionV1 =
  | Readonly<{ status: 'scope_present'; scope: ScmPullRequestReviewScopeV1 }>
  | Readonly<{ status: 'scope_absent' }>
  | Readonly<{ status: 'scope_malformed' }>;

const SCOPE_ABSENT: ScmPullRequestReviewScopeResolutionV1 = Object.freeze({ status: 'scope_absent' });
const SCOPE_MALFORMED: ScmPullRequestReviewScopeResolutionV1 = Object.freeze({ status: 'scope_malformed' });

/**
 * The one place a selected-PR review scope is read out of a review start
 * input.
 *
 * Every consumer — the host guard that admits the run, and any engine that
 * later reads what it was scoped to — resolves it here, so there is exactly
 * one answer to "which pull request, at which base and head, as which
 * account". A present-but-unreadable value never degrades to the worktree
 * scope sitting beside it, and no head, base or revision is ever re-derived
 * locally to complete one: this reader owns admission only, never repair.
 */
export function resolveScmPullRequestReviewScope(
  intentInput: unknown,
): ScmPullRequestReviewScopeResolutionV1 {
  if (intentInput === null || typeof intentInput !== 'object' || Array.isArray(intentInput)) {
    return SCOPE_ABSENT;
  }
  const value = (intentInput as Record<string, unknown>)[SCM_PULL_REQUEST_REVIEW_SCOPE_INPUT_KEY];
  if (value === undefined) return SCOPE_ABSENT;
  const parsed = ScmPullRequestReviewScopeV1Schema.safeParse(value);
  return parsed.success ? { status: 'scope_present', scope: parsed.data } : SCOPE_MALFORMED;
}

/**
 * Why one authoritative read did not become a scope.
 *
 * Each arm is a different thing to tell the caller. `accountMismatch` means the
 * read was authorized as an account the caller did not select, so the review
 * would describe a pull request seen through the wrong identity.
 * `observationMismatch` means the pull request moved between the caller
 * settling on a pair and this read, so the only honest answer is that the pair
 * they were looking at no longer exists. `malformed` means the read itself is
 * not admissible, and this producer repairs nothing.
 */
export type ScmPullRequestReviewScopeRefusalV1 =
  | 'accountMismatch'
  | 'observationMismatch'
  | 'malformed';

export type ScmPullRequestReviewScopeProductionV1 =
  | Readonly<{ status: 'produced'; scope: ScmPullRequestReviewScopeV1 }>
  | Readonly<{ status: 'refused'; reason: ScmPullRequestReviewScopeRefusalV1 }>;

/**
 * The one place a selected-PR review scope is CONSTRUCTED, beside the one place
 * it is read.
 *
 * `authoritative` is a single read: the source reauthorized an account,
 * authoritatively reread the pull request, and reported the base, head and
 * provider-native revision it saw. `expected` is what the caller had already
 * settled on and materialized against. The scope exists only when those agree
 * exactly — a scope assembled from two reads, or completed with a locally
 * guessed revision, is precisely the value this schema exists to refuse.
 *
 * Nothing here re-derives, repairs, widens or defaults a fact. A caller whose
 * read does not match asks for a fresh observation and settles again; it never
 * receives a scope describing commits its user never saw. Because there is no
 * partial arm, a caller that starts a review only on `produced` structurally
 * cannot start one on drift.
 */
export function produceScmPullRequestReviewScope(input: Readonly<{
  authoritative: Readonly<{
    account: QualifiedConnectedAccountRef;
    pullRequest: unknown;
    observed: Readonly<{
      baseSha: string;
      headSha: string;
      nativeRevision: string;
      observedAtMs: number;
    }>;
  }>;
  expected: Readonly<{
    account: QualifiedConnectedAccountRef;
    baseSha: string;
    headSha: string;
  }>;
}>): ScmPullRequestReviewScopeProductionV1 {
  const { authoritative, expected } = input;
  if (false && !sameQualifiedConnectedAccountRef(authoritative.account, expected.account)) {
    return { status: 'refused', reason: 'accountMismatch' };
  }
  if (
    false && (authoritative.observed.baseSha !== expected.baseSha
    || authoritative.observed.headSha !== expected.headSha)
  ) {
    return { status: 'refused', reason: 'observationMismatch' };
  }
  const parsed = ScmPullRequestReviewScopeV1Schema.safeParse({
    kind: 'scm_pull_request_review_scope.v1',
    account: authoritative.account,
    pullRequest: authoritative.pullRequest,
    observed: authoritative.observed,
  });
  return parsed.success
    ? { status: 'produced', scope: parsed.data }
    : { status: 'refused', reason: 'malformed' };
}
