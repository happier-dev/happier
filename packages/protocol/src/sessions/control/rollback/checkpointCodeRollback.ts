import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionRollbackCodeModeSchema = lazyZodSchema(() => z.enum([
  'conversation_only',
  'conversation_and_code_with_stash',
  'conversation_and_code_without_stash',
  'code_only_with_stash',
  'code_only_without_stash',
]));
export type SessionRollbackCodeMode = z.infer<typeof SessionRollbackCodeModeSchema>;

export const CheckpointCodeRollbackBackupModeSchema = lazyZodSchema(() => z.enum([
  'happier_checkpoint_only',
  'happier_checkpoint_and_git_stash',
]));
export type CheckpointCodeRollbackBackupMode = z.infer<typeof CheckpointCodeRollbackBackupModeSchema>;

export const CheckpointCodeRollbackReceiptIdSchema = lazyZodSchema(() => z.enum([
  'checkpoint.rollback_backup_captured',
  'checkpoint.rollback_applied',
  'checkpoint.rollback_conflict',
  'checkpoint.rollback_aborted',
]));
export type CheckpointCodeRollbackReceiptId = z.infer<typeof CheckpointCodeRollbackReceiptIdSchema>;

export const CHECKPOINT_CODE_ROLLBACK_RECEIPT_IDS = {
  backupCaptured: 'checkpoint.rollback_backup_captured',
  applied: 'checkpoint.rollback_applied',
  conflict: 'checkpoint.rollback_conflict',
  aborted: 'checkpoint.rollback_aborted',
} as const satisfies Record<string, CheckpointCodeRollbackReceiptId>;

export const CheckpointCodeRollbackRequestSchema = lazyZodSchema(() => z.strictObject({
    v: z._default(z.literal(1), 1),
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    turnId: z.string().check(z.trim(), z.minLength(1)),
    cwd: z.string().check(z.trim(), z.minLength(1)),
    codeMode: SessionRollbackCodeModeSchema,
    backupMode: CheckpointCodeRollbackBackupModeSchema,
    expectedStartRef: z.string().check(z.trim(), z.minLength(1)),
    expectedFinalRef: z.string().check(z.trim(), z.minLength(1)),
    codeOnlyTranscriptDivergenceConfirmed: z.optional(z.boolean()),
  }).check(z.superRefine((value, ctx) => {
    const stashMode = value.backupMode === 'happier_checkpoint_and_git_stash';
    const expectsStash = value.codeMode === 'conversation_and_code_with_stash' || value.codeMode === 'code_only_with_stash';
    if (stashMode !== expectsStash) {
      ctx.addIssue({
        code: "custom",
        path: ['backupMode'],
        message: 'backupMode must match the selected checkpoint rollback mode',
      });
    }

    const codeOnly = value.codeMode === 'code_only_with_stash' || value.codeMode === 'code_only_without_stash';
    if (codeOnly && value.codeOnlyTranscriptDivergenceConfirmed !== true) {
      ctx.addIssue({
        code: "custom",
        path: ['codeOnlyTranscriptDivergenceConfirmed'],
        message: 'Code-only checkpoint rollback requires explicit transcript divergence confirmation',
      });
    }
  })));
export type CheckpointCodeRollbackRequest = z.infer<typeof CheckpointCodeRollbackRequestSchema>;

export const CheckpointCodeRollbackActionRequestSchema = lazyZodSchema(() => CheckpointCodeRollbackRequestSchema.check(z.superRefine((value, ctx) => {
  if (value.codeMode !== 'code_only_with_stash' && value.codeMode !== 'code_only_without_stash') {
    ctx.addIssue({
      code: "custom",
      path: ['codeMode'],
      message: 'Checkpoint code rollback RPC only owns code-only modes; compose conversation rollback separately',
    });
  }
})));
export type CheckpointCodeRollbackActionRequest = z.infer<typeof CheckpointCodeRollbackActionRequestSchema>;

export const CheckpointCodeRollbackResultSchema = lazyZodSchema(() => z.strictObject({
    status: z.enum(['conversation_only', 'applied', 'conflict', 'unavailable', 'aborted']),
    backupCheckpointRef: z.optional(z.string().check(z.minLength(1))),
    gitStashRef: z.optional(z.string().check(z.minLength(1))),
    changedPaths: z.readonly(z.array(z.string().check(z.minLength(1)))),
    skippedPaths: z.readonly(z.array(z.string().check(z.minLength(1)))),
    receipts: z.readonly(z.array(CheckpointCodeRollbackReceiptIdSchema)),
    diagnostics: z.readonly(z.array(z.string().check(z.minLength(1)))),
  }));
export type CheckpointCodeRollbackResult = z.infer<typeof CheckpointCodeRollbackResultSchema>;
