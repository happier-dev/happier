import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { MAX_GITHUB_DETAIL_CONTINUATION_UTF8_BYTES_V1 } from './continuation.js';
import {
  GITHUB_DETAIL_BOUNDS_V1,
  GITHUB_MAX_CHANGED_FILE_ROWS_V1,
  GITHUB_MAX_CHECK_ROWS_V1,
  GITHUB_MAX_COMMENT_ROWS_V1,
  GITHUB_MAX_TIMELINE_ROWS_V1,
} from './projection.js';
import { GITHUB_MAX_DETAIL_PAGE_SIZE_V1 } from './routes.js';

/**
 * The four source-native detail Action contracts.
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
const LabelSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.labelUtf8Bytes,
  minLength: 1,
});
const TextSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const PathSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.pathUtf8Bytes,
  minLength: 1,
});
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
/**
 * A comment body may be empty: GitHub accepts a comment whose content is only an
 * attachment, and such a comment is still a real event in the conversation.
 */
const CommentBodySchema = defineProtocolUtf8String({
  maxUtf8Bytes: GITHUB_DETAIL_BOUNDS_V1.commentBodyUtf8Bytes,
});
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});

const ContinuationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_GITHUB_DETAIL_CONTINUATION_UTF8_BYTES_V1,
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

/* ------------------------------------------------------------------- timeline */

export const GithubTimelineInputV1Schema = pagedPlaneInput;
export type GithubTimelineInputV1 = ReturnType<typeof GithubTimelineInputV1Schema.parse>;

/**
 * The published timeline vocabulary, enumerated rather than derived.
 *
 * The projector's `GITHUB_TIMELINE_KINDS_V1` is the runtime owner of the same
 * list; enumerating the arms here keeps the schema honestly typed without a cast
 * that would let a widened projection through, and `contracts.test.ts` pins the
 * two lists equal so neither can gain an arm alone.
 */
const GithubTimelineKindSchema = defineProtocolUnion([
  defineProtocolLiteral('commented'),
  defineProtocolLiteral('committed'),
  defineProtocolLiteral('forcePushed'),
  defineProtocolLiteral('baseChanged'),
  defineProtocolLiteral('reviewed'),
  defineProtocolLiteral('reviewRequested'),
  defineProtocolLiteral('reviewRequestRemoved'),
  defineProtocolLiteral('merged'),
  defineProtocolLiteral('closed'),
  defineProtocolLiteral('reopened'),
  defineProtocolLiteral('labeled'),
  defineProtocolLiteral('unlabeled'),
  defineProtocolLiteral('assigned'),
  defineProtocolLiteral('unassigned'),
  defineProtocolLiteral('milestoned'),
  defineProtocolLiteral('demilestoned'),
  defineProtocolLiteral('renamed'),
  defineProtocolLiteral('referenced'),
  defineProtocolLiteral('crossReferenced'),
  defineProtocolLiteral('unsupported'),
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

export const GithubChangedFilesInputV1Schema = pagedPlaneInput;
export type GithubChangedFilesInputV1 = ReturnType<typeof GithubChangedFilesInputV1Schema.parse>;

export const GithubProjectedChangedFileRowV1Schema = defineProtocolObject({
  path: PathSchema,
  previousPath: PathSchema.optional(),
  status: LabelSchema,
  additions: CountSchema,
  deletions: CountSchema,
  changes: CountSchema,
  blobSha: IdentifierSchema.optional(),
  webUrl: LocationSchema.optional(),
  /**
   * Whether GitHub supplied a patch for this file. The patch itself is never
   * published: the rich diff body is held under B6, and a changed-file list that
   * shipped diff bytes to a surface with no renderer for them would be paying
   * the cost of a feature that does not exist yet.
   */
  diffAvailable: GithubBooleanSchema,
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
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubChangedFilesResultV1 = ReturnType<typeof GithubChangedFilesResultV1Schema.parse>;

/* ------------------------------------------------------------------- comments */

export const GithubCommentsInputV1Schema = pagedPlaneInput;
export type GithubCommentsInputV1 = ReturnType<typeof GithubCommentsInputV1Schema.parse>;

export const GithubProjectedCommentRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  body: CommentBodySchema,
  atMs: TimestampSchema.optional(),
  editedAtMs: TimestampSchema.optional(),
  webUrl: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const GithubCommentsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('comments'),
    rows: defineProtocolArray(GithubProjectedCommentRowV1Schema, {
      maxItems: GITHUB_MAX_COMMENT_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: GithubBooleanSchema,
    incomplete: IncompleteReasonSchema.optional(),
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubCommentsResultV1 = ReturnType<typeof GithubCommentsResultV1Schema.parse>;

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
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

/**
 * `none`, `unknown` and `knownIncomplete` are DIFFERENT answers and never render
 * alike: the first is "nothing to run", the second is "we could not tell", and
 * the third is "these rows are real but the list is short".
 */
const ChecksStateSchema = defineProtocolUnion([
  defineProtocolLiteral('none'),
  defineProtocolLiteral('unknown'),
  defineProtocolLiteral('knownIncomplete'),
  defineProtocolLiteral('resolved'),
]);

export const GithubChecksResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('checks'),
    /** The commit the two reads were issued against, with no synthesis. */
    headRevision: IdentifierSchema,
    state: ChecksStateSchema,
    rows: defineProtocolArray(GithubProjectedCheckRowV1Schema, {
      maxItems: GITHUB_MAX_CHECK_ROWS_V1,
    }),
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
  }, { policy: 'closed' }),
  GithubDetailUnavailableSchema,
]);
export type GithubChecksResultV1 = ReturnType<typeof GithubChecksResultV1Schema.parse>;
