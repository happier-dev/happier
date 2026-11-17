import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { StoredJsonContentEnvelopeSchema, type StoredJsonContentEnvelope } from '../storage/storedJsonContentEnvelope.js';
import { ReviewRoundBindingV1Schema } from './reviewArtifactV1.js';

export const ReviewVerdictKindV1Schema = lazyZodSchema(() => z.enum(['approve', 'request_changes', 'comment']));
export type ReviewVerdictKindV1 = z.infer<typeof ReviewVerdictKindV1Schema>;

export const ReviewRequestedReviewerInputV1Schema = lazyZodSchema(() => z.strictObject({
  principal: PrincipalRefV1Schema,
  required: z.boolean(),
}));
export type ReviewRequestedReviewerInputV1 = z.infer<typeof ReviewRequestedReviewerInputV1Schema>;

export const ReviewReviewersSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewRoundBindingV1Schema.shape,
  reviewers: z.array(ReviewRequestedReviewerInputV1Schema),
}));
export type ReviewReviewersSetInputV1 = z.infer<typeof ReviewReviewersSetInputV1Schema>;

/** The authenticated person supplies their own verdict; there is deliberately no actor operand. */
export const ReviewVerdictSubmitInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewRoundBindingV1Schema.shape,
  verdict: ReviewVerdictKindV1Schema,
  content: z.optional(StoredJsonContentEnvelopeSchema),
  expectedRevision: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type ReviewVerdictSubmitInputV1 = z.infer<typeof ReviewVerdictSubmitInputV1Schema>;

/** The answering person's Action seals prose locally before crossing the HTTP boundary. */
export const ReviewVerdictActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewRoundBindingV1Schema.shape,
  verdict: ReviewVerdictKindV1Schema,
  body: z.optional(z.string()),
}));
export type ReviewVerdictActionInputV1 = z.infer<typeof ReviewVerdictActionInputV1Schema>;

/** Sealed with the Review Artifact codec, so ciphertext cannot be replayed as another person's verdict. */
export const ReviewVerdictContentV1Schema = lazyZodSchema(() => z.strictObject({
  ...ReviewRoundBindingV1Schema.shape,
  accountId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.positive()),
  body: z.string(),
}));
export type ReviewVerdictContentV1 = z.infer<typeof ReviewVerdictContentV1Schema>;

export type ReviewVerdictContentBindingV1 = Pick<ReviewVerdictContentV1, 'reviewId' | 'roundOrdinal' | 'accountId' | 'revision'>;

/** The Artifact opener owns key admission; this owner verifies the opened verdict's identity. */
export async function openReviewVerdictContentV1(input: Readonly<{
  content: StoredJsonContentEnvelope;
  expected: ReviewVerdictContentBindingV1;
  open: (content: StoredJsonContentEnvelope) => Promise<unknown>;
}>): Promise<ReviewVerdictContentV1> {
  const content = ReviewVerdictContentV1Schema.parse(await input.open(input.content));
  if (content.reviewId !== input.expected.reviewId || content.roundOrdinal !== input.expected.roundOrdinal
    || content.accountId !== input.expected.accountId || content.revision !== input.expected.revision) {
    throw Object.assign(new Error('review_verdict_content_mismatch'), { code: 'review_verdict_content_mismatch' });
  }
  return content;
}

export const ReviewRequestedReviewerV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)),
  roundOrdinal: z.number().check(z.int(), z.positive()),
  ...ReviewRequestedReviewerInputV1Schema.shape,
  needsAccess: z.boolean(),
}));
export type ReviewRequestedReviewerV1 = z.infer<typeof ReviewRequestedReviewerV1Schema>;

export const ReviewVerdictV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)),
  roundOrdinal: z.number().check(z.int(), z.positive()),
  verdict: ReviewVerdictKindV1Schema,
  content: z.optional(StoredJsonContentEnvelopeSchema),
  submittedAt: z.number().check(z.int(), z.nonnegative()),
  revision: z.number().check(z.int(), z.positive()),
}));
export type ReviewVerdictV1 = z.infer<typeof ReviewVerdictV1Schema>;

/** Non-content facts consumed by Triage; title/prose remain with the opened Review. */
export const ReviewNeedsYouV1Schema = lazyZodSchema(() => z.strictObject({
  reviewId: z.string().check(z.minLength(1)),
  roundOrdinal: z.number().check(z.int(), z.positive()),
  reason: z.literal('review_needs_you'),
  needsYou: z.boolean(),
  requestedVerdict: z.boolean(),
  pendingDecisions: z.boolean(),
  canSubmitVerdict: z.boolean(),
}));
export type ReviewNeedsYouV1 = z.infer<typeof ReviewNeedsYouV1Schema>;

export const ReviewHumanStateV1Schema = lazyZodSchema(() => z.strictObject({
  reviewId: z.string().check(z.minLength(1)),
  roundOrdinal: z.number().check(z.int(), z.positive()),
  requests: z.array(ReviewRequestedReviewerV1Schema),
  verdicts: z.array(ReviewVerdictV1Schema),
  needsYou: ReviewNeedsYouV1Schema,
}));
export type ReviewHumanStateV1 = z.infer<typeof ReviewHumanStateV1Schema>;

/** Bind answering-person prose before the Artifact codec seals the HTTP payload. */
export async function prepareReviewVerdictTransportInputV1(input: ReviewVerdictActionInputV1, context: Readonly<{
  accountId: string;
  state: ReviewHumanStateV1;
  seal: (value: ReviewVerdictContentV1) => Promise<StoredJsonContentEnvelope>;
}>): Promise<ReviewVerdictSubmitInputV1> {
  const { body, ...verdict } = input;
  if (body === undefined) return verdict;
  const revision = context.state.verdicts.find(row => row.roundOrdinal === input.roundOrdinal && row.accountId === context.accountId)?.revision ?? 0;
  return { ...verdict, expectedRevision: revision,
    content: await context.seal({ reviewId: input.reviewId, roundOrdinal: input.roundOrdinal,
      accountId: context.accountId, revision: revision + 1, body }) };
}

/** Review-owned classification; consumers never infer attention from finding/verdict rows. */
export function projectReviewNeedsYouV1(input: Readonly<{
  reviewId: string;
  roundOrdinal: number;
  actorAccountId: string;
  canRead: boolean;
  canDecide: boolean;
  pendingDecisionCount: number;
  requests: readonly Readonly<{ roundOrdinal: number; eligibleAccountIds: readonly string[] }>[];
  verdicts: readonly Pick<ReviewVerdictV1, 'roundOrdinal' | 'accountId'>[];
}>): ReviewNeedsYouV1 {
  const submitted = new Set(input.verdicts.filter(verdict => verdict.roundOrdinal === input.roundOrdinal).map(verdict => verdict.accountId));
  const ownRequests = input.canRead
    ? input.requests.filter(request => request.roundOrdinal === input.roundOrdinal && request.eligibleAccountIds.includes(input.actorAccountId))
    : [];
  const requestedVerdict = ownRequests.some(request => !request.eligibleAccountIds.some(accountId => submitted.has(accountId)));
  const pendingDecisions = input.canRead && input.canDecide && input.pendingDecisionCount > 0;
  return { reviewId: input.reviewId, roundOrdinal: input.roundOrdinal, reason: 'review_needs_you',
    needsYou: requestedVerdict || pendingDecisions, requestedVerdict, pendingDecisions,
    canSubmitVerdict: ownRequests.length > 0 };
}

export const ReviewHumanGetInputV1Schema = lazyZodSchema(() => z.strictObject({
  reviewId: z.string().check(z.minLength(1)),
}));
export const ReviewHumanErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'review_invalid_request', 'review_not_found', 'review_access_forbidden', 'review_round_not_admitted',
  'review_request_duplicate', 'review_reviewer_not_requested',
  'review_verdict_content_unavailable', 'review_verdict_encryption_mode_mismatch',
  'review_verdict_content_mismatch', 'review_verdict_revision_mismatch', 'present_user_required',
]));
export type ReviewHumanErrorCodeV1 = z.infer<typeof ReviewHumanErrorCodeV1Schema>;
export const ReviewHumanErrorV1Schema = lazyZodSchema(() => z.strictObject({ error: ReviewHumanErrorCodeV1Schema }));
export const ReviewOpenedVerdictV1Schema = lazyZodSchema(() => z.extend(
  z.omit(ReviewVerdictV1Schema, { content: true }), { body: z.optional(z.string()) },
));
export const ReviewHumanActionStateV1Schema = lazyZodSchema(() => z.extend(ReviewHumanStateV1Schema, {
  verdicts: z.array(ReviewOpenedVerdictV1Schema),
}));
export type ReviewHumanActionStateV1 = z.infer<typeof ReviewHumanActionStateV1Schema>;
