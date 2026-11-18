import { z } from '../zodRuntimePolicy.js';
import { REVIEW_ARTIFACT_KIND_V1 } from '../artifacts/artifactKindV1.js';
import { projectReviewRoundOutcomeV1, type ReviewReviewerOutcomeV1 } from './reviewPublicationEvidence.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ExternalActionTargetV1Schema } from '../actions/externalActionApi.js';
import { ScmComparisonCaptureInputSchema } from '../scm/diffSummary.js';
export { REVIEW_ARTIFACT_KIND_V1 } from '../artifacts/artifactKindV1.js';

export const ReviewSubjectKindV1Schema = z.enum(['comparison', 'pull_request', 'repository']);
export const ReviewSourceKindV1Schema = z.enum(['direct', 'workflow']);
export const ReviewRoundStateV1Schema = z.enum(['running', 'completed', 'partial', 'failed', 'cancelled']);
export type ReviewSubjectKindV1 = z.infer<typeof ReviewSubjectKindV1Schema>;
export type ReviewSourceKindV1 = z.infer<typeof ReviewSourceKindV1Schema>;
export type ReviewRoundStateV1 = z.infer<typeof ReviewRoundStateV1Schema>;
export const ReviewRoundBindingV1Schema = z.strictObject({ reviewId: z.string(), roundOrdinal: z.number().check(z.int(), z.minimum(1)) });
export type ReviewRoundBindingV1 = z.infer<typeof ReviewRoundBindingV1Schema>;
/** The original SCM address, sealed with the round; opening it never captures current code. */
export const ReviewRoundComparisonCaptureV1Schema = lazyZodSchema(() => z.strictObject({
  target: ExternalActionTargetV1Schema._zod.def.options[0],
  input: z.safeExtend(ScmComparisonCaptureInputSchema, {
    comparisonId: z.nonoptional(ScmComparisonCaptureInputSchema.shape.comparisonId),
    projection: z.optional(z.never()),
  }),
}));
export type ReviewRoundComparisonCaptureV1 = z.infer<typeof ReviewRoundComparisonCaptureV1Schema>;
export const ReviewRunReferenceV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execution'), runId: z.string(), machineId: z.string(), sessionId: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('workflow'), runId: z.string() }),
]);
export type ReviewRunReferenceV1 = z.infer<typeof ReviewRunReferenceV1Schema>;
export const ReviewMetadataV1Schema = z.strictObject({
  projectSourceId: z.nullable(z.string()), workflowId: z.nullable(z.string()),
  subjectKind: ReviewSubjectKindV1Schema, sourceKind: ReviewSourceKindV1Schema,
  state: ReviewRoundStateV1Schema, currentRoundOrdinal: z.number().check(z.int(), z.minimum(1)),
  startedAt: z.number(), finishedAt: z.nullable(z.number()),
});
export type ReviewMetadataV1 = z.infer<typeof ReviewMetadataV1Schema>;
export const ReviewRoundSettlementMetadataV1Schema = z.strictObject({
  currentRoundOrdinal: z.number().check(z.int(), z.minimum(1)),
  state: z.enum(['completed', 'partial', 'failed', 'cancelled']), finishedAt: z.number(),
});
export const ReviewRoundStartMetadataV1Schema = z.strictObject({ ...ReviewMetadataV1Schema.shape, state: z.literal('running'), finishedAt: z.null() });
/** Explicit non-content mutation projection; settlement cannot overwrite source identity. */
export const ReviewMetadataWriteV1Schema = z.union([ReviewRoundStartMetadataV1Schema, ReviewRoundSettlementMetadataV1Schema]);
export type ReviewMetadataWriteV1 = z.infer<typeof ReviewMetadataWriteV1Schema>;
export const ReviewArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(REVIEW_ARTIFACT_KIND_V1), v: z.literal(1),
  reviewId: z.string(), title: z.string() });
export const ReviewArtifactBodyV1Schema = z.strictObject({ v: z.literal(1), rounds: z.array(z.strictObject({
  ordinal: z.number().check(z.int(), z.minimum(1)), comparisonId: z.optional(z.string()),
  comparisonCapture: z.optional(ReviewRoundComparisonCaptureV1Schema),
  state: ReviewRoundStateV1Schema, startedAt: z.number(), finishedAt: z.nullable(z.number()),
  reviewerIds: z.array(z.string()), runs: z.array(ReviewRunReferenceV1Schema),
  summary: z.optional(z.string()),
})) });
export type ReviewArtifactBodyV1 = z.infer<typeof ReviewArtifactBodyV1Schema>;
export type ReviewArtifactV1 = Readonly<z.infer<typeof ReviewArtifactHeaderV1Schema> & ReviewArtifactBodyV1>;

type Revision = Readonly<{ headerVersion: number; bodyVersion: number }>;
type Opened = Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body: unknown; revision: Revision }>;
export interface ReviewArtifactTransportV1 {
  read(artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<Opened | null>;
  create(input: Readonly<{ artifactId: string; header: Readonly<Record<string, unknown>>; body: string; reviewMetadata: ReviewMetadataWriteV1; signal?: AbortSignal }>): Promise<Opened>;
  update(input: Readonly<{ artifactId: string; expectedRevision: Revision; header: Readonly<Record<string, unknown>>; body: string; reviewMetadata: ReviewMetadataWriteV1; signal?: AbortSignal }>): Promise<Readonly<{ ok: true; revision: Revision } | { ok: false; errorCode: string }>>;
}
export type ReviewRoundStartV1 = Readonly<{ reviewId: string; title: string; subjectKind: ReviewSubjectKindV1;
  sourceKind: ReviewSourceKindV1; projectSourceId?: string; workflowId?: string; comparisonId?: string;
  comparisonCapture?: ReviewRoundComparisonCaptureV1;
  reviewerIds: readonly string[]; startedAt: number; newRound?: boolean; signal?: AbortSignal }>;
export type ReviewRoundSettlementV1 = Readonly<ReviewRoundBindingV1 & {
  outcome: Exclude<ReviewRoundStateV1, 'running'>; finishedAt: number; runs: readonly ReviewRunReferenceV1[];
  reviewerOutcomes?: readonly ReviewReviewerOutcomeV1[];
  summary?: string; signal?: AbortSignal }>;
export type ReviewRecordPortV1 = ReturnType<typeof createReviewRecordPortV1>;

/** Opens one Review Artifact row (header + sealed body) into its record; every reader uses this one decoder. */
export function openReviewArtifactV1(row: Omit<Opened, 'revision'>): ReviewArtifactV1 {
  const header = ReviewArtifactHeaderV1Schema.parse(row.header);
  if (header.reviewId !== row.artifactId || typeof row.body !== 'string') refused('artifact_content_unavailable');
  return { ...header, ...ReviewArtifactBodyV1Schema.parse(JSON.parse(row.body)) };
}
function content(record: ReviewArtifactV1) {
  const { rounds, ...header } = record;
  return { header, body: JSON.stringify({ v: 1, rounds }) };
}
function refused(code: string): never { throw Object.assign(new Error(code), { code }); }

/** Seals one start and one whole-round terminal projection over the existing Artifact CAS.
 * Native/workflow lifecycle owners supply the outcome; the server relation owns current state.
 */
export function createReviewRecordPortV1(transport: ReviewArtifactTransportV1) {
  return {
    async read(reviewId: string, signal?: AbortSignal): Promise<ReviewArtifactV1 | null> {
      const row = await transport.read(reviewId, { signal });
      return row ? openReviewArtifactV1(row) : null;
    },
    async start(input: ReviewRoundStartV1): Promise<ReviewRoundBindingV1> {
      input.signal?.throwIfAborted();
      const row = await transport.read(input.reviewId, { signal: input.signal });
      const previous = row ? openReviewArtifactV1(row) : null;
      const lastOrdinal = previous?.rounds.at(-1)?.ordinal ?? 0;
      if (previous && !input.newRound) return { reviewId: input.reviewId, roundOrdinal: lastOrdinal };
      const ordinal = lastOrdinal + 1;
      const comparisonId = input.comparisonCapture?.input.comparisonId ?? input.comparisonId;
      const reviewMetadata: ReviewMetadataWriteV1 = { projectSourceId: input.projectSourceId ?? null,
        workflowId: input.workflowId ?? null, subjectKind: input.subjectKind, sourceKind: input.sourceKind,
        state: 'running', currentRoundOrdinal: ordinal, startedAt: input.startedAt, finishedAt: null };
      const next: ReviewArtifactV1 = { kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: input.reviewId,
        title: previous?.title ?? input.title, rounds: [...previous?.rounds ?? [], { ordinal,
          ...(comparisonId ? { comparisonId } : {}),
          ...(input.comparisonCapture ? { comparisonCapture: input.comparisonCapture } : {}), state: 'running', startedAt: input.startedAt,
          finishedAt: null, reviewerIds: [...input.reviewerIds], runs: [] }] };
      if (!row) await transport.create({ artifactId: input.reviewId, ...content(next), reviewMetadata, signal: input.signal });
      else {
        const result = await transport.update({ artifactId: input.reviewId, expectedRevision: row.revision, ...content(next), reviewMetadata, signal: input.signal });
        if (!result.ok) refused(result.errorCode);
      }
      return { reviewId: input.reviewId, roundOrdinal: ordinal };
    },
    async settle(input: ReviewRoundSettlementV1): Promise<void> {
      input.signal?.throwIfAborted();
      const row = await transport.read(input.reviewId, { signal: input.signal });
      if (!row) refused('artifact_not_found');
      const current = openReviewArtifactV1(row);
      const round = current.rounds.find(item => item.ordinal === input.roundOrdinal);
      if (!round) refused('invalid-params');
      if (round.state !== 'running') return;
      const outcome = input.outcome !== 'cancelled' && input.outcome !== 'failed'
        ? projectReviewRoundOutcomeV1(round.reviewerIds, input.reviewerOutcomes ?? []) : input.outcome;
      const nextRound = { ...round, state: outcome, finishedAt: input.finishedAt, runs: [...input.runs],
        ...(input.summary === undefined ? {} : { summary: input.summary }) };
      const next = { ...current, rounds: current.rounds.map(item => item === round ? nextRound : item) };
      const reviewMetadata: ReviewMetadataWriteV1 = { currentRoundOrdinal: input.roundOrdinal, state: outcome, finishedAt: input.finishedAt };
      const result = await transport.update({ artifactId: input.reviewId, expectedRevision: row.revision, ...content(next), reviewMetadata, signal: input.signal });
      if (!result.ok) refused(result.errorCode);
    },
  };
}
