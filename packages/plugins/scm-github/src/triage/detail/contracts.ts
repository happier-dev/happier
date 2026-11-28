import { ForgeCiSelectionV1Schema } from '@happier-dev/triage-protocol/ci/v1';
import { ScmSuggestionV1ProtocolSchema } from '@happier-dev/protocol/scm';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
  ProtocolDeploymentReceiptOperationV1Schema,
  ProtocolDeploymentControllerAvailabilityV1Schema,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  TriageConfiguredSourceCredentialInstanceV1Schema as TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
  TriagePullRequestStatusV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
  GITHUB_DETAIL_BOUNDS_V1,
  GITHUB_MAX_CHANGED_FILE_ROWS_V1,
  GITHUB_MAX_TIMELINE_ROWS_V1,
  GITHUB_TIMELINE_KINDS_V1,
} from './projection.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../contribution.js';
import { GITHUB_CHECKS_STATES_V1, GITHUB_CHECKS_CONDITION_STATES_V1 } from '../types.js';
import { GITHUB_MERGE_METHODS_V1, GithubPullRequestPreviewStatusInputV1Schema } from '../mutations/contracts.js';
import { GITHUB_REVIEW_DECISIONS_V1 } from '../mapping/facts.js';
import { GITHUB_MAX_DETAIL_PAGE_SIZE_V1 } from './routes.js';
import {
  GITHUB_ISSUE_FEEDBACK_COMMENT_PAGE_SIZE_V1,
  GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1,
  GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1,
  GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1,
  GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1,
} from '../feedback.js';

/**
 * The source-native detail Action contracts.
 *
 * The detail body runs in a UI artifact that holds no credential and speaks no
 * HTTP, while `observations/githubApiClient.ts` is this source's sole credential
 * reader. The bridge between them is these Actions, declared with the same
 * public schema builders the shared Triage contract uses. They carry no Triage
 * role: a timeline event, a changed file, a check run and a comment are
 * GitHub-native content this source's own detail body reads, not Triage entries
 * the aggregate may hold.
 *
 * Every published bound is the exact value the boundary projector applies, so a
 * page the projector can produce always parses and a page it never could is
 * rejected here rather than becoming a second, looser statement of what may
 * leave this source. Each result object is `closed`, which is what makes an
 * accidentally widened projection a failure instead of a leak.
 *
 * The paging position is a token this source mints. GitHub's `Link` header is a
 * provider-controlled absolute URL, so it never crosses this boundary: it is
 * validated as the same request with only `page` advanced and reduced to that
 * page number by the read modules, and a mounted panel can neither request a
 * provider-chosen URL nor hold one in state. Like the scan continuation, this
 * token is invocation-local, is never persisted, and is never a watermark.
 */

const GithubBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineProtocolString({ minLength: 1 });
const TextSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const PathSchema = defineProtocolString({ minLength: 1 });
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
/**
 * A comment body may be empty: GitHub accepts a comment whose content is only an
 * attachment, and such a comment is still a real event in the conversation.
 */
const CommentBodySchema = defineProtocolString();
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });

const ReviewDecisionSchema = defineProtocolUnion([
  defineProtocolLiteral(GITHUB_REVIEW_DECISIONS_V1[0]),
  defineProtocolLiteral(GITHUB_REVIEW_DECISIONS_V1[1]),
  ...GITHUB_REVIEW_DECISIONS_V1.slice(2).map(decision => defineProtocolLiteral(decision)),
]);

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});

const ContinuationSchema = defineProtocolString({
  minLength: 1,
});

const PageLimitSchema = defineProtocolNumber({
  integer: true,
  minimum: 1,
  maximum: GITHUB_MAX_DETAIL_PAGE_SIZE_V1,
});

/**
 * Why a walk stopped short of the whole collection.
 *
 * `ceiling` is GitHub's documented 3,000-file changed-file maximum;
 * `pagination` is a next page GitHub advertised that this source refused to
 * follow. Both keep the rows already read, and neither is an empty result.
 */
const IncompleteReasonSchema = defineProtocolUnion([
  defineProtocolLiteral('ceiling'),
  defineProtocolLiteral('pagination'),
]);

/**
 * The shared shape of one paged plane request.
 *
 * `routingToken` is the source-private route the target observed for THIS entry
 * — the same evidence `get` accepts as `lastKnownLocator`. It grants no
 * authority: the account is rematerialized from the configured instance on every
 * invocation, and this source remains the only parser of its own token.
 */
const pagedPlaneInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  limit: PageLimitSchema,
  /** Present only for a following page, and only as this source minted it. */
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });

const GithubDetailUnavailableSchema = defineProtocolObject({
  kind: defineProtocolLiteral('unavailable'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/* ------------------------------------------------------------- capabilities */

const exactEntryInput = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
};
export const GithubCapabilitiesInputV1Schema = defineProtocolObject(exactEntryInput, { policy: 'closed' });

export const GithubPreviewInputV1Schema = defineProtocolObject({ ...exactEntryInput,
  serverId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export const GithubPreviewResultV1Schema = defineProtocolUnion([
  GithubDetailUnavailableSchema,
  defineProtocolObject({ kind: defineProtocolLiteral('preview'),
    headSha: defineProtocolString({ minLength: 1 }),
    previews: defineProtocolArray(defineProtocolUnion([
      defineProtocolObject({ kind: defineProtocolLiteral('preview'),
        environmentId: defineProtocolString({ minLength: 1 }),
        deploymentId: defineProtocolString({ minLength: 1 }),
        operation: ProtocolDeploymentReceiptOperationV1Schema,
        controller: ProtocolDeploymentControllerAvailabilityV1Schema.optional(),
        servingSha: defineProtocolString({ minLength: 1 }),
        state: defineProtocolUnion([
          defineProtocolLiteral('needsApproval'),
          defineProtocolLiteral('deploying'),
          defineProtocolLiteral('ready'),
          defineProtocolLiteral('failed'),
          defineProtocolLiteral('removed'),
          defineProtocolLiteral('outdated'),
        ]),
        targetUrl: defineProtocolUnion([defineProtocolString({ minLength: 1 }), defineProtocolLiteral(null)]),
        publication: defineProtocolUnion([
          defineProtocolObject({ kind: defineProtocolLiteral('current') }, { policy: 'closed' }),
          defineProtocolObject({ kind: defineProtocolLiteral('unpublished'), input: GithubPullRequestPreviewStatusInputV1Schema }, { policy: 'closed' }),
          defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), input: GithubPullRequestPreviewStatusInputV1Schema,
            failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
        ]).optional(),
      }, { policy: 'closed' }),
      defineProtocolObject({ kind: defineProtocolLiteral('unavailable'),
        environmentId: defineProtocolString({ minLength: 1 }), failure: TriageSourceFailureV1Schema,
        controller: ProtocolDeploymentControllerAvailabilityV1Schema.optional(),
      }, { policy: 'closed' }),
    ])),
  }, { policy: 'closed' }),
]);
export type GithubPreviewResultV1 = ReturnType<typeof GithubPreviewResultV1Schema.parse>;

const GithubCapabilityAvailabilitySchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('available') }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    code: defineProtocolLiteral('repository_unsupported'),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('denied'),
    code: defineProtocolLiteral('repository_archived'),
  }, { policy: 'closed' }),
]);
export type GithubCapabilityAvailabilityV1 = ReturnType<typeof GithubCapabilityAvailabilitySchema.parse>;

const GithubCapabilitiesValueV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('capabilities'),
    // A daemon may predate a write operation; absent preflight facts do not invalidate reads.
    operations: defineProtocolObject(Object.fromEntries(
      Object.keys(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1).map(key => [key, GithubCapabilityAvailabilitySchema.optional()]),
    ) as { [K in keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1]: ReturnType<typeof GithubCapabilityAvailabilitySchema.optional> }, { policy: 'closed' }),
    mergeMethods: defineProtocolObject(Object.fromEntries(
      GITHUB_MERGE_METHODS_V1.map(method => [method, GithubCapabilityAvailabilitySchema]),
    ) as { [K in (typeof GITHUB_MERGE_METHODS_V1)[number]]: typeof GithubCapabilityAvailabilitySchema }, { policy: 'closed' }),
    /** Explicit repository settings, distinct from permission to attempt a write. */
    mergeSettings: defineProtocolObject(Object.fromEntries(
      GITHUB_MERGE_METHODS_V1.map(method => [method, GithubBooleanSchema.nullable()]),
    ) as { [K in (typeof GITHUB_MERGE_METHODS_V1)[number]]: ReturnType<typeof GithubBooleanSchema.nullable> }, { policy: 'closed' }).optional(),
  }, { policy: 'closed' });
export const GithubCapabilitiesResultV1Schema = defineProtocolUnion([
  GithubCapabilitiesValueV1Schema,
  GithubDetailUnavailableSchema,
]);
export type GithubCapabilitiesResultV1 = ReturnType<typeof GithubCapabilitiesResultV1Schema.parse>;

/* -------------------------------------------------------------------- overview */

export const GithubOverviewInputV1Schema = defineProtocolObject({
  ...exactEntryInput,
  /** Explicit requirements disclosure; ordinary explained status never fans out to rules. */
  includeBranchRules: GithubBooleanSchema.optional(),
  /** Native repository directories are read only while an editor needs choices. */
  includePropertyChoices: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubPropertyChoicesV1Schema = defineProtocolObject({
  assignees: defineProtocolUnion([
    defineProtocolObject({
      kind: defineProtocolLiteral('available'),
      choices: defineProtocolArray(defineProtocolObject({ login: LabelSchema }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    GithubDetailUnavailableSchema,
  ]),
  labels: defineProtocolUnion([
    defineProtocolObject({
      kind: defineProtocolLiteral('available'),
      choices: defineProtocolArray(LabelSchema),
    }, { policy: 'closed' }),
    GithubDetailUnavailableSchema,
  ]),
}, { policy: 'closed' });
export type GithubPropertyChoicesV1 = ReturnType<typeof GithubPropertyChoicesV1Schema.parse>;

/** GitHub's native subscription state; an unavailable fact is omitted. */
export const GithubViewerSubscriptionV1Schema = defineProtocolUnion([
  defineProtocolLiteral('SUBSCRIBED'),
  defineProtocolLiteral('UNSUBSCRIBED'),
  defineProtocolLiteral('IGNORED'),
]);
export type GithubViewerSubscriptionV1 = ReturnType<typeof GithubViewerSubscriptionV1Schema.parse>;

/** Narrow, on-demand facts for issue notification and repository-pin controls. */
export const GithubIssueFactsInputV1Schema = defineProtocolObject(exactEntryInput, { policy: 'closed' });
export type GithubIssueFactsInputV1 = ReturnType<typeof GithubIssueFactsInputV1Schema.parse>;
export const GithubIssueFactsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('issueFacts'),
    isPinned: GithubBooleanSchema,
    viewerSubscription: GithubViewerSubscriptionV1Schema,
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubIssueFactsResultV1 = ReturnType<typeof GithubIssueFactsResultV1Schema.parse>;

const GithubOverviewCommonV1 = {
  kind: defineProtocolLiteral('overview'),
  observedAtMs: TimestampSchema,
  title: defineProtocolString().optional(),
  state: LabelSchema.optional(),
  author: LabelSchema.optional(),
  createdAtMs: TimestampSchema.optional(),
  updatedAtMs: TimestampSchema.optional(),
  /** Exact GitHub Markdown. `null` is GitHub's stated empty body. */
  body: defineProtocolString().nullable().optional(),
  webUrl: defineProtocolString({ minLength: 1 }).optional(),
  labels: defineProtocolArray(LabelSchema).optional(),
  assignees: defineProtocolArray(LabelSchema).optional(),
  propertyChoices: GithubPropertyChoicesV1Schema.optional(),
  /** `null` is the provider-stated absence of a milestone. */
  milestone: LabelSchema.nullable().optional(),
  milestoneNumber: defineProtocolNumber({ integer: true, minimum: 1 }).nullable().optional(),
  issueType: LabelSchema.nullable().optional(),
  locked: GithubBooleanSchema.optional(),
  lockReason: LabelSchema.nullable().optional(),
} as const;

const GithubRequestedReviewerV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('user'),
    subject: LabelSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('team'),
    subject: LabelSchema,
  }, { policy: 'closed' }),
]);

const GithubBranchUpdateEligibilityV1Schema = defineProtocolUnion([
  defineProtocolLiteral('behind'),
  defineProtocolLiteral('not-behind'),
  defineProtocolLiteral('unknown'),
]);


/* ------------------------------------------------------------------- timeline */

export const GithubTimelineInputV1Schema = pagedPlaneInput;
export type GithubTimelineInputV1 = ReturnType<typeof GithubTimelineInputV1Schema.parse>;

/** The projector owns the vocabulary; keep the union's required first two members typed. */
const GithubTimelineKindSchema = defineProtocolUnion([
  defineProtocolLiteral(GITHUB_TIMELINE_KINDS_V1[0]),
  defineProtocolLiteral(GITHUB_TIMELINE_KINDS_V1[1]),
  ...GITHUB_TIMELINE_KINDS_V1.slice(2).map(kind => defineProtocolLiteral(kind)),
]);

export const GithubProjectedTimelineRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  kind: GithubTimelineKindSchema,
  /**
   * GitHub's own word for this event, carried on EVERY row.
   *
   * On an `unsupported` row it is the only thing that says what happened, and
   * dropping it is what would make the timeline quietly incomplete.
   */
  rawKind: LabelSchema,
  atMs: TimestampSchema.optional(),
  actor: LabelSchema.optional(),
  summary: TextSchema.optional(),
  webUrl: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubTimelineResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('timeline'),
    rows: defineProtocolArray(GithubProjectedTimelineRowV1Schema, {
      maxItems: GITHUB_MAX_TIMELINE_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GithubBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    /** Absent when this page ends the walk. */
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubTimelineResultV1 = ReturnType<typeof GithubTimelineResultV1Schema.parse>;

/* -------------------------------------------------------------- changed files */

export const GithubChangedFilesInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  limit: PageLimitSchema,
  continuation: ContinuationSchema.optional(),
  /** Opt in to comparison evidence through the existing source Action. */
  comparison: defineProtocolLiteral(true).optional(),
  /** Read only this expanded file's evidence from its already-known page. */
  filePath: PathSchema.optional(),
}, { policy: 'closed' });
export type GithubChangedFilesInputV1 = ReturnType<typeof GithubChangedFilesInputV1Schema.parse>;

const GithubPatchEvidenceV1Schema = defineProtocolUnion([
  defineProtocolObject({ state: defineProtocolLiteral('available'), patch: defineProtocolString() }, { policy: 'closed' }),
  defineProtocolObject({
    state: defineProtocolLiteral('unavailable'),
    reason: defineProtocolUnion([defineProtocolLiteral('provider_patch_missing'), defineProtocolLiteral('transport_limit')]),
  }, { policy: 'closed' }),
  defineProtocolObject({
    state: defineProtocolLiteral('truncated'),
    patch: defineProtocolString(),
    reason: defineProtocolLiteral('provider_patch_truncated'),
  }, { policy: 'closed' }),
]);
export type GithubPatchEvidenceV1 = ReturnType<typeof GithubPatchEvidenceV1Schema.parse>;

export const GithubComparisonEvidenceV1Schema = defineProtocolObject({
  url: LocationSchema.optional(),
  title: defineProtocolString({ minLength: 1 }).optional(),
  locator: defineProtocolObject({
    providerId: defineProtocolLiteral('github'),
    repository: defineProtocolString({ minLength: 1 }),
    number: defineProtocolNumber({ integer: true, minimum: 1 }),
  }, { policy: 'closed' }),
  beforeOid: IdentifierSchema,
  /** Base tip is a freshness witness; beforeOid attests the patch's actual merge base. */
  baseOid: IdentifierSchema,
  headOid: IdentifierSchema,
  totalFileCount: CountSchema,
  enumeratedFileCount: CountSchema,
  freshness: defineProtocolUnion([defineProtocolLiteral('current'), defineProtocolLiteral('stale'), defineProtocolLiteral('unverified')]),
  inventory: defineProtocolUnion([defineProtocolLiteral('complete'), defineProtocolLiteral('incomplete')]),
  content: defineProtocolUnion([defineProtocolLiteral('complete'), defineProtocolLiteral('incomplete')]),
  reasons: defineProtocolArray(defineProtocolString({ minLength: 1 })),
  failure: TriageSourceFailureV1Schema.optional(),
}, { policy: 'closed' });
export type GithubComparisonEvidenceV1 = ReturnType<typeof GithubComparisonEvidenceV1Schema.parse>;

/** Correlation only; the configured Account and repository are read again on every invocation. */
export const GithubComparisonContinuationV1Schema = defineProtocolObject({
  binding: defineProtocolString({ minLength: 1 }),
  beforeOid: IdentifierSchema,
  baseOid: IdentifierSchema,
  headOid: IdentifierSchema,
  totalFileCount: CountSchema,
  enumeratedFileCount: CountSchema,
  inventoryIncomplete: GithubBooleanSchema,
  contentIncomplete: GithubBooleanSchema,
}, { policy: 'closed' });
export type GithubComparisonContinuationV1 = ReturnType<typeof GithubComparisonContinuationV1Schema.parse>;

export const GithubProjectedChangedFileRowV1Schema = defineProtocolObject({
  path: PathSchema,
  previousPath: PathSchema.optional(),
  status: LabelSchema,
  additions: CountSchema,
  deletions: CountSchema,
  changes: CountSchema,
  blobSha: IdentifierSchema.optional(),
  webUrl: LocationSchema.optional(),
  /** Display availability is not proof of complete comparison content. */
  diffAvailable: GithubBooleanSchema,
  evidence: GithubPatchEvidenceV1Schema.optional(),
  /** Source-native patch evidence used only by the deterministic Files ordering owner. */
  importSpecifiers: defineProtocolArray(PathSchema).optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubChangedFilesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('changedFiles'),
    rows: defineProtocolArray(GithubProjectedChangedFileRowV1Schema, {
      maxItems: GITHUB_MAX_CHANGED_FILE_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GithubBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
    comparison: GithubComparisonEvidenceV1Schema.optional(),
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubChangedFilesResultV1 = ReturnType<typeof GithubChangedFilesResultV1Schema.parse>;

/* ------------------------------------------------------------------- feedback */

const feedbackInputBase = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  cursor: ContinuationSchema.optional(),
};

export const GithubFeedbackInputV1Schema = defineProtocolUnion([
  defineProtocolObject({
    ...feedbackInputBase,
    connection: defineProtocolUnion([
      defineProtocolLiteral('comments'),
      defineProtocolLiteral('threads'),
      defineProtocolLiteral('reviews'),
      defineProtocolLiteral('requests'),
    ]),
  }, { policy: 'closed' }),
  defineProtocolObject({
    ...feedbackInputBase,
    connection: defineProtocolLiteral('threadReplies'),
    threadId: IdentifierSchema,
  }, { policy: 'closed' }),
]);
export type GithubFeedbackInputV1 = ReturnType<typeof GithubFeedbackInputV1Schema.parse>;

export const GithubFeedbackCommentV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  body: CommentBodySchema,
  createdAtMs: TimestampSchema.optional(),
  url: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
  /** GitHub's own `viewerCanUpdate`: this viewer may edit the body. */
  editable: defineProtocolLiteral(true).optional(),
  suggestions: defineProtocolArray(ScmSuggestionV1ProtocolSchema).optional(),
}, { policy: 'closed' });

export const GithubFeedbackThreadV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  isResolved: GithubBooleanSchema,
  path: PathSchema.optional(),
  line: CountSchema.optional(),
  firstReply: GithubFeedbackCommentV1Schema.optional(),
  replyCount: CountSchema,
  replies: defineProtocolArray(GithubFeedbackCommentV1Schema, {
    maxItems: GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1,
  }),
  previousRepliesCursor: ContinuationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubFeedbackReviewV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  body: CommentBodySchema,
  state: LabelSchema,
  submittedAtMs: TimestampSchema.optional(),
  commitRevision: defineProtocolString({ minLength: 1 }).optional(),
  url: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
  editable: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubFeedbackRequestV1Schema = defineProtocolObject({
  kind: defineProtocolUnion([
    defineProtocolLiteral('user'),
    defineProtocolLiteral('team'),
  ]),
  subject: LabelSchema,
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

const feedbackPageEvidenceShape = {
  omittedRowCount: CountSchema,
  projectionTruncated: GithubBooleanSchema,
  /** The provider cursor alone exceeded the canonical external Action envelope. */
  incomplete: defineProtocolLiteral('continuationUnavailable').optional(),
} as const;

export const GithubFeedbackResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('comments'),
    rows: defineProtocolArray(GithubFeedbackCommentV1Schema, {
      maxItems: GITHUB_ISSUE_FEEDBACK_COMMENT_PAGE_SIZE_V1,
    }),
    previousCursor: ContinuationSchema.optional(),
    ...feedbackPageEvidenceShape,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('threads'),
    rows: defineProtocolArray(GithubFeedbackThreadV1Schema, {
      maxItems: GITHUB_FEEDBACK_THREAD_PAGE_SIZE_V1,
    }),
    previousCursor: ContinuationSchema.optional(),
    ...feedbackPageEvidenceShape,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('reviews'),
    rows: defineProtocolArray(GithubFeedbackReviewV1Schema, {
      maxItems: GITHUB_FEEDBACK_REVIEW_PAGE_SIZE_V1,
    }),
    reviewDecision: ReviewDecisionSchema.optional(),
    previousCursor: ContinuationSchema.optional(),
    ...feedbackPageEvidenceShape,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('requests'),
    rows: defineProtocolArray(GithubFeedbackRequestV1Schema, {
      maxItems: GITHUB_FEEDBACK_REQUEST_PAGE_SIZE_V1,
    }),
    nextCursor: ContinuationSchema.optional(),
    ...feedbackPageEvidenceShape,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('threadReplies'),
    threadId: IdentifierSchema,
    rows: defineProtocolArray(GithubFeedbackCommentV1Schema, {
      maxItems: GITHUB_FEEDBACK_REPLY_PAGE_SIZE_V1,
    }),
    previousCursor: ContinuationSchema.optional(),
    ...feedbackPageEvidenceShape,
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubFeedbackResultV1 = ReturnType<typeof GithubFeedbackResultV1Schema.parse>;

/* --------------------------------------------------------------------- checks */

/**
 * The checks read carries no paging position of its own: `checks.ts` walks both
 * provider collections inside one invocation, because a rollup computed over
 * half a suite would be a wrong answer rather than a partial one.
 */
export const GithubChecksInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });
export type GithubChecksInputV1 = ReturnType<typeof GithubChecksInputV1Schema.parse>;

export const GithubProjectedCheckRowV1Schema = defineProtocolObject({
  key: IdentifierSchema,
  resourceKind: defineProtocolUnion([
    defineProtocolLiteral('check-run'),
    defineProtocolLiteral('commit-status'),
  ]),
  name: LabelSchema,
  status: LabelSchema,
  conclusion: LabelSchema.optional(),
  detailsUrl: LocationSchema.optional(),
  startedAtMs: TimestampSchema.optional(),
  completedAtMs: TimestampSchema.optional(),
  logExcerpt: CommentBodySchema.optional(),
  annotationsCount: defineProtocolNumber({ integer: true, minimum: 0 }).optional(),
  actions: defineProtocolObject({ selection: ForgeCiSelectionV1Schema, checkRunId: IdentifierSchema, headSha: IdentifierSchema }, { policy: 'closed' }).optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

/**
 * `none`, `unknown` and `knownIncomplete` are DIFFERENT answers and never render
 * alike: the first is "nothing to run", the second is "we could not tell", and
 * the third is "these rows are real but the list is short".
 */
const ChecksStateSchema = defineProtocolUnion([
  defineProtocolLiteral(GITHUB_CHECKS_STATES_V1[0]),
  defineProtocolLiteral(GITHUB_CHECKS_STATES_V1[1]),
  ...GITHUB_CHECKS_STATES_V1.slice(2).map(state => defineProtocolLiteral(state)),
]);

/**
 * The row-fact state this suite projects to, published rather than recomputed.
 *
 * `checks.ts` already derives it from every observation it read, and the detail
 * surface needs exactly that answer to say what GitHub reports as wrong. Deriving
 * it a second time from the listed rows would answer over a bounded list while
 * the counts were computed over the whole suite.
 */
const ChecksRowStateSchema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('allPassing'),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('running'),
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('failing'),
    failingCount: CountSchema,
  }, { policy: 'closed' }),
]);

/** One pull request's checks at one head: the Checks Action's answer and the Overview's. */
const GithubChecksViewV1Fields = {
    /**
     * Omitted when this surface cannot answer: no checks at all, or a read that
     * failed. An omitted state is never rendered as a passing one.
     */
    rowState: ChecksRowStateSchema.optional(),
    /** The commit the two reads were issued against, with no synthesis. */
    headRevision: IdentifierSchema,
    state: ChecksStateSchema,
    rows: defineProtocolArray(GithubProjectedCheckRowV1Schema),
    /**
     * Counts are OMITTED, never zero, where a per-job breakdown is unavailable.
     * A rendered `0 failing` on a suite nobody could read is a fabricated fact.
     */
    failingCount: CountSchema.optional(),
    runningCount: CountSchema.optional(),
    passingCount: CountSchema.optional(),
    /** Present when the check-run read failed; the commit-status rows still render. */
    checkRunsFailure: TriageSourceFailureV1Schema.optional(),
    /** Present when the commit-status read failed; the check-run rows still render. */
    commitStatusFailure: TriageSourceFailureV1Schema.optional(),
    omittedRowCount: CountSchema,
    projectionTruncated: GithubBooleanSchema,
} as const;
export const GithubChecksViewV1Schema = defineProtocolObject(GithubChecksViewV1Fields, { policy: 'closed' });

export const GithubChecksResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('checks'),
    ...GithubChecksViewV1Fields,
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubChecksResultV1 = ReturnType<typeof GithubChecksResultV1Schema.parse>;

export const GithubOverviewResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    ...GithubOverviewCommonV1,
    kindId: defineProtocolLiteral('pull-request'),
    viewerSubscription: GithubViewerSubscriptionV1Schema.optional(),
    draft: GithubBooleanSchema.optional(),
    merged: GithubBooleanSchema.optional(),
    /** Native conflict test, not authorization to merge. Null means unknown/computing. */
    mergeable: GithubBooleanSchema.nullable().optional(),
    mergeableState: LabelSchema.nullable().optional(),
    /** The existing status owner, acquired once alongside this exact PR read. */
    pullRequestStatus: TriagePullRequestStatusV1Schema.optional(),
    /** Present only when the same summary supplied every repository capability fact. */
    capabilities: GithubCapabilitiesValueV1Schema.optional(),
    /** The detail's checks, from the same head-qualified rollup read as `pullRequestStatus`. */
    checks: GithubChecksViewV1Schema.optional(),
    requiredChecks: defineProtocolObject({
      state: defineProtocolUnion([
        defineProtocolLiteral(GITHUB_CHECKS_CONDITION_STATES_V1[0]),
        defineProtocolLiteral(GITHUB_CHECKS_CONDITION_STATES_V1[1]),
        ...GITHUB_CHECKS_CONDITION_STATES_V1.slice(2).map(state => defineProtocolLiteral(state)),
      ]),
      failingCount: CountSchema.nullable(),
      pendingCount: CountSchema.nullable(),
    }, { policy: 'closed' }).optional(),
    reviewDecision: ReviewDecisionSchema.nullable().optional(),
    headBranch: LabelSchema.optional(),
    baseBranch: LabelSchema.optional(),
    requestedReviewers: defineProtocolArray(GithubRequestedReviewerV1Schema).optional(),
    headRevision: IdentifierSchema.optional(),
    /** Base tip from the same exact PR read as headRevision. */
    baseRevision: IdentifierSchema.optional(),
    additions: CountSchema.optional(),
    deletions: CountSchema.optional(),
    /** GitHub's own count of changed files in the whole pull request (`changed_files`). */
    changedFiles: CountSchema.optional(),
    branchUpdateEligibility: GithubBranchUpdateEligibilityV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    ...GithubOverviewCommonV1,
    kindId: defineProtocolLiteral('issue'),
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubOverviewResultV1 = ReturnType<typeof GithubOverviewResultV1Schema.parse>;

/** Transient exact issue-read data for the mounted source detail, never a corpus row. */
export const GithubIssueOpeningDetailV1Schema = defineProtocolObject({
  overview: GithubOverviewResultV1Schema,
  capabilities: GithubCapabilitiesResultV1Schema,
}, { policy: 'closed' });
export type GithubIssueOpeningDetailV1 = ReturnType<typeof GithubIssueOpeningDetailV1Schema.parse>;
