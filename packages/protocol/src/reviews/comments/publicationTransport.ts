import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  deriveReviewCommentPublicationIdentityV1,
  reviewCommentPublicationContentKeyFingerprintV1,
  isAccountScopedBlobCiphertextForKind,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../../crypto/accountScopedCipher.js';
import { StoredJsonContentEnvelopeSchema } from '../../storage/storedJsonContentEnvelope.js';
import {
  stringifyReviewCommentPrincipalCanonicalJsonV1,
  ReviewCommentClaimPublicationDispatchRequestV1Schema,
  ReviewCommentPublicationCorrelationV1Schema,
  ReviewCommentPublicationDispatchInstructionV1Schema,
  ReviewCommentPublicationVerdictEffectOutcomeV1Schema,
  validateReviewCommentPublicationClaimAgainstPlanV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
  type ReviewCommentClaimPublicationDispatchRequestV1,
  type ReviewCommentClaimPublicationDispatchResponseV1,
  type ReviewCommentPublicationPlanV1,
} from './actions.js';

const identity = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const outcomeSchema = lazyZodSchema(() => z.object({
  kind: z.enum(['published', 'failed', 'uncertain', 'skippedPriorFailure']),
  externalRefTag: identity.optional(),
  content: StoredJsonContentEnvelopeSchema.optional(),
}).strict().superRefine((outcome, ctx) => {
  if ((outcome.kind === 'published' || outcome.kind === 'failed' || outcome.externalRefTag !== undefined)
    && outcome.content === undefined) {
    ctx.addIssue({ code: 'custom', message: 'review_comment_publication_outcome_content_required' });
  }
}));
export const ReviewCommentPublicationTransportResultV1Schema = lazyZodSchema(() => z.object({
  publicationPlanId: identity,
  entries: z.array(ReviewCommentPublicationCorrelationV1Schema.extend({ outcome: outcomeSchema })),
  verdict: z.union([
    z.object({ kind: z.literal('notRequested') }).strict(),
    z.object({ publicationCorrelationId: identity, outcome: outcomeSchema }).strict(),
  ]),
}).strict());
export type ReviewCommentPublicationTransportResultV1 = z.infer<typeof ReviewCommentPublicationTransportResultV1Schema>;

/** Server-readable admission/effect state only. The frozen provider plan never leaves the host. */
export const ReviewCommentPublicationTransportRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  mode: z.enum(['plain', 'e2ee']),
  contentPublicKeyFingerprint: z.string().min(1).nullable(),
  targetKey: identity,
  publicationPlanId: identity,
  entries: z.array(ReviewCommentPublicationCorrelationV1Schema.extend({ expectedServerRevision: z.number().int().positive() })),
  verdict: z.object({ publicationCorrelationId: identity }).strict().nullable(),
  settlement: z.object({
    dispatchToken: z.string().min(1).nullable(),
    result: ReviewCommentPublicationTransportResultV1Schema,
  }).strict().optional(),
}).strict().superRefine((request, ctx) => {
  const correlations = [...request.entries.map((entry) => entry.publicationCorrelationId),
    ...(request.verdict === null ? [] : [request.verdict.publicationCorrelationId])];
  if (correlations.length === 0 || new Set(correlations).size !== correlations.length
    || new Set(request.entries.map((entry) => entry.happierCommentId)).size !== request.entries.length
    || (request.mode === 'plain') !== (request.contentPublicKeyFingerprint === null)) {
    ctx.addIssue({ code: 'custom', message: 'review_comment_publication_binding_invalid' });
  }
  const result = request.settlement?.result;
  if (!result) return;
  if (result.publicationPlanId !== request.publicationPlanId || result.entries.length !== request.entries.length
    || result.entries.some((entry, index) => entry.happierCommentId !== request.entries[index]?.happierCommentId
      || entry.publicationCorrelationId !== request.entries[index]?.publicationCorrelationId)
    || (request.verdict === null ? !('kind' in result.verdict)
      : 'kind' in result.verdict || result.verdict.publicationCorrelationId !== request.verdict.publicationCorrelationId)) {
    ctx.addIssue({ code: 'custom', message: 'review_comment_publication_result_cardinality_mismatch' });
  }
  const outcomes = [...result.entries.map((entry) => entry.outcome), ...('kind' in result.verdict ? [] : [result.verdict.outcome])];
  for (const outcome of outcomes) {
    if (outcome.content !== undefined && (request.mode === 'plain' ? outcome.content.t !== 'plain'
      : outcome.content.t !== 'encrypted' || !isAccountScopedBlobCiphertextForKind({ ciphertext: outcome.content.c, kind: 'review_comment_sensitive' }))) {
      ctx.addIssue({ code: 'custom', message: 'review_comment_encryption_mode_mismatch' });
    }
  }
}));
export type ReviewCommentPublicationTransportRequestV1 = z.infer<typeof ReviewCommentPublicationTransportRequestV1Schema>;

export const ReviewCommentPublicationTransportResponseV1Schema = lazyZodSchema(() => z.object({
  disposition: z.enum(['dispatch', 'reconcile']),
  dispatchToken: z.string().min(1).nullable(),
  publicationPlanId: identity,
  entries: z.array(ReviewCommentPublicationCorrelationV1Schema),
  verdict: z.object({ publicationCorrelationId: identity }).strict().nullable(),
  instructions: z.object({ entries: z.array(ReviewCommentPublicationDispatchInstructionV1Schema), verdict: ReviewCommentPublicationDispatchInstructionV1Schema.nullable() }).strict(),
  priorResult: ReviewCommentPublicationTransportResultV1Schema.nullable(),
}).strict());
export type ReviewCommentPublicationTransportResponseV1 = z.infer<typeof ReviewCommentPublicationTransportResponseV1Schema>;

export type ReviewCommentPublicationCryptoContextV1 = Readonly<{
  accountId: string;
  mode: 'plain' | 'e2ee';
  material: AccountScopedCryptoMaterial | null;
}>;

function binding(plan: ReviewCommentPublicationPlanV1, context: ReviewCommentPublicationCryptoContextV1) {
  const derive = (purpose: Parameters<typeof deriveReviewCommentPublicationIdentityV1>[0]['purpose'], ...components: string[]) =>
    deriveReviewCommentPublicationIdentityV1({ ...context, purpose, components });
  const targetKey = derive('target', stringifyReviewCommentPrincipalCanonicalJsonV1(plan.target));
  const publicationPlanId = derive('plan', stringifyReviewCommentPrincipalCanonicalJsonV1(plan));
  return {
    v: 1 as const, mode: context.mode,
    contentPublicKeyFingerprint: context.mode === 'e2ee' ? reviewCommentPublicationContentKeyFingerprintV1(context.material!) : null,
    targetKey, publicationPlanId,
    entries: plan.entries.map((entry) => ({ happierCommentId: entry.happierCommentId, expectedServerRevision: entry.expectedServerRevision,
      publicationCorrelationId: derive('entry', targetKey, entry.happierCommentId) })),
    verdict: plan.verdict === null ? null : { publicationCorrelationId: derive('verdict', targetKey, publicationPlanId) },
  };
}

const privateOutcomeSchema = lazyZodSchema(() => z.object({
  v: z.literal(1), purpose: z.literal('publicationOutcome'), accountId: z.string(),
  publicationPlanId: identity, publicationCorrelationId: identity,
  outcome: ReviewCommentPublicationVerdictEffectOutcomeV1Schema,
}).strict());

export function buildReviewCommentPublicationTransportRequestV1(params: Readonly<{
  input: ReviewCommentClaimPublicationDispatchRequestV1;
  context: ReviewCommentPublicationCryptoContextV1;
  randomBytes: (length: number) => Uint8Array;
}>): ReviewCommentPublicationTransportRequestV1 {
  const { settlement, ...plan } = ReviewCommentClaimPublicationDispatchRequestV1Schema.parse(params.input);
  const bound = binding(plan, params.context);
  if (!settlement) return ReviewCommentPublicationTransportRequestV1Schema.parse(bound);
  const localClaim = { publicationPlanId: bound.publicationPlanId,
    entries: bound.entries.map(({ expectedServerRevision: _revision, ...entry }) => entry), verdict: bound.verdict,
    disposition: 'reconcile' as const, dispatchToken: null,
    instructions: { entries: bound.entries.map(() => 'reconcile' as const), verdict: bound.verdict === null ? null : 'reconcile' as const }, priorResult: null };
  const result = validateReviewCommentPublicationResultAgainstPlanV1(plan, localClaim, settlement.result);
  const seal = (publicationCorrelationId: string, outcome: z.infer<typeof ReviewCommentPublicationVerdictEffectOutcomeV1Schema>) => {
    const payload = { v: 1, purpose: 'publicationOutcome', accountId: params.context.accountId,
      publicationPlanId: bound.publicationPlanId, publicationCorrelationId, outcome };
    return { kind: outcome.kind,
      ...('externalRef' in outcome && outcome.externalRef !== undefined ? { externalRefTag: deriveReviewCommentPublicationIdentityV1({
        ...params.context, purpose: 'externalRef', components: [bound.publicationPlanId, outcome.externalRef],
      }) } : {}),
      content: params.context.mode === 'plain' ? { t: 'plain' as const, v: payload } : { t: 'encrypted' as const,
        c: sealAccountScopedBlobCiphertext({ kind: 'review_comment_sensitive', material: params.context.material!, payload, randomBytes: params.randomBytes }) },
    };
  };
  return ReviewCommentPublicationTransportRequestV1Schema.parse({ ...bound, settlement: { dispatchToken: settlement.dispatchToken, result: {
    ...result, entries: result.entries.map((entry) => ({ ...entry, outcome: seal(entry.publicationCorrelationId, entry.outcome) })),
    verdict: 'kind' in result.verdict ? result.verdict : { ...result.verdict, outcome: seal(result.verdict.publicationCorrelationId, result.verdict.outcome) },
  } } });
}

export function openReviewCommentPublicationTransportResponseV1(params: Readonly<{
  plan: ReviewCommentPublicationPlanV1;
  context: ReviewCommentPublicationCryptoContextV1;
  response: unknown;
}>): ReviewCommentClaimPublicationDispatchResponseV1 {
  const { settlement: _settlement, ...plan } = ReviewCommentClaimPublicationDispatchRequestV1Schema.parse(params.plan);
  const expected = binding(plan, params.context);
  const response = ReviewCommentPublicationTransportResponseV1Schema.parse(params.response);
  if (response.publicationPlanId !== expected.publicationPlanId
    || response.entries.some((entry, index) => entry.publicationCorrelationId !== expected.entries[index]?.publicationCorrelationId)
    || response.verdict?.publicationCorrelationId !== expected.verdict?.publicationCorrelationId) {
    throw new Error('review_comment_publication_binding_mismatch');
  }
  const open = (publicationCorrelationId: string, outcome: z.infer<typeof outcomeSchema>) => {
    if (outcome.content === undefined) {
      if (outcome.kind === 'uncertain' || outcome.kind === 'skippedPriorFailure') return { kind: outcome.kind };
      throw new Error('review_comment_publication_outcome_content_required');
    }
    let value: unknown;
    if (params.context.mode === 'plain' && outcome.content.t === 'plain') value = outcome.content.v;
    else if (params.context.mode === 'e2ee' && outcome.content.t === 'encrypted') {
      const opened = openAccountScopedBlobCiphertext({ kind: 'review_comment_sensitive', material: params.context.material!, ciphertext: outcome.content.c });
      if (!opened || opened.kindTag !== 'canonical') throw new Error('review_comment_publication_outcome_invalid');
      value = opened.value;
    } else throw new Error('review_comment_encryption_mode_mismatch');
    const privateOutcome = privateOutcomeSchema.parse(value);
    const privateRef = 'externalRef' in privateOutcome.outcome ? privateOutcome.outcome.externalRef : undefined;
    const tag = privateRef === undefined ? undefined : deriveReviewCommentPublicationIdentityV1({ ...params.context, purpose: 'externalRef', components: [expected.publicationPlanId, privateRef] });
    if (privateOutcome.accountId !== params.context.accountId || privateOutcome.publicationPlanId !== expected.publicationPlanId
      || privateOutcome.publicationCorrelationId !== publicationCorrelationId || privateOutcome.outcome.kind !== outcome.kind || tag !== outcome.externalRefTag) {
      throw new Error('review_comment_publication_outcome_binding_mismatch');
    }
    return privateOutcome.outcome;
  };
  const result = response.priorResult;
  const priorResult = result === null ? null : { ...result,
    entries: result.entries.map((entry) => ({ ...entry, outcome: open(entry.publicationCorrelationId, entry.outcome) })),
    verdict: 'kind' in result.verdict ? result.verdict : { ...result.verdict, outcome: open(result.verdict.publicationCorrelationId, result.verdict.outcome) },
  };
  const claim = validateReviewCommentPublicationClaimAgainstPlanV1(plan, { ...response, priorResult });
  if (claim.priorResult) validateReviewCommentPublicationResultAgainstPlanV1(plan, claim, claim.priorResult);
  return claim;
}
