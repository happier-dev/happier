import { z } from 'zod';

import { ScmBackendPreferenceSchema } from './scm.js';

export const ScmDiffSummarySourceKindSchema = z.enum([
  'turnCheckpoint',
  'workingTree',
]);
export type ScmDiffSummarySourceKind =
  z.infer<typeof ScmDiffSummarySourceKindSchema>;

export const ScmDiffSummarySourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('turnCheckpoint'),
  }).passthrough(),
  z.object({
    kind: z.literal('workingTree'),
  }).passthrough(),
]);
export type ScmDiffSummarySource =
  z.infer<typeof ScmDiffSummarySourceSchema>;

export const ScmDiffSummaryModelSelectorSchema = z
  .object({
    profileId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    backendTargetKey: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .refine(
    (value) => Boolean(value.profileId || value.modelId || value.backendTargetKey),
    { message: 'modelSelector requires profileId, modelId, or backendTargetKey' },
  );
export type ScmDiffSummaryModelSelector =
  z.infer<typeof ScmDiffSummaryModelSelectorSchema>;

export const ScmDiffSummaryGenerateInputSchema = z
  .object({
    cwd: z.string().min(1),
    backendPreference: ScmBackendPreferenceSchema.optional(),
    source: ScmDiffSummarySourceSchema,
    turnId: z.string().min(1).optional(),
    checkpointReceiptId: z.string().min(1).optional(),
    modelSelector: ScmDiffSummaryModelSelectorSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      value.source.kind === 'turnCheckpoint' &&
      !value.turnId &&
      !value.checkpointReceiptId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'turnCheckpoint summaries must be resolved from a CHKPT-2 TurnChangeSet by turnId or checkpointReceiptId',
        path: ['checkpointReceiptId'],
      });
    }
    if (value.source.kind === 'workingTree' && value.checkpointReceiptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'workingTree summaries must not carry a checkpointReceiptId; use turnCheckpoint source for receipt-keyed cache lookup',
        path: ['checkpointReceiptId'],
      });
    }
  });
export type ScmDiffSummaryGenerateInput =
  z.infer<typeof ScmDiffSummaryGenerateInputSchema>;

export const ScmDiffSummaryTruncationReasonSchema = z.enum([
  'fileBudget',
  'diffBytes',
  'fileCount',
]);
export type ScmDiffSummaryTruncationReason =
  z.infer<typeof ScmDiffSummaryTruncationReasonSchema>;

export const ScmDiffSummaryTruncationSchema = z.object({
  reason: ScmDiffSummaryTruncationReasonSchema,
  droppedFiles: z.number().int().nonnegative().optional(),
}).passthrough();
export type ScmDiffSummaryTruncation =
  z.infer<typeof ScmDiffSummaryTruncationSchema>;

export const ScmDiffSummaryMetadataSchema = z.object({
  source: ScmDiffSummarySourceSchema,
  sourceKey: z.string().min(1),
  turnId: z.string().min(1).optional(),
  checkpointReceiptId: z.string().min(1).optional(),
  contentConfidence: z.enum(['exact', 'unavailable']).optional(),
  attributionScope: z.enum([
    'exclusive_worktree',
    'shared_worktree',
    'unknown',
  ]).optional(),
}).passthrough();
export type ScmDiffSummaryMetadata =
  z.infer<typeof ScmDiffSummaryMetadataSchema>;

export const ScmDiffSummaryErrorCodeSchema = z.enum([
  'TURN_CHANGE_SET_REQUIRED',
  'CHECKPOINT_NOT_FOUND',
  'CHECKPOINT_UNAVAILABLE',
  'DIFF_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'SUMMARY_FAILED',
]);
export type ScmDiffSummaryErrorCode =
  z.infer<typeof ScmDiffSummaryErrorCodeSchema>;

export const ScmDiffSummaryGenerateSuccessSchema = z.object({
  success: z.literal(true),
  summaryMarkdown: z.string().min(1),
  sourceKey: z.string().min(1),
  checkpointReceiptId: z.string().min(1).optional(),
  metadata: ScmDiffSummaryMetadataSchema,
  truncation: ScmDiffSummaryTruncationSchema.optional(),
  risks: z.array(z.string().min(1)).optional(),
  testImpact: z.string().min(1).optional(),
  suggestedPrBody: z.string().min(1).optional(),
}).passthrough();
export type ScmDiffSummaryGenerateSuccess =
  z.infer<typeof ScmDiffSummaryGenerateSuccessSchema>;

export const ScmDiffSummaryGenerateFailureSchema = z.object({
  success: z.literal(false),
  error: z.string().min(1),
  errorCode: ScmDiffSummaryErrorCodeSchema,
  sourceKey: z.string().min(1).optional(),
  checkpointReceiptId: z.string().min(1).optional(),
  metadata: ScmDiffSummaryMetadataSchema.optional(),
}).passthrough();
export type ScmDiffSummaryGenerateFailure =
  z.infer<typeof ScmDiffSummaryGenerateFailureSchema>;

export const ScmDiffSummaryGenerateOutputSchema = z.union([
  ScmDiffSummaryGenerateSuccessSchema,
  ScmDiffSummaryGenerateFailureSchema,
]);
export type ScmDiffSummaryGenerateOutput =
  z.infer<typeof ScmDiffSummaryGenerateOutputSchema>;
