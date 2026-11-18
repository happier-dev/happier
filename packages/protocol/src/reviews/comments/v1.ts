import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';

import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';
import { ReviewFindingSeveritySchema, ReviewFindingScopeAttributionSchema } from '../reviewFindingClassification.js';
import { ReviewFindingExtensionsSchema } from '../findingExtensions.js';
import { ReviewFindingIdentityV1Schema } from './findingIdentity.js';
import { ReviewTriageStatusSchema } from '../reviewTriageStatus.js';

export const ReviewCommentWorkspaceV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)),
  path: z.string().check(z.minLength(1)),
}));
export type ReviewCommentWorkspaceV1 = z.infer<typeof ReviewCommentWorkspaceV1Schema>;

export const ReviewCommentScopeV1Schema = lazyZodSchema(() => z.strictObject({
  reviewId: z.optional(z.string().check(z.minLength(1))),
  projectId: z.optional(z.string().check(z.minLength(1))),
  workspace: z.optional(ReviewCommentWorkspaceV1Schema),
}));
export type ReviewCommentScopeV1 = z.infer<typeof ReviewCommentScopeV1Schema>;

export function validateReviewCommentScopeV1(
  value: { reviewId?: string; roundOrdinal?: number; projectId?: string; workspace?: ReviewCommentWorkspaceV1 },
  ctx: z.core.$RefinementCtx,
): void {
  if (!value.reviewId && !value.projectId && !value.workspace) {
    ctx.addIssue({ code: "custom", path: ['workspace'], message: 'A Project or machine workspace is required' });
  }
  if (value.roundOrdinal !== undefined && !value.reviewId) {
    ctx.addIssue({ code: 'custom', path: ['roundOrdinal'], message: 'A round attachment requires its Review' });
  }
}

export const REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1 = 'reviews.comments.write.direct' as const;

export const ReviewCommentStateV1Schema = lazyZodSchema(() => z.enum([
  'proposed',
  'open',
  'delegated',
  'pending_review',
  'resolved',
  'dismissed',
]));
export type ReviewCommentStateV1 = z.infer<typeof ReviewCommentStateV1Schema>;

export const ReviewCommentSnapshotSourceV1Schema = lazyZodSchema(() => z.enum([
  'workingTree',
  'committed',
  'diffSide',
  'agentBuffer',
  'untracked',
]));
export type ReviewCommentSnapshotSourceV1 = z.infer<typeof ReviewCommentSnapshotSourceV1Schema>;

export const ReviewCommentActorRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('user'), userId: z.string().check(z.minLength(1)) }),
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: z.string().check(z.minLength(1)),
    engineRunId: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('agent'),
    agentId: z.string().check(z.minLength(1)),
    sessionId: z.string().check(z.minLength(1)),
  }),
  z.strictObject({ kind: z.literal('workflow'), runId: z.string().check(z.minLength(1)) }),
]));
export type ReviewCommentActorRefV1 = z.infer<typeof ReviewCommentActorRefV1Schema>;

const ReviewCommentAnchorSideV1Schema = lazyZodSchema(() => z.enum(['before', 'after']));

export const ReviewCommentAnchorV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('line'),
    filePath: z.string().check(z.minLength(1)),
    line: z.number().check(z.int(), z.minimum(1)),
    side: z.optional(ReviewCommentAnchorSideV1Schema),
  }),
  z.strictObject({
    kind: z.literal('range'),
    filePath: z.string().check(z.minLength(1)),
    startLine: z.number().check(z.int(), z.minimum(1)),
    endLine: z.number().check(z.int(), z.minimum(1)),
    side: z.optional(ReviewCommentAnchorSideV1Schema),
  }).check(z.superRefine((value, ctx) => {
    if (value.endLine < value.startLine) {
      ctx.addIssue({
        code: "custom",
        path: ['endLine'],
        message: 'endLine must be greater than or equal to startLine',
      });
    }
  })),
  z.strictObject({
    kind: z.literal('hunk'),
    filePath: z.string().check(z.minLength(1)),
    hunkId: z.string().check(z.minLength(1)),
    side: z.optional(ReviewCommentAnchorSideV1Schema),
  }),
  z.strictObject({ kind: z.literal('file'), filePath: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('folder'), folderPath: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('workspace'), workspaceId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('project'), projectId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('run'), runId: z.string().check(z.minLength(1)) }),
  z.strictObject({
    kind: z.literal('finding'),
    runId: z.string().check(z.minLength(1)),
    findingId: z.string().check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('binary'),
    filePath: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.minLength(1)),
  }),
  z.strictObject({
    kind: z.literal('submodule'),
    filePath: z.string().check(z.minLength(1)),
    commitSha: z.optional(z.string().check(z.minLength(1))),
    url: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({
    kind: z.literal('symlink'),
    filePath: z.string().check(z.minLength(1)),
    targetPath: z.string().check(z.minLength(1)),
  }),
]));
export type ReviewCommentAnchorV1 = z.infer<typeof ReviewCommentAnchorV1Schema>;

export const ReviewCommentSnapshotV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('none'), capturedAt: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({
    kind: z.literal('text'),
    selectedLines: z.array(z.string()),
    beforeContext: z.array(z.string()),
    afterContext: z.array(z.string()),
    selectedLinesHash: z.string().check(z.minLength(1)),
    contextWindowHash: z.string().check(z.minLength(1)),
    capturedAt: z.number().check(z.int(), z.nonnegative()),
    fileLength: z.number().check(z.int(), z.nonnegative()),
    source: ReviewCommentSnapshotSourceV1Schema,
    commitSha: z.optional(z.string().check(z.minLength(1))),
    isUncommitted: z.boolean(),
    isUntracked: z.boolean(),
    truncated: z.boolean(),
    truncationReason: z.optional(z.enum(['file_too_large', 'line_too_long', 'context_cap'])),
    hasBidiControls: z.boolean(),
    likelyMinified: z.boolean(),
    diffContext: z.optional(z.strictObject({
      side: ReviewCommentAnchorSideV1Schema,
      baseSha: z.optional(z.string().check(z.minLength(1))),
      headSha: z.optional(z.string().check(z.minLength(1))),
      startSha: z.optional(z.string().check(z.minLength(1))),
    })),
  }),
  z.strictObject({
    kind: z.literal('binary'),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.string().check(z.minLength(1)),
    mimeType: z.optional(z.string().check(z.minLength(1))),
    source: ReviewCommentSnapshotSourceV1Schema,
    capturedAt: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    kind: z.literal('submodule'),
    filePath: z.string().check(z.minLength(1)),
    commitSha: z.optional(z.string().check(z.minLength(1))),
    url: z.optional(z.string().check(z.minLength(1))),
    capturedAt: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    kind: z.literal('symlink'),
    filePath: z.string().check(z.minLength(1)),
    targetPath: z.string().check(z.minLength(1)),
    targetExists: z.optional(z.boolean()),
    capturedAt: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({
    kind: z.literal('too_large'),
    filePath: z.string().check(z.minLength(1)),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    sha256: z.optional(z.string().check(z.minLength(1))),
    capBytes: z.number().check(z.int(), z.positive()),
    capturedAt: z.number().check(z.int(), z.nonnegative()),
  }),
]));
export type ReviewCommentSnapshotV1 = z.infer<typeof ReviewCommentSnapshotV1Schema>;

export const ReviewCommentBodyContentV1Schema = lazyZodSchema(() => z.union([
  z.string(),
  StoredJsonContentEnvelopeSchema,
]));
export type ReviewCommentBodyContentV1 = z.infer<typeof ReviewCommentBodyContentV1Schema>;

export const ReviewCommentInputBodyContentV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.minLength(1)),
  StoredJsonContentEnvelopeSchema,
]));
export type ReviewCommentInputBodyContentV1 = z.infer<typeof ReviewCommentInputBodyContentV1Schema>;

export const ReviewCommentSnapshotContentV1Schema = lazyZodSchema(() => z.union([
  ReviewCommentSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
]));
export type ReviewCommentSnapshotContentV1 = z.infer<typeof ReviewCommentSnapshotContentV1Schema>;

export const ReviewCommentEvidenceV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('diff'), diffRef: z.string().check(z.minLength(1)), summary: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({
    kind: z.literal('test'),
    testResultRef: z.string().check(z.minLength(1)),
    status: z.enum(['passed', 'failed', 'mixed']),
    summary: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ kind: z.literal('reasoning'), message: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('external'), url: z.string().check(z.url()), label: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({ kind: z.literal('agentMessage'), sessionId: z.string().check(z.minLength(1)), messageId: z.string().check(z.minLength(1)) }),
]));
export type ReviewCommentEvidenceV1 = z.infer<typeof ReviewCommentEvidenceV1Schema>;

export const ReviewCommentEditV1Schema = lazyZodSchema(() => z.strictObject({
  editId: z.string().check(z.minLength(1)),
  editedAt: z.number().check(z.int(), z.nonnegative()),
  editedBy: ReviewCommentActorRefV1Schema,
  previousBody: ReviewCommentBodyContentV1Schema,
  nextBody: ReviewCommentInputBodyContentV1Schema,
  reason: z.optional(z.string().check(z.minLength(1))),
}));
export type ReviewCommentEditV1 = z.infer<typeof ReviewCommentEditV1Schema>;

export const ReviewCommentTombstoneV1Schema = lazyZodSchema(() => z.strictObject({
  deletedAt: z.number().check(z.int(), z.nonnegative()),
  deletedBy: ReviewCommentActorRefV1Schema,
  reason: z.optional(z.string().check(z.minLength(1))),
  redacted: z.boolean(),
}));
export type ReviewCommentTombstoneV1 = z.infer<typeof ReviewCommentTombstoneV1Schema>;

export const ReviewCommentFingerprintV1Schema = lazyZodSchema(() => z.strictObject({
  ruleId: z.optional(z.string().check(z.minLength(1))),
  fileSha: z.optional(z.string().check(z.minLength(1))),
  lineRange: z.optional(z.strictObject({
    startLine: z.number().check(z.int(), z.minimum(1)),
    endLine: z.number().check(z.int(), z.minimum(1)),
  })),
  normalizedMessageHash: z.string().check(z.minLength(1)),
  engineId: z.optional(z.string().check(z.minLength(1))),
}));
export type ReviewCommentFingerprintV1 = z.infer<typeof ReviewCommentFingerprintV1Schema>;

export const ReviewCommentDispositionV1Schema = lazyZodSchema(() => z.enum(['working', 'satisfied', 'blocking']));
export type ReviewCommentDispositionV1 = z.infer<typeof ReviewCommentDispositionV1Schema>;

export const ReviewCommentTransitionV1Schema = lazyZodSchema(() => z.strictObject({
  transitionId: z.string().check(z.minLength(1)),
  fromState: z.optional(ReviewCommentStateV1Schema),
  toState: ReviewCommentStateV1Schema,
  reviewTriageStatus: z.optional(ReviewTriageStatusSchema),
  transitionedAt: z.number().check(z.int(), z.nonnegative()),
  transitionedBy: ReviewCommentActorRefV1Schema,
  reason: z.optional(z.string().check(z.minLength(1))),
  evidence: z.optional(z.array(ReviewCommentEvidenceV1Schema)),
  bulkActionId: z.optional(z.string().check(z.minLength(1))),
  clientMutationId: z.optional(z.string().check(z.minLength(1))),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  serverRevision: z.optional(z.number().check(z.int(), z.positive())),
}));
export type ReviewCommentTransitionV1 = z.infer<typeof ReviewCommentTransitionV1Schema>;

export const ReviewCommentLinkedIssueIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.strictObject({
    pluginId: z.string().check(z.minLength(1)),
    localId: z.string().check(z.minLength(1)),
  }),
  kindId: z.string().check(z.minLength(1)),
  collisionScope: z.string().check(z.minLength(1)),
  entryId: z.string().check(z.minLength(1)),
}));
export type ReviewCommentLinkedIssueIdentityV1 = z.infer<
  typeof ReviewCommentLinkedIssueIdentityV1Schema
>;

/** Stable opaque id for one exact source-qualified issue workflow subject. */
export function createReviewCommentLinkedIssueIdV1(
  input: ReviewCommentLinkedIssueIdentityV1,
): string {
  const value = ReviewCommentLinkedIssueIdentityV1Schema.parse(input);
  return JSON.stringify([
    value.source.pluginId,
    value.source.localId,
    value.kindId,
    value.collisionScope,
    value.entryId,
  ]);
}

export const ReviewCommentLinkedRefV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.enum(['executionRun', 'session', 'pullRequest', 'commit', 'checkpoint', 'external']),
    id: z.optional(z.string().check(z.minLength(1))),
    url: z.optional(z.string().check(z.url())),
  }),
  // Issues are a first-class workflow subject. Their opaque source-neutral id
  // is required; a mutable/presentational provider URL is never the identity.
  z.strictObject({
    kind: z.literal('issue'),
    id: z.string().check(z.minLength(1)),
    url: z.optional(z.string().check(z.url())),
  }),
]));
export type ReviewCommentLinkedRefV1 = z.infer<typeof ReviewCommentLinkedRefV1Schema>;

export const ReviewCommentSuggestedFixV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['patch', 'replacement', 'external']),
  patch: z.optional(z.string().check(z.minLength(1))),
  replacementText: z.optional(z.string().check(z.minLength(1))),
  url: z.optional(z.string().check(z.url())),
}));
export type ReviewCommentSuggestedFixV1 = z.infer<typeof ReviewCommentSuggestedFixV1Schema>;

export const ReviewCommentMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  severity: z.optional(z.enum(['info', 'warning', 'error', 'critical'])),
  taxonomyIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  tags: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type ReviewCommentMetadataV1 = z.infer<typeof ReviewCommentMetadataV1Schema>;

/** Actual producing run and reviewer; location is provenance, never a finding partition. */
export const ReviewCommentAppearanceInputV1Schema = lazyZodSchema(() => z.strictObject({
  roundOrdinal: z.number().check(z.int(), z.positive()),
  runId: z.string().check(z.minLength(1)),
  reviewerId: z.string().check(z.minLength(1)),
  machineId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
}));
export type ReviewCommentAppearanceInputV1 = z.infer<typeof ReviewCommentAppearanceInputV1Schema>;
export const ReviewCommentAppearanceV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewCommentAppearanceInputV1Schema.shape,
  reviewId: z.string().check(z.minLength(1)),
  commentId: z.string().check(z.minLength(1)),
}));
export type ReviewCommentAppearanceV1 = z.infer<typeof ReviewCommentAppearanceV1Schema>;

/** Content-free changes carried by the owning Review Artifact's AccountChange. */
export const ReviewCommentChangesHintV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), changes: z.array(z.strictObject({
    commentId: z.string().check(z.minLength(1)),
    serverRevision: z.number().check(z.int(), z.positive()),
    state: ReviewCommentStateV1Schema,
    reviewTriageStatus: z.optional(ReviewTriageStatusSchema),
  })),
}));
export type ReviewCommentChangesHintV1 = z.infer<typeof ReviewCommentChangesHintV1Schema>;

export function readReviewCommentChangesHintV1(hint: unknown): ReviewCommentChangesHintV1 | undefined {
  if (!hint || typeof hint !== 'object' || !('reviewComments' in hint)) return undefined;
  const parsed = ReviewCommentChangesHintV1Schema.safeParse(hint.reviewComments);
  return parsed.success ? parsed.data : undefined;
}

export function mergeReviewCommentChangesHintV1(previous: unknown, next: unknown): ReviewCommentChangesHintV1 | undefined {
  const retained = readReviewCommentChangesHintV1(previous);
  const incoming = readReviewCommentChangesHintV1(next);
  if (!retained) return incoming;
  if (!incoming) return retained;
  const changes = new Map(retained.changes.map(change => [change.commentId, change]));
  for (const change of incoming.changes) {
    const before = changes.get(change.commentId);
    if (!before || change.serverRevision >= before.serverRevision) changes.set(change.commentId, change);
  }
  return { v: 1, changes: [...changes.values()] };
}

function validateThreadIdentity(value: { id: string; threadId: string; parentCommentId?: string }, ctx: z.core.$RefinementCtx): void {
  if (!value.parentCommentId && value.threadId !== value.id) {
    ctx.addIssue({
      code: "custom",
      path: ['threadId'],
      message: 'thread roots must use their own id as threadId',
    });
  }
}

export function reviewCommentStateTransitionRequiresEvidenceV1(state: ReviewCommentStateV1): boolean {
  return state === 'resolved'
    || state === 'dismissed'
    || state === 'delegated'
    || state === 'pending_review';
}

export const ReviewCommentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: z.string().check(z.minLength(1)),
  accountId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  /** Direct authored attachment; producing engine findings use their real appearances. */
  roundOrdinal: z.optional(z.number().check(z.int(), z.positive())),
  /** Read projection of the canonical appearance relation, never client-authored content. */
  appearances: z.optional(z.array(ReviewCommentAppearanceInputV1Schema)),
  scopeAttribution: z.optional(ReviewFindingScopeAttributionSchema),
  extensions: z.optional(ReviewFindingExtensionsSchema),
  workspaceId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  runId: z.optional(z.string().check(z.minLength(1))),
  engineId: z.optional(z.string().check(z.minLength(1))),
  findingId: z.optional(z.string().check(z.minLength(1))),
  findingIdentity: z.optional(ReviewFindingIdentityV1Schema),
  findingSeverity: z.optional(ReviewFindingSeveritySchema),
  reviewedFingerprint: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotContentV1Schema,
  body: ReviewCommentBodyContentV1Schema,
  bodyVersion: z.number().check(z.int(), z.positive()),
  edits: z.array(ReviewCommentEditV1Schema),
  author: ReviewCommentActorRefV1Schema,
  state: ReviewCommentStateV1Schema,
  reviewTriageStatus: z.optional(ReviewTriageStatusSchema),
  flags: z.strictObject({
    stale: z.optional(z.boolean()),
    outdated: z.optional(z.boolean()),
    muted: z.optional(z.boolean()),
    redacted: z.optional(z.boolean()),
    disputed: z.optional(z.boolean()),
  }),
  dispositions: z.record(z.string().check(z.minLength(1)), ReviewCommentDispositionV1Schema),
  parentCommentId: z.optional(z.string().check(z.minLength(1))),
  threadId: z.string().check(z.minLength(1)),
  evidence: z.optional(z.array(ReviewCommentEvidenceV1Schema)),
  transitions: z.array(ReviewCommentTransitionV1Schema),
  tombstone: z.optional(ReviewCommentTombstoneV1Schema),
  fingerprint: z.optional(ReviewCommentFingerprintV1Schema),
  linkedRefs: z.optional(z.array(ReviewCommentLinkedRefV1Schema)),
  suggestedFix: z.optional(ReviewCommentSuggestedFixV1Schema),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  serverRevision: z.number().check(z.int(), z.positive()),
  metadata: z.optional(ReviewCommentMetadataV1Schema),
}).check(z.superRefine(validateThreadIdentity), z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentV1 = z.infer<typeof ReviewCommentV1Schema>;

export const ReviewCommentCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewCommentScopeV1Schema.shape,
  roundOrdinal: ReviewCommentV1Schema.shape.roundOrdinal,
  appearance: z.optional(ReviewCommentAppearanceInputV1Schema),
  scopeAttribution: z.optional(ReviewFindingScopeAttributionSchema),
  extensions: z.optional(ReviewFindingExtensionsSchema),
  workspaceId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  runId: z.optional(z.string().check(z.minLength(1))),
  engineId: z.optional(z.string().check(z.minLength(1))),
  findingId: z.optional(z.string().check(z.minLength(1))),
  findingIdentity: z.optional(ReviewFindingIdentityV1Schema),
  findingSeverity: z.optional(ReviewFindingSeveritySchema),
  reviewedFingerprint: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotContentV1Schema,
  body: ReviewCommentInputBodyContentV1Schema,
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
  authorIntent: z.optional(z.enum(['open', 'propose'])),
  fingerprint: z.optional(ReviewCommentFingerprintV1Schema),
  linkedRefs: z.optional(z.array(ReviewCommentLinkedRefV1Schema)),
  suggestedFix: z.optional(ReviewCommentSuggestedFixV1Schema),
  evidence: z.optional(z.array(ReviewCommentEvidenceV1Schema)),
  clientMutationId: z.string().check(z.minLength(1), z.maxLength(191)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  metadata: z.optional(ReviewCommentMetadataV1Schema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentCreateRequestV1 = z.infer<typeof ReviewCommentCreateRequestV1Schema>;

export const ReviewCommentTransitionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  toState: ReviewCommentStateV1Schema,
  reviewTriageStatus: z.optional(ReviewTriageStatusSchema),
  reason: z.optional(z.string().check(z.minLength(1))),
  evidence: z.optional(z.array(ReviewCommentEvidenceV1Schema)),
  expectedState: ReviewCommentStateV1Schema,
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1), z.superRefine((value, ctx) => {
  if (reviewCommentStateTransitionRequiresEvidenceV1(value.toState)
    && !(value.toState === value.expectedState && value.reviewTriageStatus !== undefined)
    && !value.reason
    && (!value.evidence || value.evidence.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ['evidence'],
      message: `${value.toState} requires evidence or reason`,
    });
  }
})));
export type ReviewCommentTransitionRequestV1 = z.infer<typeof ReviewCommentTransitionRequestV1Schema>;

export const ReviewCommentEditRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  nextBody: ReviewCommentInputBodyContentV1Schema,
  expectedBodyVersion: z.number().check(z.int(), z.positive()),
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  reason: z.optional(z.string().check(z.minLength(1))),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentEditRequestV1 = z.infer<typeof ReviewCommentEditRequestV1Schema>;

export const ReviewCommentReplyRequestV1Schema = lazyZodSchema(() => z.strictObject({
  parentCommentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  expectedParentServerRevision: z.number().check(z.int(), z.positive()),
  body: ReviewCommentInputBodyContentV1Schema,
  evidence: z.optional(z.array(ReviewCommentEvidenceV1Schema)),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentReplyRequestV1 = z.infer<typeof ReviewCommentReplyRequestV1Schema>;

export const ReviewCommentRedactRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  reason: z.optional(z.string().check(z.minLength(1))),
  redactBody: z.optional(z.boolean()),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentRedactRequestV1 = z.infer<typeof ReviewCommentRedactRequestV1Schema>;

export const ReviewCommentSetDispositionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  disposition: ReviewCommentDispositionV1Schema,
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentSetDispositionRequestV1 = z.infer<typeof ReviewCommentSetDispositionRequestV1Schema>;

export const ReviewCommentAttachEvidenceRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  evidence: z.array(ReviewCommentEvidenceV1Schema).check(z.minLength(1)),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentAttachEvidenceRequestV1 = z.infer<typeof ReviewCommentAttachEvidenceRequestV1Schema>;

export const ReviewCommentEventKindV1Schema = lazyZodSchema(() => z.enum([
  'created',
  'edited',
  'transitioned',
  'replied',
  'redacted',
  'disposition_set',
  'evidence_attached',
]));
export type ReviewCommentEventKindV1 = z.infer<typeof ReviewCommentEventKindV1Schema>;

export const ReviewCommentEventPayloadV1Schema = lazyZodSchema(() => z.record(z.string(), StrictJsonValueSchema));

export const ReviewCommentEventV1Schema = lazyZodSchema(() => z.strictObject({
  eventId: z.string().check(z.minLength(1)),
  commentId: z.string().check(z.minLength(1)),
  accountId: z.string().check(z.minLength(1)),
  ...ReviewCommentScopeV1Schema.shape,
  eventKind: ReviewCommentEventKindV1Schema,
  actor: ReviewCommentActorRefV1Schema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
  serverRevision: z.number().check(z.int(), z.positive()),
  bulkActionId: z.optional(z.string().check(z.minLength(1))),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  event: ReviewCommentEventPayloadV1Schema,
}).check(z.superRefine(validateReviewCommentScopeV1)));
export type ReviewCommentEventV1 = z.infer<typeof ReviewCommentEventV1Schema>;
