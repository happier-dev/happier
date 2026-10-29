import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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
  ReviewCommentScopeV1Schema,
  ReviewCommentWorkspaceV1Schema,
  validateReviewCommentScopeV1,
  ReviewCommentTransitionRequestV1Schema,
  ReviewCommentV1Schema,
  reviewCommentStateTransitionRequiresEvidenceV1,
} from './v1.js';
import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { WorkflowSessionScopeV1Schema, type WorkflowSessionScopeV1 } from '../../workflows/workflowSessionScopeV1.js';
export { isWorkflowSessionScopeTargetV1, readWorkflowActionInvocationV1 } from '../../workflows/workflowSessionScopeV1.js';

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

export const ReviewCommentPrincipalProofV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  alg: z.literal('ed25519-machine-installation-v1'),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  installationId: z.string().check(z.trim(), z.minLength(1)),
  issuedAt: z.number().check(z.int(), z.nonnegative()),
  nonce: z.string().check(z.trim(), z.minLength(1)),
  method: z.enum(['GET', 'POST', 'PATCH']),
  path: z.string().check(z.trim(), z.minLength(1)),
  bodySha256Base64Url: z.string().check(z.trim(), z.minLength(1)),
  signatureBase64Url: z.string().check(z.trim(), z.minLength(1)),
}));
export type ReviewCommentPrincipalProofV1 = z.infer<typeof ReviewCommentPrincipalProofV1Schema>;

const ReviewCommentCurrentIntentIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));

const ReviewCommentPluginCurrentIntentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('execution_run_host_action'),
  actionId: z.literal('reviews.comments.create'),
  subjectFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  effectBodySha256Base64Url: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  sessionId: ReviewCommentCurrentIntentIdV1Schema,
  runId: ReviewCommentCurrentIntentIdV1Schema,
  callId: ReviewCommentCurrentIntentIdV1Schema,
  profileId: ReviewCommentCurrentIntentIdV1Schema,
  pluginId: ReviewCommentCurrentIntentIdV1Schema,
  agentId: ReviewCommentCurrentIntentIdV1Schema,
  projectId: ReviewCommentCurrentIntentIdV1Schema,
  workspaceId: ReviewCommentCurrentIntentIdV1Schema,
  sourceCustody: PluginSourceCustodyV1Schema,
}));
const ReviewCommentMaterializationIntentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('review_findings_materialization'),
  actionId: z.literal('reviews.comments.create'),
  effectBodySha256Base64Url: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  sessionId: z.optional(ReviewCommentCurrentIntentIdV1Schema),
  workflowRunId: z.optional(ReviewCommentCurrentIntentIdV1Schema),
  runId: ReviewCommentCurrentIntentIdV1Schema,
  callId: ReviewCommentCurrentIntentIdV1Schema,
  agentId: ReviewCommentCurrentIntentIdV1Schema,
  ...ReviewCommentScopeV1Schema.shape,
}).check(z.superRefine(validateReviewCommentScopeV1), z.superRefine((value, ctx) => {
  if (!value.sessionId && !value.workflowRunId) {
    ctx.addIssue({ code: "custom", path: ['sessionId'], message: 'A Session or Workflow Run is required' });
  }
})));
export const ReviewCommentCurrentIntentV1Schema = lazyZodSchema(() => z.union([
  ReviewCommentPluginCurrentIntentV1Schema,
  ReviewCommentMaterializationIntentV1Schema,
]));
export type ReviewCommentCurrentIntentV1 = z.infer<typeof ReviewCommentCurrentIntentV1Schema>;

export const ReviewCommentPrincipalHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  actor: ReviewCommentActorRefV1Schema,
  currentIntent: z.optional(ReviewCommentCurrentIntentV1Schema),
  workflowScope: z.optional(WorkflowSessionScopeV1Schema),
  proof: z.optional(ReviewCommentPrincipalProofV1Schema),
}).check(z.refine(value => value.workflowScope === undefined || value.actor.kind === 'workflow',
  'Only Workflow principals carry invocation Session authority')));
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
  workflowScope?: WorkflowSessionScopeV1;
  proof: Omit<ReviewCommentPrincipalProofV1, 'signatureBase64Url'>;
}>): Uint8Array {
  return new TextEncoder().encode(`happier.reviewCommentPrincipal.v1\u0000${stringifyReviewCommentPrincipalCanonicalJsonV1({
    actor: params.actor,
    ...(params.currentIntent ? { currentIntent: params.currentIntent } : {}),
    ...(params.workflowScope ? { workflowScope: params.workflowScope } : {}),
    proof: params.proof,
  })}`);
}

export const ReviewCommentActionIdV1Schema = lazyZodSchema(() => z.enum(REVIEW_COMMENT_ACTION_IDS_V1));
export type ReviewCommentActionIdV1 = z.infer<typeof ReviewCommentActionIdV1Schema>;

const ReviewCommentListTaxonomyIdsV1Schema = lazyZodSchema(() => z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => typeof value === 'string' ? [value] : value), z.array(z.string().check(z.minLength(1))))));

export const ReviewCommentOperationErrorCodeV1Schema = lazyZodSchema(() => z.enum([
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
]));
export type ReviewCommentOperationErrorCodeV1 = z.infer<typeof ReviewCommentOperationErrorCodeV1Schema>;

export const ReviewCommentListRequestV1Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.optional(ReviewCommentWorkspaceV1Schema),
  workspaceId: z.optional(z.string().check(z.minLength(1))),
  projectId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  runId: z.optional(z.string().check(z.minLength(1))),
  states: z._default(z.array(ReviewCommentStateV1Schema), []),
  authorKind: z.optional(z.enum(['user', 'plugin', 'agent', 'workflow'])),
  authorId: z.optional(z.string().check(z.minLength(1))),
  engineId: z.optional(z.string().check(z.minLength(1))),
  filePath: z.optional(z.string().check(z.minLength(1))),
  folderPath: z.optional(z.string().check(z.minLength(1))),
  severity: z.optional(z.enum(['info', 'warning', 'error', 'critical'])),
  taxonomyIds: ReviewCommentListTaxonomyIdsV1Schema,
  includeHistory: z._default(z.boolean(), false),
  cursor: z.optional(z.string().check(z.minLength(1))),
  limit: z._default(z.number().check(z.int(), z.positive(), z.maximum(200)), 50),
}));
export type ReviewCommentListRequestV1 = z.infer<typeof ReviewCommentListRequestV1Schema>;

/** Action orchestration may drain the existing paged transport; the wire request stays unchanged. */
export const ReviewCommentListActionRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ReviewCommentListRequestV1Schema, {
  allPages: z.optional(z.literal(true)),
})));

export const ReviewCommentGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  includeHistory: z._default(z.boolean(), true),
}));
export type ReviewCommentGetRequestV1 = z.infer<typeof ReviewCommentGetRequestV1Schema>;

export const ReviewCommentListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(ReviewCommentV1Schema),
  cursor: z._default(z.nullable(z.string().check(z.minLength(1))), null),
}));
export type ReviewCommentListResponseV1 = z.infer<typeof ReviewCommentListResponseV1Schema>;

export const ReviewCommentGetResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentGetResponseV1 = z.infer<typeof ReviewCommentGetResponseV1Schema>;

const reviewCommentPublicationTargetFieldsV1 = () => ({
  providerId: z.string().check(z.minLength(1)),
  entryRef: z.strictObject({
    sourceId: z.string().check(z.minLength(1)),
    kindId: z.string().check(z.minLength(1)),
    collisionScope: z.string().check(z.minLength(1)),
    entryId: z.string().check(z.minLength(1)),
  }),
  subtarget: z.nullable(z.strictObject({
    kindId: z.enum(['review-thread', 'review-comment']),
    targetId: z.string().check(z.minLength(1)),
  })),
});
export const ReviewCommentPublicationTargetV1Schema = lazyZodSchema(() => {
  const fields = reviewCommentPublicationTargetFieldsV1();
  return z.union([
    z.strictObject({ ...fields, configuredAccountId: z.string().check(z.minLength(1)) }),
    z.strictObject({ ...fields, nativeService: asProtocolZod(PluginContributionIdentityV1Schema) }),
  ]);
});
export type ReviewCommentPublicationTargetV1 = z.infer<typeof ReviewCommentPublicationTargetV1Schema>;

export type ReviewCommentPublicationTargetExpectationV1 = (
  | Readonly<{ configuredAccountId: string }>
  | Readonly<{ nativeService: PluginContributionIdentityV1 }>
) & Readonly<{
  providerId: string;
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
  const authorityMatches = 'configuredAccountId' in target
    ? 'configuredAccountId' in expected && target.configuredAccountId === expected.configuredAccountId
    : 'nativeService' in expected
      && target.nativeService.pluginId === expected.nativeService.pluginId
      && target.nativeService.localId === expected.nativeService.localId;
  return subtargetMatches
    && target.providerId === expected.providerId
    && authorityMatches
    && target.entryRef.sourceId === expected.sourceId
    && target.entryRef.kindId === expected.localRef.kindId
    && target.entryRef.collisionScope === expected.localRef.collisionScope
    && target.entryRef.entryId === expected.localRef.entryId;
}

export const ReviewCommentPublicationEntryV1Schema = lazyZodSchema(() => z.strictObject({
  happierCommentId: z.string().check(z.minLength(1)),
  expectedServerRevision: z.number().check(z.int(), z.positive()),
  anchor: ReviewCommentAnchorV1Schema,
  snapshot: ReviewCommentSnapshotV1Schema,
  body: z.string().check(z.minLength(1)),
}));
export type ReviewCommentPublicationEntryV1 = z.infer<typeof ReviewCommentPublicationEntryV1Schema>;

export const ReviewCommentPublicationVerdictV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['approve', 'requestChanges', 'comment']),
  body: z.string().check(z.minLength(1)),
}));
export type ReviewCommentPublicationVerdictV1 = z.infer<typeof ReviewCommentPublicationVerdictV1Schema>;

const ReviewCommentPublicationPlanShapeV1 = {
  target: ReviewCommentPublicationTargetV1Schema,
  baseRevision: lazyZodSchema(() => z.nullable(z.string().check(z.minLength(1)))),
  headRevision: lazyZodSchema(() => z.nullable(z.string().check(z.minLength(1)))),
  entries: lazyZodSchema(() => z.array(ReviewCommentPublicationEntryV1Schema)),
  verdict: z.nullable(ReviewCommentPublicationVerdictV1Schema),
} as const;

function refineReviewCommentPublicationPlanV1(
  value: Readonly<{
    baseRevision: string | null;
    headRevision: string | null;
    entries: readonly ReviewCommentPublicationEntryV1[];
    verdict: ReviewCommentPublicationVerdictV1 | null;
  }>,
  ctx: z.core.$RefinementCtx,
): void {
  if (value.entries.length === 0 && value.verdict === null) {
    ctx.addIssue({
      code: "custom",
      path: ['entries'],
      message: 'publication plan must contain at least one entry or a verdict',
    });
  }
  if ((value.baseRevision === null) !== (value.headRevision === null)) {
    ctx.addIssue({
      code: "custom",
      path: ['headRevision'],
      message: 'baseRevision and headRevision must either both be concrete or both be null',
    });
  }
  if (value.verdict !== null && value.headRevision === null) {
    ctx.addIssue({
      code: "custom",
      path: ['headRevision'],
      message: 'publication verdicts require concrete base and head revisions',
    });
  }
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (seen.has(entry.happierCommentId)) {
      ctx.addIssue({
        code: "custom",
        path: ['entries', index, 'happierCommentId'],
        message: 'publication entries must have unique canonical review comment ids',
      });
    }
    seen.add(entry.happierCommentId);
  });
}

export const ReviewCommentPublicationPlanV1Schema = lazyZodSchema(() => z.strictObject(ReviewCommentPublicationPlanShapeV1).check(z.superRefine(refineReviewCommentPublicationPlanV1)));
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

export const ReviewCommentPublicationCorrelationV1Schema = lazyZodSchema(() => z.strictObject({
  happierCommentId: z.string().check(z.minLength(1)),
  publicationCorrelationId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
}));
export type ReviewCommentPublicationCorrelationV1 = z.infer<typeof ReviewCommentPublicationCorrelationV1Schema>;

const ReviewCommentPublicationCorrelationIdV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)));

/** Canonical opaque provider marker; providers own transport, not its grammar. */
export function formatReviewCommentPublicationMarkerV1(
  kind: 'entry' | 'verdict',
  publicationCorrelationId: string,
): string {
  const correlation = ReviewCommentPublicationCorrelationIdV1Schema.parse(publicationCorrelationId);
  return `<!-- happier-review-${kind === 'entry' ? 'comment' : 'verdict'}:v1:${correlation} -->`;
}

/** A marker suppresses reflected provider content; it never establishes authorship or authority. */
export function hasReviewCommentPublicationMarkerV1(body: string): boolean {
  return /<!-- happier-review-(?:comment|verdict):v1:[A-Za-z0-9_-]{43} -->/u.test(body);
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

export const ReviewCommentPublicationEntryEffectOutcomeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('published'), externalRef: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('failed'), code: z.string().check(z.minLength(1)), message: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({ kind: z.literal('uncertain') }),
  z.strictObject({ kind: z.literal('skippedPriorFailure') }),
]));

export const ReviewCommentPublicationVerdictEffectOutcomeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('published'), externalRef: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({
    kind: z.literal('failed'),
    code: z.string().check(z.minLength(1)),
    message: z.optional(z.string().check(z.minLength(1))),
    externalRef: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ kind: z.literal('uncertain'), externalRef: z.optional(z.string().check(z.minLength(1))) }),
  z.strictObject({ kind: z.literal('skippedPriorFailure') }),
]));

export const ReviewCommentPublicationEntryResultV1Schema = lazyZodSchema(() => z.strictObject({
  happierCommentId: z.string().check(z.minLength(1)),
  publicationCorrelationId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  outcome: ReviewCommentPublicationEntryEffectOutcomeV1Schema,
}));
export type ReviewCommentPublicationEntryResultV1 = z.infer<
  typeof ReviewCommentPublicationEntryResultV1Schema
>;

export const ReviewCommentPublicationVerdictResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('notRequested') }),
  z.strictObject({
    publicationCorrelationId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
    outcome: ReviewCommentPublicationVerdictEffectOutcomeV1Schema,
  }),
]));
export type ReviewCommentPublicationVerdictResultV1 = z.infer<
  typeof ReviewCommentPublicationVerdictResultV1Schema
>;

export const ReviewCommentPublicationResultV1Schema = lazyZodSchema(() => z.strictObject({
  publicationPlanId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  entries: z.array(ReviewCommentPublicationEntryResultV1Schema),
  verdict: ReviewCommentPublicationVerdictResultV1Schema,
}));
export type ReviewCommentPublicationResultV1 = z.infer<typeof ReviewCommentPublicationResultV1Schema>;

export const ReviewCommentPublicationDispatchInstructionV1Schema = lazyZodSchema(() => z.enum([
  'dispatch',
  'reconcile',
  'confirmed',
  'held',
]));
export type ReviewCommentPublicationDispatchInstructionV1 = z.infer<
  typeof ReviewCommentPublicationDispatchInstructionV1Schema
>;

export const ReviewCommentClaimPublicationDispatchRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewCommentPublicationPlanShapeV1,
  settlement: z.optional(z.strictObject({
    dispatchToken: z.nullable(z.string().check(z.minLength(1))),
    result: ReviewCommentPublicationResultV1Schema,
  })),
}).check(z.superRefine(refineReviewCommentPublicationPlanV1)));
export type ReviewCommentClaimPublicationDispatchRequestV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchRequestV1Schema
>;

export const ReviewCommentClaimPublicationDispatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
  disposition: z.enum(['dispatch', 'reconcile']),
  dispatchToken: z.nullable(z.string().check(z.minLength(1))),
  publicationPlanId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  entries: z.array(ReviewCommentPublicationCorrelationV1Schema),
  verdict: z.nullable(z.strictObject({
    publicationCorrelationId: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)),
  })),
  instructions: z.strictObject({
    entries: z.array(ReviewCommentPublicationDispatchInstructionV1Schema),
    verdict: z.nullable(ReviewCommentPublicationDispatchInstructionV1Schema),
  }),
  priorResult: z.nullable(ReviewCommentPublicationResultV1Schema),
}).check(z.superRefine((claim, context) => {
  const dispatchInstructions = [
    ...claim.instructions.entries,
    ...(claim.instructions.verdict === null ? [] : [claim.instructions.verdict]),
  ].filter((instruction) => instruction === 'dispatch');
  if ((claim.disposition === 'dispatch') !== (claim.dispatchToken !== null)
    || (claim.disposition === 'dispatch') !== (dispatchInstructions.length > 0)) {
    context.addIssue({
      code: 'custom',
      message: 'review_comment_publication_claim_dispatch_mismatch',
    });
  }
})));
export type ReviewCommentClaimPublicationDispatchResponseV1 = z.infer<
  typeof ReviewCommentClaimPublicationDispatchResponseV1Schema
>;

function reviewCommentPublicationResultMatchesClaimV1(
  plan: ReviewCommentPublicationPlanV1,
  claim: Pick<ReviewCommentClaimPublicationDispatchResponseV1, 'publicationPlanId' | 'entries' | 'verdict'>,
  result: ReviewCommentPublicationResultV1,
): boolean {
  const verdictMatches = plan.verdict === null
    ? 'kind' in result.verdict && result.verdict.kind === 'notRequested'
    : !('kind' in result.verdict)
      && claim.verdict !== null
      && result.verdict.publicationCorrelationId === claim.verdict.publicationCorrelationId;
  return result.publicationPlanId === claim.publicationPlanId
    && result.entries.length === plan.entries.length
    && !result.entries.some((entry, index) => {
      const expected = claim.entries[index];
      return entry.happierCommentId !== plan.entries[index]?.happierCommentId
        || entry.happierCommentId !== expected?.happierCommentId
        || entry.publicationCorrelationId !== expected.publicationCorrelationId;
    })
    && verdictMatches;
}

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
    || parsed.instructions.entries.length !== plan.entries.length
    || (parsed.verdict === null) !== (plan.verdict === null)
    || (parsed.instructions.verdict === null) !== (plan.verdict === null)
    || new Set(correlationIds).size !== correlationIds.length
    || (parsed.priorResult !== null
      && !reviewCommentPublicationResultMatchesClaimV1(plan, parsed, parsed.priorResult))) {
    throw new Error('review_comment_publication_claim_cardinality_mismatch');
  }
  return parsed;
}

export function validateReviewCommentPublicationResultAgainstPlanV1(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  candidate: unknown,
): ReviewCommentPublicationResultV1 {
  const parsedClaim = validateReviewCommentPublicationClaimAgainstPlanV1(plan, claim);
  const parsed = ReviewCommentPublicationResultV1Schema.parse(candidate);
  if (!reviewCommentPublicationResultMatchesClaimV1(plan, parsedClaim, parsed)) {
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

export function createReviewCommentPublicationSettlementRequestV1(
  plan: ReviewCommentPublicationPlanV1,
  claim: ReviewCommentClaimPublicationDispatchResponseV1,
  result: ReviewCommentPublicationResultV1,
): ReviewCommentClaimPublicationDispatchRequestV1 {
  return ReviewCommentClaimPublicationDispatchRequestV1Schema.parse({
    ...plan,
    settlement: {
      dispatchToken: claim.dispatchToken,
      result: validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, result),
    },
  });
}

export const ReviewCommentCreateResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
  replayed: z.optional(z.boolean()),
}));
export type ReviewCommentCreateResponseV1 = z.infer<typeof ReviewCommentCreateResponseV1Schema>;

export const ReviewCommentTransitionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentTransitionResponseV1 = z.infer<typeof ReviewCommentTransitionResponseV1Schema>;

export const ReviewCommentEditResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentEditResponseV1 = z.infer<typeof ReviewCommentEditResponseV1Schema>;

export const ReviewCommentReplyResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
  parent: ReviewCommentV1Schema,
}));
export type ReviewCommentReplyResponseV1 = z.infer<typeof ReviewCommentReplyResponseV1Schema>;

export const ReviewCommentBulkTransitionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewCommentScopeV1Schema.shape,
  commentIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  toState: ReviewCommentStateV1Schema,
  expectedState: ReviewCommentStateV1Schema,
  expectedServerRevisions: z.record(z.string().check(z.minLength(1)), z.number().check(z.int(), z.positive())),
  evidence: z._default(z.array(ReviewCommentEvidenceV1Schema), []),
  reason: z.optional(z.string().check(z.minLength(1))),
  bulkActionId: z.optional(z.string().check(z.minLength(1))),
  clientMutationId: z.string().check(z.minLength(1)),
  authorDeviceId: z.optional(z.string().check(z.minLength(1))),
  clientLamport: z.optional(z.number().check(z.int(), z.nonnegative())),
  eventEnvelope: z.optional(StoredJsonContentEnvelopeSchema),
}).check(z.superRefine(validateReviewCommentScopeV1), z.superRefine((value, ctx) => {
  if (reviewCommentStateTransitionRequiresEvidenceV1(value.toState) && value.evidence.length === 0 && !value.reason) {
    ctx.addIssue({
      code: "custom",
      path: ['evidence'],
      message: `${value.toState} requires evidence or reason`,
    });
  }
})));
export type ReviewCommentBulkTransitionRequestV1 = z.infer<typeof ReviewCommentBulkTransitionRequestV1Schema>;

export const ReviewCommentBulkTransitionFailureV1Schema = lazyZodSchema(() => z.strictObject({
  commentId: z.string().check(z.minLength(1)),
  errorCode: ReviewCommentOperationErrorCodeV1Schema,
  error: z.string().check(z.minLength(1)),
}));
export type ReviewCommentBulkTransitionFailureV1 = z.infer<typeof ReviewCommentBulkTransitionFailureV1Schema>;

export const ReviewCommentBulkTransitionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  bulkActionId: z.string().check(z.minLength(1)),
  updated: z.array(ReviewCommentV1Schema),
  failed: z.array(ReviewCommentBulkTransitionFailureV1Schema),
}));
export type ReviewCommentBulkTransitionResponseV1 = z.infer<typeof ReviewCommentBulkTransitionResponseV1Schema>;

export const ReviewCommentRedactResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentRedactResponseV1 = z.infer<typeof ReviewCommentRedactResponseV1Schema>;

export const ReviewCommentSetDispositionResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentSetDispositionResponseV1 = z.infer<typeof ReviewCommentSetDispositionResponseV1Schema>;

export const ReviewCommentAttachEvidenceResponseV1Schema = lazyZodSchema(() => z.strictObject({
  comment: ReviewCommentV1Schema,
}));
export type ReviewCommentAttachEvidenceResponseV1 = z.infer<typeof ReviewCommentAttachEvidenceResponseV1Schema>;

export const ReviewCommentActionInputSchemasV1 = Object.freeze({
  'reviews.comments.create': ReviewCommentCreateRequestV1Schema,
  'reviews.comments.list': ReviewCommentListActionRequestV1Schema,
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
