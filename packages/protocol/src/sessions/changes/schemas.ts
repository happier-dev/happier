import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ScmCommitOidSchema } from '../../scm/commitPublication.js';

import {
  deriveSessionChangeAttributionFromSource,
  mergeCheckpointOverlap,
} from './mergeTurnChangeSets.js';

export const ChangeEvidenceSourceSchema = lazyZodSchema(() => z.enum([
  'provider_native',
  'provider_tool',
  'canonical_diff_tool',
  'canonical_patch_tool',
  'scm_checkpoint',
  'scm_reconciled',
  'inferred',
]));

export const ChangeConfidenceSchema = lazyZodSchema(() => z.enum(['exact', 'strong', 'best_effort']));

export const SessionAttributionConfidenceSchema = lazyZodSchema(() => z.enum([
  'session_exact',
  'session_likely',
  'session_possible',
  'unknown',
]));

export const SessionAttributionReasonSchema = lazyZodSchema(() => z.enum([
  'provider_correlated',
  'canonical_tool_correlated',
  'checkpoint_no_happier_overlap_observed',
  'checkpoint_overlap_observed',
  'workspace_touched_path',
  'unavailable',
]));

export const SessionChangeAttributionSchema = lazyZodSchema(() => z.object({
  confidence: SessionAttributionConfidenceSchema,
  reason: SessionAttributionReasonSchema,
}).strict());

export const CheckpointOverlapObservationSchema = lazyZodSchema(() => z.enum(['observed', 'not_observed', 'unknown']));

export const FileChangeKindSchema = lazyZodSchema(() => z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'unknown',
]));

const CanonicalFileChangeEvidenceSchema = lazyZodSchema(() => z.object({
  filePath: z.string().min(1),
  previousFilePath: z.string().min(1).nullable().optional(),
  changeKind: FileChangeKindSchema,
  unifiedDiff: z.string().min(1).nullable().optional(),
  oldText: z.string().nullable().optional(),
  newText: z.string().nullable().optional(),
  binary: z.boolean().optional(),
  source: ChangeEvidenceSourceSchema,
  confidence: ChangeConfidenceSchema,
  provider: z.string().min(1),
  agentTurnId: z.string().min(1).nullable().optional(),
  providerMessageId: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  truncated: z.literal(true).optional(),
  stats: z.object({
    oldTextBytes: z.number().int().nonnegative().optional(),
    newTextBytes: z.number().int().nonnegative().optional(),
    unifiedDiffBytes: z.number().int().nonnegative().optional(),
    addedLines: z.number().int().nonnegative().optional(),
    removedLines: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict());

/**
 * Prospective 0.2 input (b23f95ed, sessionChanges/schemas.ts) names this correlation
 * providerTurnId. Normalize at the evidence reader; current writers use agentTurnId.
 * Remove when predecessor-produced change sets are no longer supported inputs.
 */
function normalizePredecessorCorrelation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('providerTurnId' in value)) return value;
  const { providerTurnId, ...canonical } = value;
  // Invalid aliases remain present so the closed schema rejects them.
  if (providerTurnId !== null && (typeof providerTurnId !== 'string' || providerTurnId.length === 0)) return value;
  if ('agentTurnId' in canonical) {
    // Two names for one identity must agree. Preserve the alias on conflict so the closed schema
    // rejects the ambiguous input instead of silently granting correlation meaning to either value.
    return canonical.agentTurnId === providerTurnId ? canonical : value;
  }
  return { ...canonical, agentTurnId: providerTurnId };
}

export const FileChangeEvidenceSchema = lazyZodSchema(() => z.preprocess(normalizePredecessorCorrelation, CanonicalFileChangeEvidenceSchema));

export const RepositoryCheckpointReceiptIdSchema = lazyZodSchema(() => z.enum([
  'checkpoint.captured',
  'checkpoint.aliased',
  'checkpoint.finalized',
  'checkpoint.diff_computed',
  'checkpoint.cleanup_pruned',
]));

export const RepositoryCheckpointReceiptSchema = lazyZodSchema(() => z.object({
  id: RepositoryCheckpointReceiptIdSchema,
  ref: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
  treeSha: z.string().min(1).optional(),
  phase: z.enum(['message-start', 'turn-start', 'turn-final']).optional(),
  prunedCount: z.number().int().nonnegative().optional(),
  refs: z.array(z.string().min(1)).optional(),
}).strict());

export const RepositoryCheckpointTurnMetadataSchema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  scopeId: z.string().min(1),
  startRef: z.string().min(1).optional(),
  finalRef: z.string().min(1).optional(),
  baseRefSource: z.enum(['turn_start', 'message_start', 'previous_final', 'unavailable']),
  contentConfidence: z.enum(['exact', 'unavailable']),
  attributionScope: z.enum(['no_happier_checkpoint_overlap_observed', 'shared_worktree', 'unknown']),
  receipts: z.array(RepositoryCheckpointReceiptSchema),
  unavailableReason: z.string().min(1).optional(),
}).strict());

export const TurnChangeSetSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  seqRange: z.object({
    startSeqInclusive: z.number().int().nonnegative(),
    endSeqInclusive: z.number().int().nonnegative(),
  }).refine((value) => value.endSeqInclusive >= value.startSeqInclusive, {
    path: ['endSeqInclusive'],
    message: 'endSeqInclusive must be greater than or equal to startSeqInclusive',
  }),
  status: z.enum(['completed', 'aborted', 'interrupted', 'unknown']),
  files: z.array(FileChangeEvidenceSchema),
  provider: z.string().min(1),
  derivedAt: z.number().finite(),
  repositoryCheckpoint: RepositoryCheckpointTurnMetadataSchema.optional(),
}).strict());

/** Read-only content correspondence; it does not grant authorship or Session access. */
export const RepositoryCheckpointCommitEvidenceSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  repositoryKey: z.string().min(1),
  checkpointRef: z.string().min(1),
  checkpointCommitSha: ScmCommitOidSchema,
  commitSha: ScmCommitOidSchema,
  attributionScope: RepositoryCheckpointTurnMetadataSchema.shape.attributionScope,
}).strict());

function normalizeLegacySessionChangeSetFile(value: unknown): unknown {
  const correlated = normalizePredecessorCorrelation(value);
  if (!correlated || typeof correlated !== 'object' || Array.isArray(correlated)) return correlated;
  const file = correlated as Record<string, unknown>;
  const sourceParse = ChangeEvidenceSourceSchema.safeParse(file.source);
  if (!sourceParse.success) return correlated;
  const checkpointOverlapParse = CheckpointOverlapObservationSchema.safeParse(file.checkpointOverlap);
  const checkpointOverlap = checkpointOverlapParse.success ? checkpointOverlapParse.data : 'unknown';
  return {
    ...file,
    ...(file.attribution === undefined
      ? { attribution: deriveSessionChangeAttributionFromSource(sourceParse.data, checkpointOverlap) }
      : {}),
    ...(file.checkpointOverlap === undefined ? { checkpointOverlap } : {}),
  };
}

export const SessionChangeSetFileSchema = lazyZodSchema(() => z.preprocess(normalizeLegacySessionChangeSetFile, CanonicalFileChangeEvidenceSchema.extend({
  turns: z.array(z.string().min(1)),
  attribution: SessionChangeAttributionSchema,
  checkpointOverlap: CheckpointOverlapObservationSchema,
}).strict()));

export const ChangeSetConfidenceSummarySchema = lazyZodSchema(() => z.object({
  source: z.union([ChangeEvidenceSourceSchema, z.literal('unavailable')]),
  confidence: z.union([ChangeConfidenceSchema, z.literal('unavailable')]),
  attribution: SessionChangeAttributionSchema,
  checkpointOverlap: CheckpointOverlapObservationSchema,
}).strict());

const CanonicalSessionChangeSetSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  turns: z.array(TurnChangeSetSchema),
  files: z.array(SessionChangeSetFileSchema),
  rolledBackTurnIds: z.array(z.string().min(1)),
  confidenceSummary: ChangeSetConfidenceSummarySchema,
}).strict());

function normalizeLegacySessionChangeSet(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.files) || !input.confidenceSummary || typeof input.confidenceSummary !== 'object') {
    return value;
  }
  const files = input.files.map(normalizeLegacySessionChangeSetFile);
  const summary = input.confidenceSummary as Record<string, unknown>;
  const truthfulSummary = files.length === 0
    ? { ...summary, source: 'unavailable', confidence: 'unavailable' }
    : summary;
  if (summary.attribution !== undefined && summary.checkpointOverlap !== undefined) {
    return { ...input, files, confidenceSummary: truthfulSummary };
  }
  const normalizedFiles = files.filter((file): file is Record<string, unknown> => (
    Boolean(file) && typeof file === 'object' && !Array.isArray(file)
  ));
  let attribution: z.infer<typeof SessionChangeAttributionSchema> | null = null;
  let checkpointOverlap: 'observed' | 'not_observed' | 'unknown' | null = null;
  const attributionRank = { session_exact: 0, session_likely: 1, session_possible: 2, unknown: 3 } as const;
  for (const file of normalizedFiles) {
    const parsedAttribution = SessionChangeAttributionSchema.safeParse(file.attribution);
    if (parsedAttribution.success && (
      attribution === null
      || attributionRank[parsedAttribution.data.confidence] > attributionRank[attribution.confidence]
    )) {
      attribution = parsedAttribution.data;
    }
    const parsedOverlap = CheckpointOverlapObservationSchema.safeParse(file.checkpointOverlap);
    if (parsedOverlap.success) {
      checkpointOverlap = checkpointOverlap === null
        ? parsedOverlap.data
        : mergeCheckpointOverlap(checkpointOverlap, parsedOverlap.data);
    }
  }
  return {
    ...input,
    files,
    confidenceSummary: {
      ...truthfulSummary,
      ...(summary.attribution === undefined
        ? { attribution: attribution ?? { confidence: 'unknown', reason: 'unavailable' } }
        : {}),
      ...(summary.checkpointOverlap === undefined ? { checkpointOverlap: checkpointOverlap ?? 'unknown' } : {}),
    },
  };
}

export const SessionChangeSetSchema = lazyZodSchema(() => z.preprocess(normalizeLegacySessionChangeSet, CanonicalSessionChangeSetSchema));

export const SessionWorkingTreeMatchedFileSchema = lazyZodSchema(() => z.object({
  filePath: z.string().min(1),
  repositoryPath: z.string().min(1),
  sessionChange: SessionChangeSetFileSchema,
  repositoryEntry: z.object({
    path: z.string().min(1),
    previousPath: z.string().nullable(),
    kind: z.string().min(1),
  }).strict(),
}).strict());

export const SessionWorkingTreeProjectionSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  matchedFiles: z.array(SessionWorkingTreeMatchedFileSchema),
  unmatchedSessionFiles: z.array(SessionChangeSetFileSchema),
  repositoryOnlyFiles: z.array(z.object({
    path: z.string().min(1),
    previousPath: z.string().nullable(),
    kind: z.string().min(1),
  }).strict()),
  projectionReliability: ChangeConfidenceSchema,
}).strict());

export type ChangeEvidenceSource = z.infer<typeof ChangeEvidenceSourceSchema>;
export type ChangeConfidence = z.infer<typeof ChangeConfidenceSchema>;
export type SessionAttributionConfidence = z.infer<typeof SessionAttributionConfidenceSchema>;
export type SessionAttributionReason = z.infer<typeof SessionAttributionReasonSchema>;
export type SessionChangeAttribution = z.infer<typeof SessionChangeAttributionSchema>;
export type CheckpointOverlapObservation = z.infer<typeof CheckpointOverlapObservationSchema>;
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;
export type FileChangeEvidence = z.infer<typeof FileChangeEvidenceSchema>;
export type RepositoryCheckpointReceipt = z.infer<typeof RepositoryCheckpointReceiptSchema>;
export type RepositoryCheckpointTurnMetadata = z.infer<typeof RepositoryCheckpointTurnMetadataSchema>;
export type TurnChangeSet = z.infer<typeof TurnChangeSetSchema>;
export type SessionChangeSetFile = z.infer<typeof SessionChangeSetFileSchema>;
export type ChangeSetConfidenceSummary = z.infer<typeof ChangeSetConfidenceSummarySchema>;
export type SessionChangeSet = z.infer<typeof SessionChangeSetSchema>;
export type SessionWorkingTreeMatchedFile = z.infer<typeof SessionWorkingTreeMatchedFileSchema>;
export type SessionWorkingTreeProjection = z.infer<typeof SessionWorkingTreeProjectionSchema>;
