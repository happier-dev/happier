import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import {
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  TriageConfiguredSourceInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
  TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import {
  AZURE_DETAIL_BOUNDS_V1,
} from './projection.js';

/**
 * The five source-native Azure DevOps detail Action contracts.
 *
 * The detail body runs in a UI artifact that holds no credential and speaks no
 * HTTP, while `client.ts` is this source's sole credential reader. The bridge
 * between them is these Actions, declared with the same public schema builders
 * the shared Triage contract uses.
 *
 * Their shapes follow Azure's own resources rather than a shared paging idiom,
 * because Azure's resources genuinely differ from the other three forges':
 * commits hand back a continuation token in a response HEADER, iteration changes
 * hand back `nextSkip`/`nextTop` in the BODY, and the thread list hands back
 * everything at once with no cursor at all. Flattening those into one page shape
 * would require inventing the two positions Azure does not issue.
 */

const AzureBooleanSchema = defineProtocolUnion([
  defineProtocolLiteral(true),
  defineProtocolLiteral(false),
]);

const IdentifierSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.identifierUtf8Bytes,
  minLength: 1,
});
const LabelSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const TextSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.textUtf8Bytes,
  minLength: 1,
});
const PathSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
const LocationSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.locationUtf8Bytes,
  minLength: 1,
});
/** A comment body may be empty: an attachment-only comment is still a comment. */
const CommentBodySchema = defineProtocolString();
/** A commit comment may be empty; Azure accepts an empty commit message. */
const CommitMessageSchema = defineProtocolUtf8String({
  maxUtf8Bytes: AZURE_DETAIL_BOUNDS_V1.textUtf8Bytes,
});
const TimestampSchema = defineProtocolNumber({ integer: true });
const CountSchema = defineProtocolNumber({ integer: true, minimum: 0 });
/** A real 1-based iteration. `0` is the comparison baseline, never a resource. */
const IterationIdSchema = defineProtocolNumber({ integer: true, minimum: 1 });

const RoutingTokenSchema = defineProtocolUtf8String({
  maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  minLength: 1,
});
/** Azure's own continuation token, carried verbatim and never constructed. */
const ContinuationTokenSchema = defineProtocolString({ minLength: 1 });

const entryInput = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
}, { policy: 'closed' });

const AzureDetailUnavailableSchema = defineProtocolObject({
  kind: defineProtocolLiteral('unavailable'),
  failure: TriageSourceFailureV1Schema,
}, { policy: 'closed' });

/* ---------------------------------------------------------------- iterations */

export const AzureIterationsInputV1Schema = entryInput;
export type AzureIterationsInputV1 = ReturnType<typeof AzureIterationsInputV1Schema.parse>;

export const AzureProjectedIterationRowV1Schema = defineProtocolObject({
  id: IterationIdSchema,
  description: TextSchema.optional(),
  createdAtMs: TimestampSchema.optional(),
  author: LabelSchema.optional(),
  /** Azure's own reason for this iteration; a push label is shown only from it. */
  reason: LabelSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzureIterationsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('iterations'),
    rows: defineProtocolArray(AzureProjectedIterationRowV1Schema),
    /**
     * The real 1-based iteration `Files` compares against.
     *
     * ABSENT when Azure returned no iteration. It is never `0`: `0` is the
     * documented `compareTo` baseline, and publishing it here would invite a
     * caller to path-address a resource that does not exist.
     */
    currentIterationId: IterationIdSchema.optional(),
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  AzureDetailUnavailableSchema,
]);
export type AzureIterationsResultV1 = ReturnType<typeof AzureIterationsResultV1Schema.parse>;

/* ------------------------------------------------------------------- commits */

export const AzureCommitsInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /** Present only for a following page, and only as Azure issued it. */
  continuationToken: ContinuationTokenSchema.optional(),
}, { policy: 'closed' });
export type AzureCommitsInputV1 = ReturnType<typeof AzureCommitsInputV1Schema.parse>;

export const AzureProjectedCommitRowV1Schema = defineProtocolObject({
  commitId: IdentifierSchema,
  comment: CommitMessageSchema,
  author: LabelSchema.optional(),
  authoredAtMs: TimestampSchema.optional(),
  url: LocationSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzureCommitsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('commits'),
    rows: defineProtocolArray(AzureProjectedCommitRowV1Schema),
    /** Absent when Azure issued no continuation token for this response. */
    continuationToken: ContinuationTokenSchema.optional(),
    /** Present only when an issued provider continuation could not cross the Action envelope. */
    incomplete: defineProtocolLiteral('continuationUnavailable').optional(),
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  AzureDetailUnavailableSchema,
]);
export type AzureCommitsResultV1 = ReturnType<typeof AzureCommitsResultV1Schema.parse>;

/* --------------------------------------------------------- iteration changes */

const azureIterationChangesInputShape = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /**
   * The real iteration the detail root selected. It is an input rather than a
   * second read: one iteration owner per mounted body, and both consuming tabs
   * see the same snapshot.
   */
  iterationId: IterationIdSchema,
} as const;

export const AzureIterationChangesInputV1Schema = defineProtocolUnion([
  defineProtocolObject(azureIterationChangesInputShape, { policy: 'closed' }),
  defineProtocolObject({
    ...azureIterationChangesInputShape,
    /** Both are provider-issued. A half-position is invalid, not completed locally. */
    skip: CountSchema,
    top: CountSchema,
  }, { policy: 'closed' }),
]);
export type AzureIterationChangesInputV1 = ReturnType<
  typeof AzureIterationChangesInputV1Schema.parse
>;

export const AzureProjectedChangedFileRowV1Schema = defineProtocolObject({
  path: PathSchema,
  changeType: LabelSchema,
  objectId: IdentifierSchema.optional(),
  isFolder: AzureBooleanSchema,
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzureIterationChangesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('iterationChanges'),
    iterationId: IterationIdSchema,
    rows: defineProtocolArray(AzureProjectedChangedFileRowV1Schema),
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('iterationChanges'),
    iterationId: IterationIdSchema,
    rows: defineProtocolArray(AzureProjectedChangedFileRowV1Schema),
    /**
     * The next window, exactly as Azure issued it. Both are present together or
     * absent together: a caller that received one and computed the other would
     * silently re-read or skip files.
     */
    nextSkip: CountSchema,
    nextTop: CountSchema,
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  AzureDetailUnavailableSchema,
]);
export type AzureIterationChangesResultV1 = ReturnType<
  typeof AzureIterationChangesResultV1Schema.parse
>;

/* ------------------------------------------------------------------ policies */

export const AzurePoliciesInputV1Schema = entryInput;
export type AzurePoliciesInputV1 = ReturnType<typeof AzurePoliciesInputV1Schema.parse>;

export const AzureProjectedStatusRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  state: LabelSchema,
  description: TextSchema.optional(),
  contextName: LabelSchema.optional(),
  targetUrl: LocationSchema.optional(),
  createdAtMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzureProjectedPolicyEvaluationRowV1Schema = defineProtocolObject({
  evaluationId: IdentifierSchema,
  status: LabelSchema,
  displayName: LabelSchema.optional(),
  /** From `configuration.isBlocking` only. A status never establishes this. */
  isBlocking: AzureBooleanSchema,
  /** From the documented configuration type id only, never display text. */
  isBuildValidation: AzureBooleanSchema,
  /** Absent means unknown. It is never rendered as a zero duration. */
  startedAtMs: TimestampSchema.optional(),
  completedAtMs: TimestampSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzurePoliciesResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('policies'),
    statuses: defineProtocolArray(AzureProjectedStatusRowV1Schema),
    evaluations: defineProtocolArray(AzureProjectedPolicyEvaluationRowV1Schema),
    /**
     * True when the evaluation read failed after the statuses succeeded. Only
     * that half is short; the statuses are real and stay.
     */
    evaluationsPartial: AzureBooleanSchema,
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  AzureDetailUnavailableSchema,
]);
export type AzurePoliciesResultV1 = ReturnType<typeof AzurePoliciesResultV1Schema.parse>;

/* ------------------------------------------------------------------- threads */

export const AzureThreadsInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
  routingToken: RoutingTokenSchema,
  /**
   * The optional iteration comparison lens. Both halves travel together because
   * a lens IS a comparison; one alone is not a narrower query, it is a broken
   * one.
   */
  iteration: IterationIdSchema.optional(),
  baseIteration: CountSchema.optional(),
}, { policy: 'closed' });
export type AzureThreadsInputV1 = ReturnType<typeof AzureThreadsInputV1Schema.parse>;

export const AzureProjectedThreadCommentV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  author: LabelSchema.optional(),
  content: CommentBodySchema,
  publishedAtMs: TimestampSchema.optional(),
  commentType: LabelSchema.optional(),
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

export const AzureProjectedThreadRowV1Schema = defineProtocolObject({
  id: IdentifierSchema,
  status: LabelSchema.optional(),
  /** Absent on an unanchored remark, which is kept rather than dropped. */
  path: PathSchema.optional(),
  rightFileStartLine: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
  // Azure embeds the finite comment array in the one thread response and publishes no
  // per-thread cursor or documented count ceiling. Per-comment fields stay strictly bounded;
  // the Action value boundary, not a source-invented row count, owns aggregate admission.
  comments: defineProtocolArray(AzureProjectedThreadCommentV1Schema),
  omittedCommentCount: CountSchema,
  truncated: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });

/**
 * The whole returned thread list, in one result.
 *
 * There is no continuation member because the documented endpoint publishes no
 * cursor: it returns every thread. The reader's 18-thread and 2-reply windows
 * are client-local over this response, and a cursor here would be pagination
 * this product invented.
 */
export const AzureThreadsResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('threads'),
    rows: defineProtocolArray(AzureProjectedThreadRowV1Schema),
    omittedRowCount: CountSchema,
    projectionTruncated: AzureBooleanSchema,
  }, { policy: 'closed' }),
  AzureDetailUnavailableSchema,
]);
export type AzureThreadsResultV1 = ReturnType<typeof AzureThreadsResultV1Schema.parse>;
