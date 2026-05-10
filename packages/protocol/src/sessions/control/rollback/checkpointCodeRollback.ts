import { z } from 'zod';

export const SessionRollbackCodeModeSchema = z.enum([
  'conversation_only',
  'conversation_and_code_with_stash',
  'conversation_and_code_without_stash',
  'code_only_with_stash',
  'code_only_without_stash',
]);
export type SessionRollbackCodeMode = z.infer<typeof SessionRollbackCodeModeSchema>;

export const CheckpointCodeRollbackBackupModeSchema = z.enum([
  'happier_checkpoint_only',
  'happier_checkpoint_and_git_stash',
]);
export type CheckpointCodeRollbackBackupMode = z.infer<typeof CheckpointCodeRollbackBackupModeSchema>;

export const CheckpointCodeRollbackReceiptIdSchema = z.enum([
  'checkpoint.rollback_backup_captured',
  'checkpoint.rollback_applied',
  'checkpoint.rollback_conflict',
  'checkpoint.rollback_aborted',
]);
export type CheckpointCodeRollbackReceiptId = z.infer<typeof CheckpointCodeRollbackReceiptIdSchema>;

export const CHECKPOINT_CODE_ROLLBACK_RECEIPT_IDS = {
  backupCaptured: 'checkpoint.rollback_backup_captured',
  applied: 'checkpoint.rollback_applied',
  conflict: 'checkpoint.rollback_conflict',
  aborted: 'checkpoint.rollback_aborted',
} as const satisfies Record<string, CheckpointCodeRollbackReceiptId>;

export const CheckpointCodeRollbackRequestSchema = z
  .object({
    v: z.literal(1).default(1),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1),
    cwd: z.string().trim().min(1),
    codeMode: SessionRollbackCodeModeSchema,
    backupMode: CheckpointCodeRollbackBackupModeSchema,
    expectedStartRef: z.string().trim().min(1),
    expectedFinalRef: z.string().trim().min(1),
    codeOnlyTranscriptDivergenceConfirmed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const stashMode = value.backupMode === 'happier_checkpoint_and_git_stash';
    const expectsStash = value.codeMode === 'conversation_and_code_with_stash' || value.codeMode === 'code_only_with_stash';
    if (stashMode !== expectsStash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backupMode'],
        message: 'backupMode must match the selected checkpoint rollback mode',
      });
    }

    const codeOnly = value.codeMode === 'code_only_with_stash' || value.codeMode === 'code_only_without_stash';
    if (codeOnly && value.codeOnlyTranscriptDivergenceConfirmed !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['codeOnlyTranscriptDivergenceConfirmed'],
        message: 'Code-only checkpoint rollback requires explicit transcript divergence confirmation',
      });
    }
  });
export type CheckpointCodeRollbackRequest = z.infer<typeof CheckpointCodeRollbackRequestSchema>;

export const CheckpointCodeRollbackActionRequestSchema = CheckpointCodeRollbackRequestSchema.superRefine((value, ctx) => {
  if (value.codeMode !== 'code_only_with_stash' && value.codeMode !== 'code_only_without_stash') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['codeMode'],
      message: 'Checkpoint code rollback RPC only owns code-only modes; compose conversation rollback separately',
    });
  }
});
export type CheckpointCodeRollbackActionRequest = z.infer<typeof CheckpointCodeRollbackActionRequestSchema>;

export const CheckpointCodeRollbackResultSchema = z
  .object({
    status: z.enum(['conversation_only', 'applied', 'conflict', 'unavailable', 'aborted']),
    backupCheckpointRef: z.string().min(1).optional(),
    gitStashRef: z.string().min(1).optional(),
    changedPaths: z.array(z.string().min(1)).readonly(),
    skippedPaths: z.array(z.string().min(1)).readonly(),
    receipts: z.array(CheckpointCodeRollbackReceiptIdSchema).readonly(),
    diagnostics: z.array(z.string().min(1)).readonly(),
  })
  .strict();
export type CheckpointCodeRollbackResult = z.infer<typeof CheckpointCodeRollbackResultSchema>;
