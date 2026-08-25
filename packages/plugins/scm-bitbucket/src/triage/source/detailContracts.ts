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
  TriageGetResultV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { MAX_BITBUCKET_DETAIL_CONTINUATION_UTF8_BYTES_V1 } from './detailContinuation.js';
import {
  BITBUCKET_DETAIL_BOUNDS_V1,
  BITBUCKET_MAX_DETAIL_ROWS_V1,
} from '../detail/projection.js';

/** The real aggregate Action-value gate; the result itself is the measured value. */
export const BITBUCKET_ACTION_RESULT_JSON_BYTE_LIMIT_V1 = 1_024 * 1_024;

/**
 * The five source-native Bitbucket Cloud detail Action contracts.
 *
 * The detail body runs in a UI artifact that holds no credential and speaks no
 * HTTP, while `apiClient.ts` is this source's sole credential reader. The bridge
 * between them is these Actions, declared with the same public schema builders
 * the shared Triage contract uses. They carry no Triage role: an activity entry,
 * a build status and a comment are Bitbucket-native content this source's own
 * detail body reads, not Triage entries the aggregate may hold.
 *
 * Each result object is `closed`, which is what makes an accidentally widened
 * projection a failure instead of a leak. Every published bound is the exact
 * value the boundary projector applies.
 */

const BitbucketBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
/** A presentation list key, which may be longer than a provider identifier. */
const RowKeySchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.labelUtf8Bytes,
  minLength: 1,
});
const TextSchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
/** A comment body may be empty: an attachment-only comment is still a comment. */
const CommentBodySchema = defineProtocolUtf8String({
  maxUtf8Bytes: BITBUCKET_DETAIL_BOUNDS_V1.commentBodyUtf8Bytes,
});
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});
const ContinuationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_BITBUCKET_DETAIL_CONTINUATION_UTF8_BYTES_V1,
  minLength: 1,
});

const pagedPlaneInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /** Present only for a following page, and only as this source minted it. */
  continuation: ContinuationSchema.optional(),
}, { policy: 'closed' });

const unpagedPlaneInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });

const BitbucketDetailUnavailableSchema = defineProtocolObject({
  kind: defineProtocolLiteral('unavailable'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/* ------------------------------------------------------------------ activity */

export const BitbucketActivityInputV1Schema = pagedPlaneInput;
export type BitbucketActivityInputV1 = ReturnType<typeof BitbucketActivityInputV1Schema.parse>;

const ActivityKindSchema = defineProtocolUnion([
  defineProtocolLiteral('approval'),
  defineProtocolLiteral('changesRequested'),
  defineProtocolLiteral('update'),
  defineProtocolLiteral('comment'),
  defineProtocolLiteral('unsupported'),
]);

export const BitbucketProjectedActivityRowV1Schema = defineProtocolObject({
  /** A presentation list key. Bitbucket's activity entries carry no id of their own. */
  key: RowKeySchema,
  kind: ActivityKindSchema,
  /**
   * Bitbucket's own word for this entry, carried on EVERY row.
   *
   * On an `unsupported` row it is the only thing that says what happened, and
   * dropping it is what would make the activity stream quietly incomplete.
   */
  rawKind: LabelSchema,
  actor: LabelSchema.optional(),
  atMs: TimestampSchema.optional(),
  summary: CommentBodySchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const BitbucketActivityResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('activity'),
    rows: defineProtocolArray(BitbucketProjectedActivityRowV1Schema, {
      maxItems: BITBUCKET_MAX_DETAIL_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: BitbucketBooleanSchema,
    /** Absent when this page ends the collection. */
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  BitbucketDetailUnavailableSchema,
]);
export type BitbucketActivityResultV1 = ReturnType<typeof BitbucketActivityResultV1Schema.parse>;

/* -------------------------------------------------------------------- builds */

export const BitbucketBuildsInputV1Schema = pagedPlaneInput;
export type BitbucketBuildsInputV1 = ReturnType<typeof BitbucketBuildsInputV1Schema.parse>;

export const BitbucketProjectedStatusRowV1Schema = defineProtocolObject({
  key: IdentifierSchema,
  name: LabelSchema,
  state: LabelSchema,
  description: TextSchema.optional(),
  url: LocationSchema.optional(),
  createdAtMs: TimestampSchema.optional(),
  updatedAtMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const BitbucketBuildsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('builds'),
    rows: defineProtocolArray(BitbucketProjectedStatusRowV1Schema, {
      maxItems: BITBUCKET_MAX_DETAIL_ROWS_V1,
    }),
    /**
     * Every count is OMITTED, never zero, unless this page is the WHOLE status
     * collection. Three counts over the statuses that happened to fit one page
     * is a wrong answer a reader would act on, not a partial one.
     */
    failingCount: CountSchema.optional(),
    runningCount: CountSchema.optional(),
    passingCount: CountSchema.optional(),
    omittedRowCount: CountSchema,
    projectionTruncated: BitbucketBooleanSchema,
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  BitbucketDetailUnavailableSchema,
]);
export type BitbucketBuildsResultV1 = ReturnType<typeof BitbucketBuildsResultV1Schema.parse>;

/* ------------------------------------------------------------------ comments */

export const BitbucketCommentsInputV1Schema = pagedPlaneInput;
export type BitbucketCommentsInputV1 = ReturnType<typeof BitbucketCommentsInputV1Schema.parse>;

/**
 * A genuine tri-state. `unknown` is what a response that omitted the field said,
 * and it is a different answer from `unresolved` — conflating them tells a
 * reviewer their resolved thread is still open.
 *
 * It is exported because the resolve and reopen writes settle into this exact
 * vocabulary: the answer a write returns and the answer the Comments panel
 * renders are the same fact about the same comment, and two spellings of it
 * would be two answers to "is this thread resolved".
 */
export const BitbucketCommentResolutionV1Schema = defineProtocolUnion([
  defineProtocolLiteral('resolved'),
  defineProtocolLiteral('unresolved'),
  defineProtocolLiteral('unknown'),
]);

export const BitbucketProjectedCommentRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  body: CommentBodySchema,
  atMs: TimestampSchema.optional(),
  editedAtMs: TimestampSchema.optional(),
  /** The comment this one replies to; its absence makes this a thread root. */
  parentId: IdentifierSchema.optional(),
  deleted: BitbucketBooleanSchema,
  resolution: BitbucketCommentResolutionV1Schema,
  path: TextSchema.optional(),
  url: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const BitbucketCommentsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('comments'),
    rows: defineProtocolArray(BitbucketProjectedCommentRowV1Schema, {
      maxItems: BITBUCKET_MAX_DETAIL_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: BitbucketBooleanSchema,
    continuation: ContinuationSchema.optional(),
  }, { policy: 'closed' }),
  BitbucketDetailUnavailableSchema,
]);
export type BitbucketCommentsResultV1 = ReturnType<typeof BitbucketCommentsResultV1Schema.parse>;

/* ------------------------------------------------------------------ overview */

export const BitbucketOverviewInputV1Schema = unpagedPlaneInput;
export const BitbucketOverviewResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('overview'),
    observedAtMs: TimestampSchema,
    observation: TriageGetResultV1Schema,
  }, { policy: 'closed' }),
  BitbucketDetailUnavailableSchema,
]);
export type BitbucketOverviewResultV1 = ReturnType<typeof BitbucketOverviewResultV1Schema.parse>;

/* ---------------------------------------------------------------------- diff */

export const BitbucketDiffInputV1Schema = pagedPlaneInput;
export const BitbucketProjectedDiffstatRowV1Schema = defineProtocolObject({
  path: TextSchema,
  status: LabelSchema,
  linesAdded: CountSchema,
  linesRemoved: CountSchema,
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

const BitbucketRawDiffV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('available'),
    text: defineProtocolUtf8String({ maxUtf8Bytes: BITBUCKET_ACTION_RESULT_JSON_BYTE_LIMIT_V1 }),
    truncated: BitbucketBooleanSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('tooLarge') }, { policy: 'closed' }),
]);

export const BitbucketDiffResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('diff'),
    files: defineProtocolArray(BitbucketProjectedDiffstatRowV1Schema, {
      maxItems: BITBUCKET_MAX_DETAIL_ROWS_V1,
    }),
    omittedRowCount: CountSchema,
    projectionTruncated: BitbucketBooleanSchema,
    continuation: ContinuationSchema.optional(),
    /** Present on the first page only; later diffstat pages do not re-fetch the raw body. */
    raw: BitbucketRawDiffV1Schema.optional(),
  }, { policy: 'closed' }),
  BitbucketDetailUnavailableSchema,
]);
export type BitbucketDiffResultV1 = ReturnType<typeof BitbucketDiffResultV1Schema.parse>;
