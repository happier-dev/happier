import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUniqueArray,
  defineProtocolUtf8String,
  type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
  TriageSourceObservationV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * The GitHub pull-request mutation contracts.
 *
 * Each externally visible write is an EXACT Action with its own strict input.
 * There is no `mutate({ operation, payload })` here and there will not be one: a
 * generic envelope turns the dangerous operation into a runtime string the
 * manifest cannot classify, cannot confirm differently, and cannot keep off the
 * agent surface.
 *
 * `merge`, `mark-ready` and `update-branch` carry the head the user's decision
 * was made against. `close`, `reopen` and the two reviewer deltas do not, and
 * that omission is deliberate (SCM.md 2.6): they are head-independent, so
 * pinning them would add a failure mode protecting no invariant.
 *
 * The pin's test is one question — does this write fan out a notification that
 * asserts something about a specific observed commit set? Draft→ready summons
 * every named reviewer to review exactly the commits the acting user saw, and
 * update-branch rewrites the branch the user was looking at, so both pin. A
 * reviewer delta names a person, not a commit, so it does not.
 *
 * Every result returns the RE-OBSERVED entity rather than a boolean. A boolean
 * forces the caller into a second read, and that second read is a second race.
 */

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});

/**
 * A commit identity as GitHub publishes it: lowercase hex, wide enough for the
 * SHA-256 object format it has begun to describe. It is never normalized,
 * abbreviated or re-cased — the value compared against the provider is the exact
 * value produced by the read the user acted on.
 */
const RevisionSchema = defineProtocolUtf8String({
  maxUtf8Bytes: 64,
  minLength: 7,
  pattern: '^[0-9a-f]{7,64}$',
});

/** GitHub's own merge-method vocabulary, verbatim. */
export const GithubMergeMethodV1Schema = defineProtocolUnion([
  defineProtocolLiteral('merge'),
  defineProtocolLiteral('squash'),
  defineProtocolLiteral('rebase'),
]);
export type GithubMergeMethodV1 = ReturnType<typeof GithubMergeMethodV1Schema.parse>;

/** GitHub's documented merge-commit fields. Bounded, and never defaulted. */
const CommitTitleSchema = defineProtocolUtf8String({ maxUtf8Bytes: 1_024, minLength: 1 });
const CommitMessageSchema = defineProtocolUtf8String({ maxUtf8Bytes: 16_384, minLength: 1 });

/**
 * What every write names: the exact configured instance whose account is
 * rematerialized for this invocation, the canonical entry ref, and the
 * source-private route the target observed for THIS entry. Cached corpus bytes
 * explain what the user selected; they never authorize the write.
 */
const mutationTargetShape = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
} as const;

export const GithubPullRequestMergeInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  /**
   * The head the USER saw. It is required, it is never filled from a fresh read
   * at write time, and it is passed straight to GitHub's own `sha` precondition.
   * Its whole value is that it comes from the read the user acted on.
   */
  headRevision: RevisionSchema,
  mergeMethod: GithubMergeMethodV1Schema,
  commitTitle: CommitTitleSchema.optional(),
  commitMessage: CommitMessageSchema.optional(),
}, { policy: 'closed' });
export type GithubPullRequestMergeInputV1 =
  ReturnType<typeof GithubPullRequestMergeInputV1Schema.parse>;

/**
 * Draft → ready for review. It carries the pinned head and nothing else: the
 * transition itself is the whole request, and GitHub's own transition accepts no
 * other field.
 */
export const GithubPullRequestMarkReadyInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  /**
   * The head the USER saw. GitHub's ready-for-review transition accepts NO
   * precondition of its own, so this pin is enforced by read-compare-refuse
   * before any request leaves — never by filling it from the fresh read.
   */
  headRevision: RevisionSchema,
}, { policy: 'closed' });
export type GithubPullRequestMarkReadyInputV1 =
  ReturnType<typeof GithubPullRequestMarkReadyInputV1Schema.parse>;

/**
 * Update this pull request's branch from its base.
 *
 * The pinned head is BOTH compared against a fresh read and passed to GitHub's
 * own `expected_head_sha` precondition, so the window between our read and
 * GitHub's write is closed by GitHub itself rather than by our comparison alone.
 */
export const GithubPullRequestUpdateBranchInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  headRevision: RevisionSchema,
}, { policy: 'closed' });
export type GithubPullRequestUpdateBranchInputV1 =
  ReturnType<typeof GithubPullRequestUpdateBranchInputV1Schema.parse>;

/**
 * A GitHub user login or organization team slug, as the CALLER supplies it.
 *
 * Inbound names are patterned because they become path-free request body values
 * this source is responsible for; observed names coming back from GitHub are
 * parsed with the looser schema below, because refusing to report a name GitHub
 * actually returned would turn a successful write into an unreadable result.
 */
const ReviewerNameInputSchema = defineProtocolUtf8String({
  maxUtf8Bytes: 100,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
});
const ReviewerNamesInputSchema = defineProtocolUniqueArray(ReviewerNameInputSchema, {
  minItems: 1,
});

/**
 * The shape both reviewer deltas carry: EXACTLY the named users and/or teams.
 *
 * There is no `desiredReviewers`, no `set`, no empty delta and no add/remove
 * discriminant. A desired full set would silently withdraw a reviewer someone
 * else requested between our read and our write; a delta cannot. Both members
 * are optional individually and at least one must be present — that pairing is
 * checked at the Action, because "at least one of two optional fields" is a
 * cross-field rule no single field schema can carry.
 *
 * The direction is the ACTION ID, never a field. A `{ operation: 'remove' }`
 * discriminant would put the difference between summoning a reviewer and
 * withdrawing one into a runtime string the manifest cannot classify, cannot
 * confirm differently, and cannot describe to the person approving it.
 */
const reviewerDeltaShape = {
  ...mutationTargetShape,
  users: ReviewerNamesInputSchema.optional(),
  teams: ReviewerNamesInputSchema.optional(),
} as const;

/** Requests review from exactly the named users and/or teams. */
export const GithubPullRequestAddReviewersInputV1Schema = defineProtocolObject(
  { ...reviewerDeltaShape },
  { policy: 'closed' },
);
export type GithubPullRequestAddReviewersInputV1 =
  ReturnType<typeof GithubPullRequestAddReviewersInputV1Schema.parse>;

/**
 * Withdraws the review request from exactly the named users and/or teams.
 *
 * It is its own input identity rather than a flag on the one above so the two
 * Actions stay two exact writes. They are structurally identical because the
 * delta a caller names is the same in both directions; sharing the SHAPE while
 * keeping two ids is what avoids both a duplicate definition and a runtime
 * direction field.
 */
export const GithubPullRequestRemoveReviewersInputV1Schema = defineProtocolObject(
  { ...reviewerDeltaShape },
  { policy: 'closed' },
);
export type GithubPullRequestRemoveReviewersInputV1 =
  ReturnType<typeof GithubPullRequestRemoveReviewersInputV1Schema.parse>;

export const GithubPullRequestCloseInputV1Schema = defineProtocolObject(
  { ...mutationTargetShape },
  { policy: 'closed' },
);
export type GithubPullRequestCloseInputV1 =
  ReturnType<typeof GithubPullRequestCloseInputV1Schema.parse>;

export const GithubPullRequestReopenInputV1Schema = defineProtocolObject(
  { ...mutationTargetShape },
  { policy: 'closed' },
);
export type GithubPullRequestReopenInputV1 =
  ReturnType<typeof GithubPullRequestReopenInputV1Schema.parse>;

/**
 * The arms every write result shares, minus its own refusal vocabulary.
 *
 * `applied` is the only arm that claims an effect, and it claims it only after
 * the confirming read observed the requested terminal state.
 */
const AppliedArmSchema = defineProtocolObject({
  kind: defineProtocolLiteral('applied'),
  /**
   * `alreadySatisfied` is not a softer success: it states that NO request was
   * sent because the provider already held the requested state. A state
   * transition stays idempotent because the second call converges on the same
   * state rather than creating a second object.
   */
  effect: defineProtocolUnion([
    defineProtocolLiteral('changed'),
    defineProtocolLiteral('alreadySatisfied'),
  ]),
  observation: TriageSourceObservationV1Schema,
}, { policy: 'closed' });

/**
 * The request was accepted and its effect could not be confirmed. It is NEVER
 * reported as success and never automatically retried: the user's decision was
 * about the state they saw, and a retry re-decides on their behalf.
 */
const UncertainArmSchema = defineProtocolObject({
  kind: defineProtocolLiteral('uncertain'),
  observation: TriageSourceObservationV1Schema.optional(),
  failure: TriageSourceFailureV1Schema.optional(),
}, { policy: 'closed' });

/** No effect reached GitHub, and the provider or this source said exactly why. */
const FailedArmSchema = defineProtocolObject({
  kind: defineProtocolLiteral('failed'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/**
 * A refusal is this source's own decision, made from a fresh provider read, and
 * it is a different answer from a provider rejection: it carries the currently
 * observed entity so the host re-renders what is true now instead of prompting a
 * blind retry. Refusing is correct; racing is not.
 */
function defineRefusedArm(reason: ProtocolComposableSchema<string, string>) {
  return defineProtocolObject({
    kind: defineProtocolLiteral('refused'),
    reason,
    /** Omitted only when the confirming read itself could not be made. */
    observation: TriageSourceObservationV1Schema.optional(),
  }, { policy: 'closed' });
}

/**
 * Merge can refuse for four reasons; a state change can refuse for one. They are
 * separate schemas because a vocabulary arm no path can reach is a claim the
 * surface would have to render and this source could never produce.
 */
export const GithubPullRequestMergeResultV1Schema = defineProtocolUnion([
  AppliedArmSchema,
  defineRefusedArm(defineProtocolUnion([
    /** The provider head no longer equals the SHA the user acted on. */
    defineProtocolLiteral('head_advanced'),
    /** The current state cannot satisfy this transition at all. */
    defineProtocolLiteral('state_changed'),
    /** GitHub itself will not merge this pull request right now. */
    defineProtocolLiteral('not_mergeable'),
    /** The repository's own settings forbid the requested merge method. */
    defineProtocolLiteral('merge_method_not_allowed'),
  ])),
  UncertainArmSchema,
  FailedArmSchema,
]);
export type GithubPullRequestMergeResultV1 =
  ReturnType<typeof GithubPullRequestMergeResultV1Schema.parse>;

/**
 * One entry's state transition, answered with the re-observed entry.
 *
 * BOTH the pull-request and the issue transitions declare this union. Closing a
 * pull request and closing an issue are the same claim about two different
 * entities, and a second kind-shaped copy of these four arms would be a second
 * vocabulary a surface must learn for one fact — which would drift the first time
 * an arm was added to either. The name stays pull-request-flavoured only because
 * `src/ui/detail/mutations.ts` already imports it under that name.
 */
export const GithubPullRequestStateResultV1Schema = defineProtocolUnion([
  AppliedArmSchema,
  defineRefusedArm(defineProtocolLiteral('state_changed')),
  UncertainArmSchema,
  FailedArmSchema,
]);
export type GithubPullRequestStateResultV1 =
  ReturnType<typeof GithubPullRequestStateResultV1Schema.parse>;

/**
 * Draft → ready refuses for the same two reasons a head-pinned transition can:
 * the head the user acted on moved, or the pull request is no longer in a state
 * this transition applies to.
 */
export const GithubPullRequestMarkReadyResultV1Schema = defineProtocolUnion([
  AppliedArmSchema,
  defineRefusedArm(defineProtocolUnion([
    defineProtocolLiteral('head_advanced'),
    defineProtocolLiteral('state_changed'),
  ])),
  UncertainArmSchema,
  FailedArmSchema,
]);
export type GithubPullRequestMarkReadyResultV1 =
  ReturnType<typeof GithubPullRequestMarkReadyResultV1Schema.parse>;

/**
 * `pending` exists for exactly one provider fact: GitHub answers a branch update
 * with `202 Accepted`, which states that it took the request — not that the
 * branch moved. The confirming read may still observe the old head, and calling
 * that `applied` would tell the user their branch was updated when the update is
 * queued. It is also not `uncertain`: nothing here is unknown, the request was
 * accepted and the effect has simply not landed yet.
 *
 * The arm carries the re-observed entity so the surface renders the head GitHub
 * currently has, and this source neither polls on its own timer nor issues a
 * second PUT.
 */
const AcceptedPendingArmSchema = defineProtocolObject({
  kind: defineProtocolLiteral('pending'),
  observation: TriageSourceObservationV1Schema,
}, { policy: 'closed' });

export const GithubPullRequestUpdateBranchResultV1Schema = defineProtocolUnion([
  AppliedArmSchema,
  AcceptedPendingArmSchema,
  defineRefusedArm(defineProtocolUnion([
    defineProtocolLiteral('head_advanced'),
    defineProtocolLiteral('state_changed'),
  ])),
  UncertainArmSchema,
  FailedArmSchema,
]);
export type GithubPullRequestUpdateBranchResultV1 =
  ReturnType<typeof GithubPullRequestUpdateBranchResultV1Schema.parse>;

/**
 * The reviewer set as GITHUB currently reports it, which is what this write's
 * re-observation is: a pull-request snapshot would not say who is now requested.
 *
 * Observed names are bounded but unpatterned. GitHub owns its own login and slug
 * vocabulary, and refusing to report a name it actually returned would turn a
 * successful write into an unreadable result.
 */
const ObservedReviewerNameSchema = defineProtocolUtf8String({
  maxUtf8Bytes: 255,
  minLength: 1,
});
const RequestedReviewersSchema = defineProtocolObject({
  users: defineProtocolArray(ObservedReviewerNameSchema),
  teams: defineProtocolArray(ObservedReviewerNameSchema),
}, { policy: 'closed' });
export type GithubRequestedReviewersV1 = ReturnType<typeof RequestedReviewersSchema.parse>;

/**
 * Both reviewer deltas answer with the same union, because they answer the same
 * question — who is requested NOW — and a second, direction-shaped result would
 * be a second vocabulary a surface has to learn for one fact.
 *
 * Neither has a refusal vocabulary, and that absence is the point: a vocabulary
 * arm no path can reach is a claim the surface would have to render and this
 * source could never produce. There is no head to compare and no state this
 * source decides for GitHub — a pull request GitHub will not accept a reviewer
 * change for answers with its own classified failure.
 *
 * `alreadySatisfied` is reachable and load-bearing in both directions. Adding a
 * reviewer who is already pending is not free — GitHub re-notifies them — and
 * withdrawing one who is not requested is a write with no effect to confirm. The
 * preflight read is what keeps the addition at-most-once.
 */
export const GithubPullRequestReviewersResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    effect: defineProtocolUnion([
      defineProtocolLiteral('changed'),
      defineProtocolLiteral('alreadySatisfied'),
    ]),
    requestedReviewers: RequestedReviewersSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    requestedReviewers: RequestedReviewersSchema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
  FailedArmSchema,
]);
export type GithubPullRequestReviewersResultV1 =
  ReturnType<typeof GithubPullRequestReviewersResultV1Schema.parse>;

/* ------------------------------------------------------------- issue writes */

/**
 * GitHub's own `state_reason` vocabulary for closing an issue.
 *
 * It is REQUIRED and never defaulted. GitHub distinguishes "this is done" from
 * "this will not be done" and shows the difference to everyone watching, so
 * silently picking `completed` for a person who meant `not_planned` publishes a
 * claim they did not make.
 */
export const GithubIssueCloseReasonV1Schema = defineProtocolUnion([
  defineProtocolLiteral('completed'),
  defineProtocolLiteral('not_planned'),
  defineProtocolLiteral('duplicate'),
]);
export type GithubIssueCloseReasonV1 = ReturnType<typeof GithubIssueCloseReasonV1Schema.parse>;

export const GithubIssueCloseInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  stateReason: GithubIssueCloseReasonV1Schema,
}, { policy: 'closed' });
export type GithubIssueCloseInputV1 = ReturnType<typeof GithubIssueCloseInputV1Schema.parse>;

/**
 * Reopening carries no reason: GitHub sets `state_reason` to `reopened` itself,
 * and there is no second thing a person could mean by it.
 */
export const GithubIssueReopenInputV1Schema = defineProtocolObject(
  { ...mutationTargetShape },
  { policy: 'closed' },
);
export type GithubIssueReopenInputV1 = ReturnType<typeof GithubIssueReopenInputV1Schema.parse>;

/**
 * A GitHub user login, as the CALLER supplies it. GitHub's own limit on one
 * assignee request is ten, and it is stated here rather than discovered as a
 * provider rejection after the request left.
 */
const AssigneeNameInputSchema = defineProtocolUtf8String({
  maxUtf8Bytes: 39,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9-]*$',
});
const AssigneeNamesInputSchema = defineProtocolUniqueArray(AssigneeNameInputSchema, {
  minItems: 1,
  maxItems: 10,
});

/**
 * A label NAME as GitHub stores it: free text, not a slug. It is bounded and
 * unpatterned on purpose — a repository's labels legitimately carry spaces,
 * punctuation and emoji, and refusing one because it is not slug-shaped would
 * make a real label unremovable. It reaches GitHub as one encoded path segment
 * or as a JSON body value, never as raw path text.
 */
const LabelNameInputSchema = defineProtocolUtf8String({ maxUtf8Bytes: 255, minLength: 1 });
const LabelNamesInputSchema = defineProtocolUniqueArray(LabelNameInputSchema, { minItems: 1 });

/**
 * The four issue deltas, each with its own strict input and its own Action id.
 *
 * No schema admits `desiredAssignees`, `desiredLabels`, `desired`, `set`, an
 * empty delta, or an add/remove operation discriminant. A desired full set is
 * remove-all authority a person did not grant: it would silently drop the
 * assignee or label a colleague added between our read and our write.
 */
export const GithubIssueAssigneeAddInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  usernames: AssigneeNamesInputSchema,
}, { policy: 'closed' });
export type GithubIssueAssigneeAddInputV1 =
  ReturnType<typeof GithubIssueAssigneeAddInputV1Schema.parse>;

export const GithubIssueAssigneeRemoveInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  usernames: AssigneeNamesInputSchema,
}, { policy: 'closed' });
export type GithubIssueAssigneeRemoveInputV1 =
  ReturnType<typeof GithubIssueAssigneeRemoveInputV1Schema.parse>;

export const GithubIssueLabelAddInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  labels: LabelNamesInputSchema,
}, { policy: 'closed' });
export type GithubIssueLabelAddInputV1 =
  ReturnType<typeof GithubIssueLabelAddInputV1Schema.parse>;

/**
 * Exactly ONE label, because GitHub's native single-label delete is
 * `DELETE .../labels/{name}` and nothing else removes one label. The alternative
 * endpoints — `PUT .../labels` and `DELETE .../labels` — replace or clear the
 * whole set, which is authority this Action does not have.
 */
export const GithubIssueLabelRemoveInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  label: LabelNameInputSchema,
}, { policy: 'closed' });
export type GithubIssueLabelRemoveInputV1 =
  ReturnType<typeof GithubIssueLabelRemoveInputV1Schema.parse>;

/**
 * Every issue delta answers with the re-observed issue and has no refusal
 * vocabulary: there is no head to compare and no state this source decides for
 * GitHub. `alreadySatisfied` states that the exact named delta already held, so
 * no request was sent at all.
 *
 * Confirmation checks ONLY the named members. It never requires the observed set
 * to equal anything, because a colleague's unrelated addition or removal between
 * our write and our read is not a failure of this Action.
 */
export const GithubIssueDeltaResultV1Schema = defineProtocolUnion([
  AppliedArmSchema,
  UncertainArmSchema,
  FailedArmSchema,
]);
export type GithubIssueDeltaResultV1 =
  ReturnType<typeof GithubIssueDeltaResultV1Schema.parse>;

/* ------------------------------------------------- review thread resolution */

/**
 * A GitHub GraphQL node id, exactly as the read that produced it published it.
 *
 * It is OPAQUE: bounded, never parsed, never composed from a number, and never
 * re-cased. GitHub's own ids are URL-safe base64 today, but the vocabulary is
 * the provider's to change, so the only rule this source enforces is that the
 * value is a bounded non-empty string it received rather than invented.
 */
const NodeIdSchema = defineProtocolUtf8String({ maxUtf8Bytes: 255, minLength: 1 });

const GithubBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

/**
 * Resolve or reopen ONE line-anchored review thread.
 *
 * `resolved` is the state the caller wants the thread to hold, not a verb, and
 * that is what makes this one idempotent Action rather than two: a second call
 * converges on the same state instead of creating a second object, and the
 * confirming read answers the same question in both directions. Both directions
 * are declared because both are real — a thread resolved by mistake has to be
 * reopenable, and an Action that could only resolve would make the mistake
 * permanent from here.
 *
 * There is no head pin. A thread is anchored to a comment, not to a commit, so
 * pinning the head would add a failure mode protecting no invariant: a push
 * between the read and the write changes nothing about which conversation this
 * is.
 *
 * `threadId` is global. It names a thread anywhere the rebound account can
 * reach, which is why the Action's own read proves the thread belongs to the
 * admitted entry BEFORE it writes, and refuses rather than guesses when it does
 * not.
 */
export const GithubPullRequestThreadResolutionInputV1Schema = defineProtocolObject({
  ...mutationTargetShape,
  threadId: NodeIdSchema,
  resolved: GithubBooleanSchema,
}, { policy: 'closed' });
export type GithubPullRequestThreadResolutionInputV1 =
  ReturnType<typeof GithubPullRequestThreadResolutionInputV1Schema.parse>;

/**
 * The thread as GITHUB currently reports it, which is what this write's
 * re-observation is: an entry snapshot would not say whether this conversation
 * is resolved.
 */
const ObservedReviewThreadSchema = defineProtocolObject({
  id: NodeIdSchema,
  isResolved: GithubBooleanSchema,
}, { policy: 'closed' });
export type GithubObservedReviewThreadV1 = ReturnType<typeof ObservedReviewThreadSchema.parse>;

/**
 * Resolution answers with the re-observed THREAD and has no refusal vocabulary.
 *
 * There is no head to compare and no state this source decides for GitHub. A
 * thread this Action must not touch — absent, not a review thread, or on another
 * entry — is a stated failure rather than a refusal, because a refusal exists to
 * hand back the entity the user should re-decide against, and there is no such
 * entity when the request named the wrong one.
 *
 * `alreadySatisfied` is reachable and load-bearing: it states that the thread
 * already held the requested state, so no mutation was sent at all.
 */
export const GithubPullRequestThreadResolutionResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('applied'),
    effect: defineProtocolUnion([
      defineProtocolLiteral('changed'),
      defineProtocolLiteral('alreadySatisfied'),
    ]),
    thread: ObservedReviewThreadSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('uncertain'),
    thread: ObservedReviewThreadSchema.optional(),
    failure: TriageSourceFailureV1Schema.optional(),
  }, { policy: 'closed' }),
  FailedArmSchema,
]);
export type GithubPullRequestThreadResolutionResultV1 =
  ReturnType<typeof GithubPullRequestThreadResolutionResultV1Schema.parse>;
