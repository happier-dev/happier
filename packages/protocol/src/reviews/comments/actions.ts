import { z } from 'zod';

import {
  ReviewCommentAttachEvidenceRequestV1Schema,
  ReviewCommentActorRefV1Schema,
  ReviewCommentCreateRequestV1Schema,
  ReviewCommentEditRequestV1Schema,
  ReviewCommentEvidenceV1Schema,
  ReviewCommentRedactRequestV1Schema,
  ReviewCommentReplyRequestV1Schema,
  ReviewCommentSetDispositionRequestV1Schema,
  ReviewCommentStateV1Schema,
  ReviewCommentTransitionRequestV1Schema,
  ReviewCommentV1Schema,
  reviewCommentStateTransitionRequiresEvidenceV1,
} from './v1.js';
import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';

export const REVIEW_COMMENT_ACTION_IDS_V1 = Object.freeze([
  'reviews.comments.create',
  'reviews.comments.list',
  'reviews.comments.get',
  'reviews.comments.transition',
  'reviews.comments.edit',
  'reviews.comments.reply',
  'reviews.comments.redact',
  'reviews.comments.setDisposition',
  'reviews.comments.attachEvidence',
  'reviews.comments.bulkTransition',
  'reviews.comments.claimPublicationDispatch',
] as const);

export const REVIEW_COMMENT_PRINCIPAL_HEADER_V1 = 'x-happier-review-comment-principal' as const;

export const ReviewCommentPrincipalProofV1Schema = z.object({
  v: z.literal(1),
  alg: z.literal('ed25519-machine-installation-v1'),
  machineId: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  issuedAt: z.number().int().nonnegative(),
  nonce: z.string().trim().min(1),
  method: z.enum(['GET', 'POST', 'PATCH']),
  path: z.string().trim().min(1),
  bodySha256Base64Url: z.string().trim().min(1),
  signatureBase64Url: z.string().trim().min(1),
}).strict();
export type ReviewCommentPrincipalProofV1 = z.infer<typeof ReviewCommentPrincipalProofV1Schema>;

const ReviewCommentCurrentIntentIdV1Schema = z.string().trim().min(1).max(512);

export const ReviewCommentCurrentIntentV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('execution_run_host_action'),
  actionId: z.literal('reviews.comments.create'),
  subjectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  effectBodySha256Base64Url: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  sessionId: ReviewCommentCurrentIntentIdV1Schema,
  runId: ReviewCommentCurrentIntentIdV1Schema,
  callId: ReviewCommentCurrentIntentIdV1Schema,
  profileId: ReviewCommentCurrentIntentIdV1Schema,
  pluginId: ReviewCommentCurrentIntentIdV1Schema,
  agentId: ReviewCommentCurrentIntentIdV1Schema,
  projectId: ReviewCommentCurrentIntentIdV1Schema,
  workspaceId: ReviewCommentCurrentIntentIdV1Schema,
  immutableGenerationId: ReviewCommentCurrentIntentIdV1Schema,
}).strict();
export type ReviewCommentCurrentIntentV1 = z.infer<typeof ReviewCommentCurrentIntentV1Schema>;

export const ReviewCommentPrincipalHeaderV1Schema = z.object({
  actor: ReviewCommentActorRefV1Schema,
  currentIntent: ReviewCommentCurrentIntentV1Schema.optional(),
  proof: ReviewCommentPrincipalProofV1Schema.optional(),
}).strict();
export type ReviewCommentPrincipalHeaderV1 = z.infer<typeof ReviewCommentPrincipalHeaderV1Schema>;

function normalizeCanonicalJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeCanonicalJsonValue(item);
      return typeof normalized === 'undefined' ? null : normalized;
    });
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = normalizeCanonicalJsonValue((value as Record<string, unknown>)[key]);
      if (typeof normalized !== 'undefined') output[key] = normalized;
    }
    return output;
  }
  return undefined;
}

export function stringifyReviewCommentPrincipalCanonicalJsonV1(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJsonValue(value) ?? null);
}

export function createReviewCommentPrincipalSigningInputV1(params: Readonly<{
  actor: z.infer<typeof ReviewCommentActorRefV1Schema>;
  currentIntent?: ReviewCommentCurrentIntentV1;
  proof: Omit<ReviewCommentPrincipalProofV1, 'signatureBase64Url'>;
}>): Uint8Array {
  return new TextEncoder().encode(`happier.reviewCommentPrincipal.v1\u0000${stringifyReviewCommentPrincipalCanonicalJsonV1({
    actor: params.actor,
    ...(params.currentIntent ? { currentIntent: params.currentIntent } : {}),
    proof: params.proof,
  })}`);
}

export const ReviewCommentActionIdV1Schema = z.enum(REVIEW_COMMENT_ACTION_IDS_V1);
export type ReviewCommentActionIdV1 = z.infer<typeof ReviewCommentActionIdV1Schema>;

const ReviewCommentListTaxonomyIdsV1Schema = z.preprocess(
  (value) => typeof value === 'string' ? [value] : value,
  z.array(z.string().min(1)).optional(),
);

export const ReviewCommentOperationErrorCodeV1Schema = z.enum([
  'review_comment_not_found',
  'review_comment_invalid_request',
  'review_comment_invalid_transition',
  'review_comment_permission_denied',
  'review_comment_direct_write_permission_required',
  'review_comment_encryption_mode_mismatch',
  'review_comment_invalid_filter',
  'review_comment_snapshot_invalid',
  'review_comment_conflict',
  'review_comment_idempotency_conflict',
  'review_comment_thread_closed',
  'review_comment_already_redacted',
]);
export type ReviewCommentOperationErrorCodeV1 = z.infer<typeof ReviewCommentOperationErrorCodeV1Schema>;

export const ReviewCommentListRequestV1Schema = z.object({
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  states: z.array(ReviewCommentStateV1Schema).default([]),
  authorKind: z.enum(['user', 'plugin', 'agent']).optional(),
  authorId: z.string().min(1).optional(),
  engineId: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
  folderPath: z.string().min(1).optional(),
  severity: z.enum(['info', 'warning', 'error', 'critical']).optional(),
  taxonomyIds: ReviewCommentListTaxonomyIdsV1Schema,
  includeHistory: z.boolean().default(false),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(50),
}).strict();
export type ReviewCommentListRequestV1 = z.infer<typeof ReviewCommentListRequestV1Schema>;

export const ReviewCommentGetRequestV1Schema = z.object({
  commentId: z.string().min(1),
  includeHistory: z.boolean().default(true),
}).strict();
export type ReviewCommentGetRequestV1 = z.infer<typeof ReviewCommentGetRequestV1Schema>;

export const ReviewCommentListResponseV1Schema = z.object({
  items: z.array(ReviewCommentV1Schema),
  cursor: z.string().min(1).nullable().default(null),
}).strict();
export type ReviewCommentListResponseV1 = z.infer<typeof ReviewCommentListResponseV1Schema>;

export const ReviewCommentGetResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentGetResponseV1 = z.infer<typeof ReviewCommentGetResponseV1Schema>;

export const ReviewCommentPublicationTargetV1Schema = z.object({
  providerId: z.string().min(1),
  configuredAccountId: z.string().min(1),
  entryRef: z.object({
    sourceId: z.string().min(1),
    kindId: z.string().min(1),
    collisionScope: z.string().min(1),
    entryId: z.string().min(1),
  }).strict(),
}).strict();
export type ReviewCommentPublicationTargetV1 = z.infer<typeof ReviewCommentPublicationTargetV1Schema>;

export const ReviewCommentClaimPublicationDispatchRequestV1Schema = z.object({
  commentId: z.string().min(1),
  target: ReviewCommentPublicationTargetV1Schema,
}).strict();
export type ReviewCommentClaimPublicationDispatchRequestV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchRequestV1Schema
>;

export const ReviewCommentClaimPublicationDispatchResponseV1Schema = z.object({
  disposition: z.enum(['dispatch', 'reconcile']),
  publicationCorrelationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ReviewCommentClaimPublicationDispatchResponseV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchResponseV1Schema
>;

export const ReviewCommentCreateResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
  replayed: z.boolean().optional(),
}).strict();
export type ReviewCommentCreateResponseV1 = z.infer<typeof ReviewCommentCreateResponseV1Schema>;

export const ReviewCommentTransitionResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentTransitionResponseV1 = z.infer<typeof ReviewCommentTransitionResponseV1Schema>;

export const ReviewCommentEditResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentEditResponseV1 = z.infer<typeof ReviewCommentEditResponseV1Schema>;

export const ReviewCommentReplyResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
  parent: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentReplyResponseV1 = z.infer<typeof ReviewCommentReplyResponseV1Schema>;

export const ReviewCommentBulkTransitionRequestV1Schema = z.object({
  projectId: z.string().min(1),
  commentIds: z.array(z.string().min(1)).min(1),
  toState: ReviewCommentStateV1Schema,
  expectedState: ReviewCommentStateV1Schema,
  expectedServerRevisions: z.record(z.string().min(1), z.number().int().positive()),
  evidence: z.array(ReviewCommentEvidenceV1Schema).default([]),
  reason: z.string().min(1).optional(),
  bulkActionId: z.string().min(1).optional(),
  clientMutationId: z.string().min(1),
  authorDeviceId: z.string().min(1).optional(),
  clientLamport: z.number().int().nonnegative().optional(),
  eventEnvelope: StoredJsonContentEnvelopeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (reviewCommentStateTransitionRequiresEvidenceV1(value.toState) && value.evidence.length === 0 && !value.reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence'],
      message: `${value.toState} requires evidence or reason`,
    });
  }
});
export type ReviewCommentBulkTransitionRequestV1 = z.infer<typeof ReviewCommentBulkTransitionRequestV1Schema>;

export const ReviewCommentBulkTransitionFailureV1Schema = z.object({
  commentId: z.string().min(1),
  errorCode: ReviewCommentOperationErrorCodeV1Schema,
  error: z.string().min(1),
}).strict();
export type ReviewCommentBulkTransitionFailureV1 = z.infer<typeof ReviewCommentBulkTransitionFailureV1Schema>;

export const ReviewCommentBulkTransitionResponseV1Schema = z.object({
  bulkActionId: z.string().min(1),
  updated: z.array(ReviewCommentV1Schema),
  failed: z.array(ReviewCommentBulkTransitionFailureV1Schema),
}).strict();
export type ReviewCommentBulkTransitionResponseV1 = z.infer<typeof ReviewCommentBulkTransitionResponseV1Schema>;

export const ReviewCommentRedactResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentRedactResponseV1 = z.infer<typeof ReviewCommentRedactResponseV1Schema>;

export const ReviewCommentSetDispositionResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentSetDispositionResponseV1 = z.infer<typeof ReviewCommentSetDispositionResponseV1Schema>;

export const ReviewCommentAttachEvidenceResponseV1Schema = z.object({
  comment: ReviewCommentV1Schema,
}).strict();
export type ReviewCommentAttachEvidenceResponseV1 = z.infer<typeof ReviewCommentAttachEvidenceResponseV1Schema>;

export const ReviewCommentActionInputSchemasV1 = Object.freeze({
  'reviews.comments.create': ReviewCommentCreateRequestV1Schema,
  'reviews.comments.list': ReviewCommentListRequestV1Schema,
  'reviews.comments.get': ReviewCommentGetRequestV1Schema,
  'reviews.comments.transition': ReviewCommentTransitionRequestV1Schema,
  'reviews.comments.edit': ReviewCommentEditRequestV1Schema,
  'reviews.comments.reply': ReviewCommentReplyRequestV1Schema,
  'reviews.comments.redact': ReviewCommentRedactRequestV1Schema,
  'reviews.comments.setDisposition': ReviewCommentSetDispositionRequestV1Schema,
  'reviews.comments.attachEvidence': ReviewCommentAttachEvidenceRequestV1Schema,
  'reviews.comments.bulkTransition': ReviewCommentBulkTransitionRequestV1Schema,
  'reviews.comments.claimPublicationDispatch': ReviewCommentClaimPublicationDispatchRequestV1Schema,
});

export const ReviewCommentActionOutputSchemasV1 = Object.freeze({
  'reviews.comments.create': ReviewCommentCreateResponseV1Schema,
  'reviews.comments.list': ReviewCommentListResponseV1Schema,
  'reviews.comments.get': ReviewCommentGetResponseV1Schema,
  'reviews.comments.transition': ReviewCommentTransitionResponseV1Schema,
  'reviews.comments.edit': ReviewCommentEditResponseV1Schema,
  'reviews.comments.reply': ReviewCommentReplyResponseV1Schema,
  'reviews.comments.redact': ReviewCommentRedactResponseV1Schema,
  'reviews.comments.setDisposition': ReviewCommentSetDispositionResponseV1Schema,
  'reviews.comments.attachEvidence': ReviewCommentAttachEvidenceResponseV1Schema,
  'reviews.comments.bulkTransition': ReviewCommentBulkTransitionResponseV1Schema,
  'reviews.comments.claimPublicationDispatch': ReviewCommentClaimPublicationDispatchResponseV1Schema,
});
