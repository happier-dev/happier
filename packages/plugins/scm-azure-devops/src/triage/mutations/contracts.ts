import {
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUniqueArray,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  ReviewCommentPublicationResultV1ProtocolSchema,
  defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema,
  defineReviewCommentRevisionedSingleEntryPublicationPlanV1ProtocolSchema,
  ReviewCommentUnversionedSingleEntryPublicationPlanV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/reviews';
import {
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
  TriageSourceObservationV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * The five enabled Azure DevOps pull-request mutation contracts.
 *
 * `sources/SCM.md` §3.8 rules out a generic `mutate({ operation, payload })`, so each write is its
 * own exact Action with its own closed input. Every settled arm carries the **re-observed entity**
 * rather than a boolean: a boolean forces the caller into a second read, and that second read is a
 * second race.
 */

const CommitIdSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  minLength: 1,
});
const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});

const revisionedPublicationPlanSchema =
  defineReviewCommentRevisionedPublicationPlanV1ProtocolSchema(CommitIdSchema);
const revisionedSingleEntryPublicationPlanSchema =
  defineReviewCommentRevisionedSingleEntryPublicationPlanV1ProtocolSchema(CommitIdSchema);

const publicationTargetShape = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
} as const;

/** Publishes an ordered frozen Reviews plan, comments first and the reviewer vote last. */
export const AzureSubmitReviewInputV1Schema = defineProtocolObject(
  { ...publicationTargetShape, publicationPlan: revisionedPublicationPlanSchema },
  { policy: 'closed' },
);
export type AzureSubmitReviewInputV1 = ReturnType<typeof AzureSubmitReviewInputV1Schema.parse>;

/** Creates one new Azure thread from one canonical review comment. */
export const AzureThreadCommentCreateInputV1Schema = defineProtocolObject(
  { ...publicationTargetShape, publicationPlan: revisionedSingleEntryPublicationPlanSchema },
  { policy: 'closed' },
);
export type AzureThreadCommentCreateInputV1 = ReturnType<
  typeof AzureThreadCommentCreateInputV1Schema.parse
>;

/** Replies to one exact Azure thread/comment using one unversioned canonical publication entry. */
export const AzureThreadReplyInputV1Schema = defineProtocolObject({
  ...publicationTargetShape,
  publicationPlan: ReviewCommentUnversionedSingleEntryPublicationPlanV1ProtocolSchema,
  threadId: defineProtocolNumber({ integer: true, minimum: 1 }),
  parentCommentId: defineProtocolNumber({ integer: true, minimum: 1 }),
}, { policy: 'closed' });
export type AzureThreadReplyInputV1 = ReturnType<typeof AzureThreadReplyInputV1Schema.parse>;

/**
 * Provider publication either returns the canonical exact-cardinality result or refuses before
 * the generic Reviews dispatch claim. A claimed plan always settles, including partial/uncertain
 * effects; it is never flattened into a coarse mutation boolean.
 */
export const AzureReviewPublicationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('settled'),
    publication: ReviewCommentPublicationResultV1ProtocolSchema,
    observation: TriageSourceObservationV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('rejected'),
    reason: defineProtocolUnion([
      defineProtocolLiteral('invalid-input'),
      defineProtocolLiteral('admission-failed'),
      defineProtocolLiteral('base-advanced'),
      defineProtocolLiteral('head-advanced'),
      defineProtocolLiteral('state-changed'),
      defineProtocolLiteral('dispatch-claim-failed'),
      defineProtocolLiteral('unsupported-anchor'),
      defineProtocolLiteral('thread-not-found'),
      defineProtocolLiteral('provider-rejected'),
    ]),
    observation: TriageSourceObservationV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
]);
export type AzureReviewPublicationResultV1 = ReturnType<
  typeof AzureReviewPublicationResultV1Schema.parse
>;

const BooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

/**
 * `azure-devops/pull-request/complete`.
 *
 * The head pin is required and is the exact source commit the read the user acted on observed.
 * Azure's seven updatable properties do not include a merge-source precondition, so the pin is
 * enforced the way `sources/SCM.md` §2.6 requires where no native precondition exists: read,
 * compare, and refuse before writing — never fill the pin from a fresh read at write time.
 */
export const AzureCompleteInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /** `lastMergeSourceCommit.commitId` as the user's own read reported it. */
  observedSourceCommitId: CommitIdSchema,
  /**
   * The caller's branch decision, required and never defaulted.
   *
   * `transitionWorkItems` and `bypassPolicy` are deliberately **not** inputs: both are always sent
   * as an explicit `false`, because moving somebody's Work Items and bypassing branch policy are
   * authorities pressing *complete* does not grant.
   */
  deleteSourceBranch: BooleanSchema,
}, { policy: 'closed' });
export type AzureCompleteInputV1 = ReturnType<typeof AzureCompleteInputV1Schema.parse>;

/**
 * `azure-devops/pull-request/abandon`.
 *
 * No head pin: abandoning is head-independent, and carrying one would add a failure mode that
 * protects no invariant.
 */
export const AzureAbandonInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });
export type AzureAbandonInputV1 = ReturnType<typeof AzureAbandonInputV1Schema.parse>;

/**
 * `azure-devops/pull-request/reactivate`.
 *
 * Azure's reopen, and the exact inverse of abandon: the same `status` property, set back to
 * `active`. It carries no head pin for the same reason abandon carries none — reactivating is
 * head-independent, and a pin would add a failure mode protecting no invariant.
 */
export const AzureReactivateInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });
export type AzureReactivateInputV1 = ReturnType<typeof AzureReactivateInputV1Schema.parse>;

const IdentityIdSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
  minLength: 1,
});

/**
 * `azure-devops/pull-request/request-review`.
 *
 * **Additive, never a reviewer set.** The input carries only identity ids: no `vote`, no
 * `isRequired`, no display metadata. That is not a convenience — Azure's reviewer routes can carry
 * a vote, and a request-review that shipped one would reset somebody's approval as a side effect
 * of asking a third person to look. The closed policy makes such a field unrepresentable rather
 * than merely unused.
 *
 * The head pin is required (`sources/SCM.md` §6.7): a reviewer asked to look at what the requester
 * saw must not silently be asked about commits that landed afterwards.
 */
export const AzureRequestReviewInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /** `lastMergeSourceCommit.commitId` as the user's own read reported it. */
  observedSourceCommitId: CommitIdSchema,
  /** One or more explicitly selected Azure DevOps identity ids. Duplicates are rejected. */
  reviewerIds: defineProtocolUniqueArray(IdentityIdSchema, {
    minItems: 1,
  }),
}, { policy: 'closed' });
export type AzureRequestReviewInputV1 = ReturnType<typeof AzureRequestReviewInputV1Schema.parse>;

/** Why a write was never sent. Every reason is established by the fresh pre-write read. */
const AzureMutationRefusalReasonV1Schema = defineProtocolUnion([
  /** The pinned source commit is no longer the pull request's merge source. */
  defineProtocolLiteral('head-advanced'),
  /** The pull request is no longer active, so the requested transition no longer applies. */
  defineProtocolLiteral('entry-not-active'),
  /** The pull request is not abandoned, so there is nothing for a reactivation to undo. */
  defineProtocolLiteral('entry-not-abandoned'),
  /**
   * One of the requested identities already reviews this pull request.
   *
   * Nothing is written, because Azure's additive reviewer route carries a vote field it defaults
   * for a reviewer it already knows — so re-adding an existing reviewer is how an approval gets
   * silently reset. There is nothing to add, and refusing says so.
   */
  defineProtocolLiteral('reviewer-already-present'),
]);

/**
 * Why a completion Azure accepted did not complete.
 *
 * Azure names three terminal merge failures and they are never one generic error: `conflicts`,
 * `rejectedByPolicy` and `failure`, diagnosed further by `mergeFailureType`/`mergeFailureMessage`.
 * `fields-ignored` is the fourth and quietest: Azure answered `200` and silently applied nothing.
 */
const AzureMutationRejectionReasonV1Schema = defineProtocolUnion([
  defineProtocolLiteral('conflicts'),
  defineProtocolLiteral('rejectedByPolicy'),
  defineProtocolLiteral('failure'),
  defineProtocolLiteral('fields-ignored'),
]);

/**
 * The one result vocabulary every Azure pull-request-scoped mutation settles into.
 *
 * `applied` and `pending` are separate arms because Azure completion is asynchronous and its `200`
 * is about the request. Terminal success is `status === 'completed'` **and**
 * `mergeStatus === 'succeeded'` **and** a populated `lastMergeCommit`, observed by a poll — so a
 * queued merge settles as `pending` and the UI never says *merged* about it.
 */
export const AzureMutationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    /** The polled observation that proved the terminal state. */
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('pending'),
    /** The last observation the bounded poll reached; accepted, not proven. */
    observation: TriageSourceObservationV1Schema,
    /**
     * Set when Azure reports auto-complete on this pull request, in which case completion fires
     * later on policy satisfaction — outside this request entirely, and `pending` is the honest
     * answer indefinitely rather than a poll that failed.
     */
    autoCompleteEnabled: defineProtocolLiteral(true).optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('refused'),
    reason: AzureMutationRefusalReasonV1Schema,
    /** The fresh read that caused the refusal. Nothing was written. */
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('rejected'),
    reason: AzureMutationRejectionReasonV1Schema,
    /** Azure's own `mergeFailureMessage`, when it supplied one. */
    detail: defineProtocolUtf8String({
      maxUtf8Bytes: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
      minLength: 1,
    }).optional(),
    observation: TriageSourceObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    observation: TriageSourceObservationV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
]);
export type AzureMutationResultV1 = ReturnType<typeof AzureMutationResultV1Schema.parse>;

/* -------------------------------------------------------------- thread status */

/**
 * The Azure comment-thread statuses a person can ask for.
 *
 * They are Azure's own `CommentThreadStatus` names, minus `unknown`: `unknown` is what Azure
 * reports for a thread nobody has given a status, not an intent anybody expresses. Offering it
 * would let a reader "set" a thread to *we do not know*, which is a state only the provider can
 * mean.
 */
export const AZURE_REQUESTABLE_THREAD_STATUSES_V1 = Object.freeze([
  'active',
  'fixed',
  'wontFix',
  'closed',
  'byDesign',
  'pending',
] as const);
export type AzureRequestableThreadStatusV1 = (typeof AZURE_REQUESTABLE_THREAD_STATUSES_V1)[number];

const AzureRequestableThreadStatusV1Schema = defineProtocolUnion([
  defineProtocolLiteral('active'),
  defineProtocolLiteral('fixed'),
  defineProtocolLiteral('wontFix'),
  defineProtocolLiteral('closed'),
  defineProtocolLiteral('byDesign'),
  defineProtocolLiteral('pending'),
]);

/**
 * What a thread's status reads as, which is a wider vocabulary than what may be asked for.
 *
 * `unknown` is a real Azure value AND this source's answer for a status it does not recognize or
 * a thread that carries none. Mapping an unrecognized provider status onto `active` would tell a
 * reviewer an unfamiliar state is an open one.
 */
const AzureObservedThreadStatusV1Schema = defineProtocolUnion([
  AzureRequestableThreadStatusV1Schema,
  defineProtocolLiteral('unknown'),
]);

/**
 * `azure-devops/pull-request/thread-status`.
 *
 * The thread id is the one the mounted Threads panel rendered, spelled exactly as that projection
 * publishes it: a positive integer as text.
 */
export const AzureThreadStatusInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  threadId: defineProtocolUtf8String({
    maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    minLength: 1,
  }),
  status: AzureRequestableThreadStatusV1Schema,
}, { policy: 'closed' });
export type AzureThreadStatusInputV1 = ReturnType<typeof AzureThreadStatusInputV1Schema.parse>;

/**
 * What one thread-status write settled into.
 *
 * This is deliberately NOT the pull-request result vocabulary above. Every arm there carries the
 * re-observed **entry**, and a thread is not the entry: returning a pull-request observation for a
 * thread write would hand the caller a value that says nothing about what they changed. What comes
 * back instead is the thread's own re-read status.
 *
 * There is no `pending` arm, because this write is not asynchronous: Azure applies a thread status
 * update or ignores the property. A confirming read that disagrees with what was sent is
 * `fields-ignored` — the same quiet failure the completion path names — never a hopeful *maybe*.
 */
export const AzureThreadStatusResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    /** The confirming read's status. Equal to the requested one, or this is not the arm. */
    status: AzureObservedThreadStatusV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('refused'),
    /** The thread already carries the requested status, so nothing was written. */
    reason: defineProtocolLiteral('already-in-status'),
    status: AzureObservedThreadStatusV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('rejected'),
    /** Azure answered success and the confirming read still shows a different status. */
    reason: defineProtocolLiteral('fields-ignored'),
    status: AzureObservedThreadStatusV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    failure: TriageSourceFailureV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    status: AzureObservedThreadStatusV1Schema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
]);
export type AzureThreadStatusResultV1 = ReturnType<typeof AzureThreadStatusResultV1Schema.parse>;
