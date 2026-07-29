import { z } from 'zod';

import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';

export const REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1 = 'reviews.comments.write.direct' as const;

export const ReviewCommentStateV1Schema = z.enum([
  'proposed',
  'open',
  'delegated',
  'pending_review',
  'resolved',
  'dismissed',
]);
export type ReviewCommentStateV1 = z.infer<typeof ReviewCommentStateV1Schema>;

export const ReviewCommentSnapshotSourceV1Schema = z.enum([
  'workingTree',
  'committed',
  'diffSide',
  'agentBuffer',
  'untracked',
]);
export type ReviewCommentSnapshotSourceV1 = z.infer<typeof ReviewCommentSnapshotSourceV1Schema>;

export const ReviewCommentActorRefV1Schema = z.union([
  z.object({ kind: z.literal('user'), userId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().min(1),
    engineRunId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
  }).strict(),
]);
export type ReviewCommentActorRefV1 = z.infer<typeof ReviewCommentActorRefV1Schema>;

const ReviewCommentAnchorSideV1Schema = z.enum(['before', 'after']);

export const ReviewCommentAnchorV1Schema = z.union([
  z.object({
    kind: z.literal('line'),
    filePath: z.string().min(1),
    line: z.number().int().min(1),
    side: ReviewCommentAnchorSideV1Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('range'),
    filePath: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    side: ReviewCommentAnchorSideV1Schema.optional(),
  }).strict().superRefine((value, ctx) => {
    if (value.endLine < value.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endLine'],
        message: 'endLine must be greater than or equal to startLine',
      });
    }
  }),
  z.object({
    kind: z.literal('hunk'),
    filePath: z.string().min(1),
    hunkId: z.string().min(1),
    side: ReviewCommentAnchorSideV1Schema.optional(),
  }).strict(),
  z.object({ kind: z.literal('file'), filePath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('folder'), folderPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('project'), projectId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('run'), runId: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal('finding'),
    runId: z.string().min(1),
    findingId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('binary'),
    filePath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('submodule'),
    filePath: z.string().min(1),
    commitSha: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('symlink'),
    filePath: z.string().min(1),
    targetPath: z.string().min(1),
  }).strict(),
]);
export type ReviewCommentAnchorV1 = z.infer<typeof ReviewCommentAnchorV1Schema>;

export const ReviewCommentSnapshotV1Schema = z.union([
  z.object({
    kind: z.literal('text'),
    selectedLines: z.array(z.string()),
    beforeContext: z.array(z.string()),
    afterContext: z.array(z.string()),
    selectedLinesHash: z.string().min(1),
    contextWindowHash: z.string().min(1),
    capturedAt: z.number().int().nonnegative(),
    fileLength: z.number().int().nonnegative(),
    source: ReviewCommentSnapshotSourceV1Schema,
    commitSha: z.string().min(1).optional(),
    isUncommitted: z.boolean(),
    isUntracked: z.boolean(),
    truncated: z.boolean(),
    truncationReason: z.enum(['file_too_large', 'line_too_long', 'context_cap']).optional(),
    hasBidiControls: z.boolean(),
    likelyMinified: z.boolean(),
    diffContext: z.object({
      side: ReviewCommentAnchorSideV1Schema,
      baseSha: z.string().min(1).optional(),
      headSha: z.string().min(1).optional(),
      startSha: z.string().min(1).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('binary'),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    source: ReviewCommentSnapshotSourceV1Schema,
    capturedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('submodule'),
    filePath: z.string().min(1),
    commitSha: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    capturedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('symlink'),
    filePath: z.string().min(1),
    targetPath: z.string().min(1),
    targetExists: z.boolean().optional(),
    capturedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('too_large'),
    filePath: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().min(1).optional(),
    capBytes: z.number().int().positive(),
    capturedAt: z.number().int().nonnegative(),
  }).strict(),
]);
export type ReviewCommentSnapshotV1 = z.infer<typeof ReviewCommentSnapshotV1Schema>;

export const ReviewCommentBodyContentV1Schema = z.union([
  z.string(),
  StoredJsonContentEnvelopeSchema,
]);
export type ReviewCommentBodyContentV1 = z.infer<typeof ReviewCommentBodyContentV1Schema>;

export const ReviewCommentInputBodyContentV1Schema = z.union([
  z.string().min(1),
  StoredJsonContentEnvelopeSchema,
]);
export type ReviewCommentInputBodyContentV1 = z.infer<typeof ReviewCommentInputBodyContentV1Schema>;

export const ReviewCommentSnapshotContentV1Schema = z.union([
  ReviewCommentSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
]);
export type ReviewCommentSnapshotContentV1 = z.infer<typeof ReviewCommentSnapshotContentV1Schema>;

export const ReviewCommentEvidenceV1Schema = z.union([
  z.object({ kind: z.literal('diff'), diffRef: z.string().min(1), summary: z.string().min(1).optional() }).strict(),
  z.object({
    kind: z.literal('test'),
    testResultRef: z.string().min(1),
    status: z.enum(['passed', 'failed', 'mixed']),
    summary: z.string().min(1).optional(),
  }).strict(),
  z.object({ kind: z.literal('reasoning'), message: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('external'), url: z.string().url(), label: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('agentMessage'), sessionId: z.string().min(1), messageId: z.string().min(1) }).strict(),
]);
export type ReviewCommentEvidenceV1 = z.infer<typeof ReviewCommentEvidenceV1Schema>;

export const ReviewCommentEditV1Schema = z.object({
  editId: z.string().min(1),
  editedAt: z.number().int().nonnegative(),
  editedBy: ReviewCommentActorRefV1Schema,
  previousBody: ReviewCommentBodyContentV1Schema,
  nextBody: ReviewCommentInputBodyContentV1Schema,
  reason: z.string().min(1).optional(),
}).strict();
export type ReviewCommentEditV1 = z.infer<typeof ReviewCommentEditV1Schema>;

export const ReviewCommentTombstoneV1Schema = z.object({
  deletedAt: z.number().int().nonnegative(),
  deletedBy: ReviewCommentActorRefV1Schema,
  reason: z.string().min(1).optional(),
  redacted: z.boolean(),
}).strict();
export type ReviewCommentTombstoneV1 = z.infer<typeof ReviewCommentTombstoneV1Schema>;

export const ReviewCommentFingerprintV1Schema = z.object({
  ruleId: z.string().min(1).optional(),
  fileSha: z.string().min(1).optional(),
  lineRange: z.object({
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  }).strict().optional(),
  normalizedMessageHash: z.string().min(1),
  engineId: z.string().min(1).optional(),
}).strict();
export type ReviewCommentFingerprintV1 = z.infer<typeof ReviewCommentFingerprintV1Schema>;

export const ReviewCommentDispositionV1Schema = z.enum(['working', 'satisfied', 'blocking']);
export type ReviewCommentDispositionV1 = z.infer<typeof ReviewCommentDispositionV1Schema>;

export const ReviewCommentTransitionV1Schema = z.object({
  transitionId: z.string().min(1),
  fromState: ReviewCommentStateV1Schema.optional(),
  toState: ReviewCommentStateV1Schema,
  transitionedAt: z.number().int().nonnegative(),
  transitionedBy: ReviewCommentActorRefV1Schema,
  reason: z.string().min(1).optional(),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  bulkActionId: z.string().min(1).optional(),
  clientMutationId: z.string().min(1).optional(),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  serverRevision: z.number().int().positive().optional(),
}).strict();
export type ReviewCommentTransitionV1 = z.infer<typeof ReviewCommentTransitionV1Schema>;

export const ReviewCommentLinkedRefV1Schema = z.object({
  kind: z.enum(['executionRun', 'session', 'pullRequest', 'commit', 'checkpoint', 'external']),
  id: z.string().min(1).optional(),
  url: z.string().url().optional(),
}).strict();
export type ReviewCommentLinkedRefV1 = z.infer<typeof ReviewCommentLinkedRefV1Schema>;

export const ReviewCommentSuggestedFixV1Schema = z.object({
  kind: z.enum(['patch', 'replacement', 'external']),
  patch: z.string().min(1).optional(),
  replacementText: z.string().min(1).optional(),
  url: z.string().url().optional(),
}).strict();
export type ReviewCommentSuggestedFixV1 = z.infer<typeof ReviewCommentSuggestedFixV1Schema>;

export const ReviewCommentMetadataV1Schema = z.object({
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  taxonomyIds: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
}).strict();
export type ReviewCommentMetadataV1 = z.infer<typeof ReviewCommentMetadataV1Schema>;

function validateThreadIdentity(value: { id: string; threadId: string; parentCommentId?: string }, ctx: z.RefinementCtx): void {
  if (!value.parentCommentId && value.threadId !== value.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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

export const ReviewCommentV1Schema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  engineId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotContentV1Schema,
  body: ReviewCommentBodyContentV1Schema,
  bodyVersion: z.number().int().positive(),
  edits: z.array(ReviewCommentEditV1Schema),
  author: ReviewCommentActorRefV1Schema,
  state: ReviewCommentStateV1Schema,
  flags: z.object({
    stale: z.boolean().optional(),
    outdated: z.boolean().optional(),
    muted: z.boolean().optional(),
    redacted: z.boolean().optional(),
  }).strict(),
  dispositions: z.record(z.string().min(1), ReviewCommentDispositionV1Schema),
  parentCommentId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  transitions: z.array(ReviewCommentTransitionV1Schema),
  tombstone: ReviewCommentTombstoneV1Schema.optional(),
  fingerprint: ReviewCommentFingerprintV1Schema.optional(),
  linkedRefs: z.array(ReviewCommentLinkedRefV1Schema).optional(),
  suggestedFix: ReviewCommentSuggestedFixV1Schema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  serverRevision: z.number().int().positive(),
  metadata: ReviewCommentMetadataV1Schema.optional(),
}).strict().superRefine(validateThreadIdentity);
export type ReviewCommentV1 = z.infer<typeof ReviewCommentV1Schema>;

export const ReviewCommentCreateRequestV1Schema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  engineId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotContentV1Schema,
  body: ReviewCommentInputBodyContentV1Schema,
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
  authorIntent: z.enum(['open', 'propose']).optional(),
  fingerprint: ReviewCommentFingerprintV1Schema.optional(),
  linkedRefs: z.array(ReviewCommentLinkedRefV1Schema).optional(),
  suggestedFix: ReviewCommentSuggestedFixV1Schema.optional(),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  clientMutationId: z.string().min(1).max(191),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  metadata: ReviewCommentMetadataV1Schema.optional(),
}).strict();
export type ReviewCommentCreateRequestV1 = z.infer<typeof ReviewCommentCreateRequestV1Schema>;

export const ReviewCommentTransitionRequestV1Schema = z.object({
  commentId: z.string().min(1),
  toState: ReviewCommentStateV1Schema,
  reason: z.string().min(1).optional(),
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  expectedState: ReviewCommentStateV1Schema.optional(),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (reviewCommentStateTransitionRequiresEvidenceV1(value.toState)
    && !value.reason
    && (!value.evidence || value.evidence.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence'],
      message: `${value.toState} requires evidence or reason`,
    });
  }
});
export type ReviewCommentTransitionRequestV1 = z.infer<typeof ReviewCommentTransitionRequestV1Schema>;

export const ReviewCommentEditRequestV1Schema = z.object({
  commentId: z.string().min(1),
  nextBody: ReviewCommentInputBodyContentV1Schema,
  expectedBodyVersion: z.number().int().positive().optional(),
  reason: z.string().min(1).optional(),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict();
export type ReviewCommentEditRequestV1 = z.infer<typeof ReviewCommentEditRequestV1Schema>;

export const ReviewCommentReplyRequestV1Schema = z.object({
  parentCommentId: z.string().min(1),
  body: ReviewCommentInputBodyContentV1Schema,
  evidence: z.array(ReviewCommentEvidenceV1Schema).optional(),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict();
export type ReviewCommentReplyRequestV1 = z.infer<typeof ReviewCommentReplyRequestV1Schema>;

export const ReviewCommentRedactRequestV1Schema = z.object({
  commentId: z.string().min(1),
  reason: z.string().min(1).optional(),
  redactBody: z.boolean().optional(),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict();
export type ReviewCommentRedactRequestV1 = z.infer<typeof ReviewCommentRedactRequestV1Schema>;

export const ReviewCommentSetDispositionRequestV1Schema = z.object({
  commentId: z.string().min(1),
  disposition: ReviewCommentDispositionV1Schema,
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict();
export type ReviewCommentSetDispositionRequestV1 = z.infer<typeof ReviewCommentSetDispositionRequestV1Schema>;

export const ReviewCommentAttachEvidenceRequestV1Schema = z.object({
  commentId: z.string().min(1),
  evidence: z.array(ReviewCommentEvidenceV1Schema).min(1),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict();
export type ReviewCommentAttachEvidenceRequestV1 = z.infer<typeof ReviewCommentAttachEvidenceRequestV1Schema>;

export const ReviewCommentEventKindV1Schema = z.enum([
  'created',
  'edited',
  'transitioned',
  'replied',
  'redacted',
  'disposition_set',
  'evidence_attached',
]);
export type ReviewCommentEventKindV1 = z.infer<typeof ReviewCommentEventKindV1Schema>;

export const ReviewCommentEventV1Schema = z.object({
  eventId: z.string().min(1),
  commentId: z.string().min(1),
  accountId: z.string().min(1),
  projectId: z.string().min(1),
  eventKind: ReviewCommentEventKindV1Schema,
  actor: ReviewCommentActorRefV1Schema,
  createdAt: z.number().int().nonnegative(),
  serverRevision: z.number().int().positive(),
  bulkActionId: z.string().min(1).optional(),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  event: z.record(z.string(), z.unknown()),
}).strict();
export type ReviewCommentEventV1 = z.infer<typeof ReviewCommentEventV1Schema>;
