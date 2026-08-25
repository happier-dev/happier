import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
  TriageSourceObservationV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { BITBUCKET_DETAIL_BOUNDS_V1 } from '../detail/projection.js';
import { BitbucketCommentResolutionV1Schema } from './detailContracts.js';

/**
 * The four enabled Bitbucket Cloud pull-request mutation contracts.
 *
 * `sources/SCM.md` §3.8 rules out a generic `mutate({ operation, payload })` for this vertical, so
 * each write is its own exact Action with its own closed input: there is no envelope a caller can
 * widen, and no operation discriminant that would let one grant serve two effects.
 *
 * Every arm carries the **re-observed entity** rather than a boolean. A boolean forces the caller
 * to issue a second read to learn what happened, and that second read is a second race.
 */

const HeadCommitSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  minLength: 1,
});

const MergeMessageSchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.commentBodyUtf8Bytes,
  minLength: 1,
});

const BooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

/**
 * Bitbucket's own three merge strategies, and no fourth.
 *
 * It is required rather than defaulted for the same reason `closeSourceBranch` is: which strategy
 * ran is written into the repository's history permanently, and a default would make that decision
 * on the user's behalf out of a value they never saw.
 */
export const BitbucketMergeStrategyV1Schema = defineProtocolUnion([
  defineProtocolLiteral('merge_commit'),
  defineProtocolLiteral('squash'),
  defineProtocolLiteral('fast_forward'),
]);
export type BitbucketMergeStrategyV1 = ReturnType<typeof BitbucketMergeStrategyV1Schema.parse>;

/**
 * `bitbucket/pull-request/merge`.
 *
 * The head pin is required and is **the exact commit the read the user acted on observed**
 * (`sources/SCM.md` §2.6). Bitbucket's merge endpoint publishes no expected-head precondition, so
 * the rule there applies unchanged: read, compare, and refuse before writing. The pin is never
 * filled from a fresh read at write time — that is the same race with extra steps.
 */
export const BitbucketMergeInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  /** The source-branch commit hash the user's own read reported. */
  observedHeadCommit: HeadCommitSchema,
  /**
   * `close_source_branch` — required, never defaulted (`sources/SCM.md` §2.8, §5.3b).
   *
   * Deleting a collaborator's branch and keeping it are both real outcomes with no safe default,
   * and Bitbucket applies whichever value the request carries.
   */
  closeSourceBranch: BooleanSchema,
  mergeStrategy: BitbucketMergeStrategyV1Schema,
  /** The merge commit message. Absent leaves Bitbucket's own generated message in place. */
  message: MergeMessageSchema.optional(),
}, { policy: 'closed' });
export type BitbucketMergeInputV1 = ReturnType<typeof BitbucketMergeInputV1Schema.parse>;

/**
 * `bitbucket/pull-request/decline`.
 *
 * No head pin: declining is head-independent, and carrying one would add a failure mode that
 * protects no invariant (`sources/SCM.md` §2.6). Bitbucket documents no request body for this
 * route, so none is sent — a decline reason is not invented here.
 */
export const BitbucketDeclineInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
}, { policy: 'closed' });
export type BitbucketDeclineInputV1 = ReturnType<typeof BitbucketDeclineInputV1Schema.parse>;

/**
 * Why a write was never sent.
 *
 * Both reasons are established by the fresh pre-write read, and both travel with the entity that
 * read observed — so the host can re-render the current truth instead of forcing a blind retry.
 */
const BitbucketMutationRefusalReasonV1Schema = defineProtocolUnion([
  /** The pinned source commit is no longer the pull request's head. */
  defineProtocolLiteral('head-advanced'),
  /** The pull request is no longer open, so the requested transition no longer applies. */
  defineProtocolLiteral('entry-not-open'),
]);

/**
 * Why Bitbucket terminally refused a write it did receive.
 *
 * `409` and `555` are documented merge responses and are distinct terminal outcomes — never folded
 * into one generic error (`sources/SCM.md` §5.3b).
 */
const BitbucketMutationRejectionReasonV1Schema = defineProtocolUnion([
  /** `409` — Bitbucket would not merge this pull request in its current state. */
  defineProtocolLiteral('provider-rejected'),
  /** `555` — Bitbucket's non-standard "too large and timed out". */
  defineProtocolLiteral('provider-oversized-response'),
]);

/**
 * The one result vocabulary both Bitbucket mutations settle into.
 *
 * `applied` and `pending` are deliberately separate arms. Bitbucket's merge may complete
 * asynchronously and not at our option, so a `202` that has not yet been observed as `MERGED`
 * settles as `pending`: the UI must never say *merged* about a queued merge.
 */
export const BitbucketMutationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    /** The confirming read that proved the effect. */
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('pending'),
    /** The last observation the bounded poll reached; the effect is accepted, not proven. */
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('refused'),
    reason: BitbucketMutationRefusalReasonV1Schema,
    /** The fresh read that caused the refusal. Nothing was written. */
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('rejected'),
    reason: BitbucketMutationRejectionReasonV1Schema,
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unchanged'),
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    observation: TriageSourceObservationV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
]);
export type BitbucketMutationResultV1 = ReturnType<typeof BitbucketMutationResultV1Schema.parse>;

/* --------------------------------------------------------- comment resolution */

/**
 * `bitbucket/pull-request/comment-resolution` and `bitbucket/pull-request/comment-unresolution`.
 *
 * Bitbucket spells both as one route: `POST …/comments/{id}/resolve` resolves a comment thread and
 * `DELETE` on that same path reopens it. They are two Actions rather than one with a direction
 * flag, for the reason `sources/SCM.md` §3.8 gives for every write here — an operation
 * discriminant is exactly what lets one grant serve two effects — but their INPUT is genuinely the
 * same value, so it is declared once instead of twice. What differs is the verb, and the verb is
 * the handler's, not the caller's.
 *
 * There is no head pin. Resolving a review thread is head-independent: the thread is about the
 * conversation, not about which commit is current, and a pin would add a failure mode protecting
 * no invariant (`sources/SCM.md` §2.6).
 */
export const BitbucketCommentResolutionInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  /** The comment id exactly as this source's own Comments projection published it. */
  commentId: defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    minLength: 1,
  }),
}, { policy: 'closed' });
export type BitbucketCommentResolutionInputV1 = ReturnType<
  typeof BitbucketCommentResolutionInputV1Schema.parse
>;

/**
 * What one resolve or reopen settled into.
 *
 * This is deliberately NOT the pull-request result vocabulary above. Every arm there carries the
 * re-observed **entry**, and a comment is not the entry: handing back a pull-request observation
 * for a comment write would answer a question the caller did not ask. What comes back instead is
 * the comment's own re-read resolution.
 *
 * There is no `pending` arm. Bitbucket documents no asynchronous arm for this route the way it
 * does for merge, so a write it accepted either shows in the confirming read or is reported as
 * unconfirmed — never as a hopeful *maybe*.
 */
export const BitbucketCommentResolutionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    /** The confirming read's resolution. Equal to the requested one, or this is not the arm. */
    resolution: BitbucketCommentResolutionV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('refused'),
    /** The comment already reads that way, so nothing was written. */
    reason: defineProtocolLiteral('already-in-resolution'),
    resolution: BitbucketCommentResolutionV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('rejected'),
    /**
     * Bitbucket accepted the write and the confirming read does not show it.
     *
     * `unknown` reaches this arm too, and that is the point: a deployment that does not report
     * resolution cannot prove the effect, and reporting an unprovable write as applied is exactly
     * the quiet failure this vertical exists to refuse.
     */
    reason: defineProtocolLiteral('resolution-unconfirmed'),
    resolution: BitbucketCommentResolutionV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unchanged'),
    resolution: BitbucketCommentResolutionV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    resolution: BitbucketCommentResolutionV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
]);
export type BitbucketCommentResolutionResultV1 = ReturnType<
  typeof BitbucketCommentResolutionResultV1Schema.parse
>;
