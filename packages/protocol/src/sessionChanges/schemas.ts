import { z } from 'zod';

export const ChangeEvidenceSourceSchema = z.enum([
  'provider_native',
  'provider_tool',
  'canonical_diff_tool',
  'canonical_patch_tool',
  'scm_reconciled',
  'inferred',
]);

export const ChangeConfidenceSchema = z.enum(['exact', 'strong', 'best_effort']);

export const FileChangeKindSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'unknown',
]);

export const FileChangeEvidenceSchema = z.object({
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
  providerTurnId: z.string().min(1).nullable().optional(),
  providerMessageId: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
}).strict();

export const TurnChangeSetSchema = z.object({
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
}).strict();

export const SessionChangeSetFileSchema = FileChangeEvidenceSchema.extend({
  turns: z.array(z.string().min(1)),
}).strict();

export const ChangeSetConfidenceSummarySchema = z.object({
  source: ChangeEvidenceSourceSchema,
  confidence: ChangeConfidenceSchema,
}).strict();

export const SessionChangeSetSchema = z.object({
  sessionId: z.string().min(1),
  turns: z.array(TurnChangeSetSchema),
  files: z.array(SessionChangeSetFileSchema),
  rolledBackTurnIds: z.array(z.string().min(1)),
  confidenceSummary: ChangeSetConfidenceSummarySchema,
}).strict();

export const SessionWorkingTreeMatchedFileSchema = z.object({
  filePath: z.string().min(1),
  repositoryPath: z.string().min(1),
  sessionChange: SessionChangeSetFileSchema,
  repositoryEntry: z.object({
    path: z.string().min(1),
    previousPath: z.string().nullable(),
    kind: z.string().min(1),
  }).strict(),
}).strict();

export const SessionWorkingTreeProjectionSchema = z.object({
  sessionId: z.string().min(1),
  matchedFiles: z.array(SessionWorkingTreeMatchedFileSchema),
  unmatchedSessionFiles: z.array(SessionChangeSetFileSchema),
  repositoryOnlyFiles: z.array(z.object({
    path: z.string().min(1),
    previousPath: z.string().nullable(),
    kind: z.string().min(1),
  }).strict()),
  projectionReliability: ChangeConfidenceSchema,
}).strict();

export type ChangeEvidenceSource = z.infer<typeof ChangeEvidenceSourceSchema>;
export type ChangeConfidence = z.infer<typeof ChangeConfidenceSchema>;
export type FileChangeKind = z.infer<typeof FileChangeKindSchema>;
export type FileChangeEvidence = z.infer<typeof FileChangeEvidenceSchema>;
export type TurnChangeSet = z.infer<typeof TurnChangeSetSchema>;
export type SessionChangeSetFile = z.infer<typeof SessionChangeSetFileSchema>;
export type ChangeSetConfidenceSummary = z.infer<typeof ChangeSetConfidenceSummarySchema>;
export type SessionChangeSet = z.infer<typeof SessionChangeSetSchema>;
export type SessionWorkingTreeMatchedFile = z.infer<typeof SessionWorkingTreeMatchedFileSchema>;
export type SessionWorkingTreeProjection = z.infer<typeof SessionWorkingTreeProjectionSchema>;
