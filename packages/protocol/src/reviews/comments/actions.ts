import { z } from 'zod';

import {
  ReviewCommentAttachEvidenceRequestV1Schema,
  ReviewCommentAnchorV1Schema,
  ReviewCommentActorRefV1Schema,
  ReviewCommentCreateRequestV1Schema,
  ReviewCommentEditRequestV1Schema,
  ReviewCommentEvidenceV1Schema,
  ReviewCommentRedactRequestV1Schema,
  ReviewCommentReplyRequestV1Schema,
  ReviewCommentSetDispositionRequestV1Schema,
  ReviewCommentSnapshotV1Schema,
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
  subtarget: z.object({
    kindId: z.enum(['review-thread', 'review-comment']),
    targetId: z.string().min(1),
  }).strict().nullable(),
}).strict();
export type ReviewCommentPublicationTargetV1 = z.infer<typeof ReviewCommentPublicationTargetV1Schema>;

export type ReviewCommentPublicationTargetExpectationV1 = Readonly<{
  providerId: string;
  configuredAccountId: string;
  sourceId: string;
  localRef: Readonly<{
    kindId: string;
    collisionScope: string;
    entryId: string;
  }>;
  subtarget: ReviewCommentPublicationTargetV1['subtarget'];
}>;

/** Exact source/request routing for every provider publication adapter. */
export function reviewCommentPublicationTargetMatchesV1(
  target: ReviewCommentPublicationTargetV1,
  expected: ReviewCommentPublicationTargetExpectationV1,
): boolean {
  const subtargetMatches = expected.subtarget === null
    ? target.subtarget === null
    : target.subtarget?.kindId === expected.subtarget.kindId
      && target.subtarget.targetId === expected.subtarget.targetId;
  return subtargetMatches
    && target.providerId === expected.providerId
    && target.configuredAccountId === expected.configuredAccountId
    && target.entryRef.sourceId === expected.sourceId
    && target.entryRef.kindId === expected.localRef.kindId
    && target.entryRef.collisionScope === expected.localRef.collisionScope
    && target.entryRef.entryId === expected.localRef.entryId;
}

export const ReviewCommentPublicationEntryV1Schema = z.object({
  happierCommentId: z.string().min(1),
  expectedServerRevision: z.number().int().positive(),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotV1Schema,
  body: z.string().min(1),
}).strict();
export type ReviewCommentPublicationEntryV1 = z.infer<typeof ReviewCommentPublicationEntryV1Schema>;

export const ReviewCommentPublicationVerdictV1Schema = z.object({
  kind: z.enum(['approve', 'requestChanges', 'comment']),
  body: z.string().min(1),
}).strict();
export type ReviewCommentPublicationVerdictV1 = z.infer<typeof ReviewCommentPublicationVerdictV1Schema>;

const ReviewCommentPublicationPlanShapeV1 = {
  target: ReviewCommentPublicationTargetV1Schema,
  baseRevision: z.string().min(1).nullable(),
  headRevision: z.string().min(1).nullable(),
  entries: z.array(ReviewCommentPublicationEntryV1Schema),
  verdict: ReviewCommentPublicationVerdictV1Schema.nullable(),
} as const;

function refineReviewCommentPublicationPlanV1(
  value: Readonly<{
    baseRevision: string | null;
    headRevision: string | null;
    entries: readonly ReviewCommentPublicationEntryV1[];
    verdict: ReviewCommentPublicationVerdictV1 | null;
  }>,
  ctx: z.RefinementCtx,
): void {
  if (value.entries.length === 0 && value.verdict === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entries'],
      message: 'publication plan must contain at least one entry or a verdict',
    });
  }
  if ((value.baseRevision === null) !== (value.headRevision === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headRevision'],
      message: 'baseRevision and headRevision must either both be concrete or both be null',
    });
  }
  if (value.verdict !== null && value.headRevision === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headRevision'],
      message: 'publication verdicts require concrete base and head revisions',
    });
  }
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (seen.has(entry.happierCommentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'happierCommentId'],
        message: 'publication entries must have unique canonical review comment ids',
      });
    }
    seen.add(entry.happierCommentId);
  });
}

export const ReviewCommentPublicationPlanV1Schema = z.object(ReviewCommentPublicationPlanShapeV1)
  .strict()
  .superRefine(refineReviewCommentPublicationPlanV1);
export type ReviewCommentPublicationPlanV1 = z.infer<typeof ReviewCommentPublicationPlanV1Schema>;

export function parseReviewCommentPublicationPlanV1(value: unknown): ReviewCommentPublicationPlanV1 {
  return ReviewCommentPublicationPlanV1Schema.parse(value);
}

export type ReviewCommentPublicationRoutingV1 = Readonly<
  | {
    kind: 'ready';
    inlineEntryIndexes: readonly number[];
    verdictSummaryEntryIndexes: readonly number[];
  }
  | {
    kind: 'rejected';
    reason: 'diff_less_entry_requires_verdict_summary';
    entryIndexes: readonly number[];
  }
>;

/** Whether the shared anchor has no file-scoped provider route. */
export function reviewCommentPublicationEntryIsDiffLessV1(
  entry: ReviewCommentPublicationEntryV1,
): boolean {
  return !('filePath' in entry.anchor);
}

/**
 * Resolves pull-request review routes before the durable claim. Diff-less
 * entries fold into the one real user-authored verdict summary beside their
 * own exact markers. Without a verdict summary the complete plan is
 * unrouteable and must be rejected before any provider write.
 *
 * Providers remain responsible for deciding whether their native diff API
 * supports each file-scoped anchor; this helper never guesses that mapping.
 */
export function preflightReviewCommentPublicationRoutingV1(
  plan: ReviewCommentPublicationPlanV1,
): ReviewCommentPublicationRoutingV1 {
  const inlineEntryIndexes: number[] = [];
  const verdictSummaryEntryIndexes: number[] = [];
  plan.entries.forEach((entry, index) => {
    (reviewCommentPublicationEntryIsDiffLessV1(entry)
      ? verdictSummaryEntryIndexes
      : inlineEntryIndexes).push(index);
  });
  if (verdictSummaryEntryIndexes.length > 0 && plan.verdict === null) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'diff_less_entry_requires_verdict_summary' as const,
      entryIndexes: Object.freeze(verdictSummaryEntryIndexes),
    });
  }
  return Object.freeze({
    kind: 'ready' as const,
    inlineEntryIndexes: Object.freeze(inlineEntryIndexes),
    verdictSummaryEntryIndexes: Object.freeze(verdictSummaryEntryIndexes),
  });
}

export const ReviewCommentClaimPublicationDispatchRequestV1Schema = z.object(ReviewCommentPublicationPlanShapeV1)
  .strict()
  .superRefine(refineReviewCommentPublicationPlanV1);
export type ReviewCommentClaimPublicationDispatchRequestV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchRequestV1Schema
>;

export const ReviewCommentPublicationCorrelationV1Schema = z.object({
  happierCommentId: z.string().min(1),
  publicationCorrelationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ReviewCommentPublicationCorrelationV1 = z.infer<typeof ReviewCommentPublicationCorrelationV1Schema>;

const ReviewCommentPublicationCorrelationIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Canonical opaque provider marker; providers own transport, not its grammar. */
export function formatReviewCommentPublicationMarkerV1(
  kind: 'entry' | 'verdict',
  publicationCorrelationId: string,
): string {
  const correlation = ReviewCommentPublicationCorrelationIdV1Schema.parse(publicationCorrelationId);
  return `<!-- happier-review-${kind === 'entry' ? 'comment' : 'verdict'}:v1:${correlation} -->`;
}

export type ReviewCommentPublicationMarkerMatchV1 = Readonly<
  | { kind: 'absent' }
  | { kind: 'unique'; externalRef: string }
  | { kind: 'duplicate' }
>;

/** Refuses to attribute an effect when one exact marker names several rows. */
export function matchReviewCommentPublicationMarkerV1(
  rows: readonly Readonly<{ externalRef: string; body: string }>[],
  exactMarker: string,
): ReviewCommentPublicationMarkerMatchV1 {
  const matches = rows.filter((row) => row.body.includes(exactMarker));
  return matches.length === 0
    ? { kind: 'absent' }
    : matches.length === 1
      ? { kind: 'unique', externalRef: matches[0]!.externalRef }
      : { kind: 'duplicate' };
}

export const ReviewCommentClaimPublicationDispatchResponseV1Schema = z.object({
  disposition: z.enum(['dispatch', 'reconcile']),
  publicationPlanId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  entries: z.array(ReviewCommentPublicationCorrelationV1Schema),
  verdict: z.object({
    publicationCorrelationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }).strict().nullable(),
}).strict();
export type ReviewCommentClaimPublicationDispatchResponseV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchResponseV1Schema
>;

export function validateReviewCommentPublicationClaimAgainstPlanV1(
  plan: ReviewCommentPublicationPlanV1,
  candidate: unknown,
): ReviewCommentClaimPublicationDispatchResponseV1 {
  const parsed = ReviewCommentClaimPublicationDispatchResponseV1Schema.parse(candidate);
  const correlationIds = [
    ...parsed.entries.map((entry) => entry.publicationCorrelationId),
    ...(parsed.verdict === null ? [] : [parsed.verdict.publicationCorrelationId]),
  ];
  if (parsed.entries.length !== plan.entries.length
    || parsed.entries.some((entry, index) => entry.happierCommentId !== plan.entries[index]?.happierCommentId)
    || (parsed.verdict === null) !== (plan.verdict === null)
    || new Set(correlationIds).size !== correlationIds.length) {
    throw new Error('review_comment_publication_claim_cardinality_mismatch');
  }
  return parsed;
}

const ReviewCommentPublicationEntryEffectOutcomeV1Schema = z.union([
  z.object({ kind: z.literal('published'), externalRef: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('failed'), code: z.string().min(1), message: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('uncertain') }).strict(),
  z.object({ kind: z.literal('skippedPriorFailure') }).strict(),
]);

const ReviewCommentPublicationVerdictEffectOutcomeV1Schema = z.union([
  z.object({ kind: z.literal('published'), externalRef: z.string().min(1).optional() }).strict(),
  z.object({
    kind: z.literal('failed'),
    code: z.string().min(1),
    message: z.string().min(1).optional(),
    externalRef: z.string().min(1).optional(),
  }).strict(),
  z.object({ kind: z.literal('uncertain'), externalRef: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('skippedPriorFailure') }).strict(),
]);

export const ReviewCommentPublicationEntryResultV1Schema = z.object({
  happierCommentId: z.string().min(1),
  publicationCorrelationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  outcome: ReviewCommentPublicationEntryEffectOutcomeV1Schema,
}).strict();
export type ReviewCommentPublicationEntryResultV1 = z.infer<
  typeof ReviewCommentPublicationEntryResultV1Schema
>;

export const ReviewCommentPublicationVerdictResultV1Schema = z.union([
  z.object({ kind: z.literal('notRequested') }).strict(),
  z.object({
    publicationCorrelationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    outcome: ReviewCommentPublicationVerdictEffectOutcomeV1Schema,
  }).strict(),
]);
export type ReviewCommentPublicationVerdictResultV1 = z.infer<
  typeof ReviewCommentPublicationVerdictResultV1Schema
>;

export const ReviewCommentPublicationResultV1Schema = z.object({
  publicationPlanId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  entries: z.array(ReviewCommentPublicationEntryResultV1Schema),
  verdict: ReviewCommentPublicationVerdictResultV1Schema,
}).strict();
export type ReviewCommentPublicationResultV1 = z.infer<typeof ReviewCommentPublicationResultV1Schema>;

export function validateReviewCommentPublicationResultAgainstPlanV1(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  candidate: unknown,
): ReviewCommentPublicationResultV1 {
  const parsedClaim = validateReviewCommentPublicationClaimAgainstPlanV1(plan, claim);
  const parsed = ReviewCommentPublicationResultV1Schema.parse(candidate);
  const verdictMatches = plan.verdict === null
    ? 'kind' in parsed.verdict && parsed.verdict.kind === 'notRequested'
    : !('kind' in parsed.verdict)
      && parsedClaim.verdict !== null
      && parsed.verdict.publicationCorrelationId === parsedClaim.verdict.publicationCorrelationId;
  if (parsed.publicationPlanId !== parsedClaim.publicationPlanId
    || parsed.entries.length !== plan.entries.length
    || parsed.entries.some((entry, index) => {
      const expected = parsedClaim.entries[index];
      return entry.happierCommentId !== plan.entries[index]?.happierCommentId
        || entry.happierCommentId !== expected?.happierCommentId
        || entry.publicationCorrelationId !== expected.publicationCorrelationId;
    })
    || !verdictMatches) {
    throw new Error('review_comment_publication_result_cardinality_mismatch');
  }
  const routing = preflightReviewCommentPublicationRoutingV1(plan);
  if (routing.kind === 'ready'
    && routing.verdictSummaryEntryIndexes.length > 0
    && !('kind' in parsed.verdict)
  ) {
    const verdictOutcome = parsed.verdict.outcome;
    const verdictExternalRef = 'externalRef' in verdictOutcome
      ? verdictOutcome.externalRef
      : undefined;
    for (const index of routing.verdictSummaryEntryIndexes) {
      const outcome = parsed.entries[index]!.outcome;
      if (outcome.kind === 'published') {
        if (verdictExternalRef === undefined || verdictExternalRef !== outcome.externalRef) {
          throw new Error('review_comment_publication_result_summary_reference_mismatch');
        }
      } else if (verdictOutcome.kind === 'published') {
        throw new Error('review_comment_publication_result_summary_reference_mismatch');
      }
    }
  }
  return parsed;
}

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
