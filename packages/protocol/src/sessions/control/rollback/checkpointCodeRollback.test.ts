import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_CODE_ROLLBACK_RECEIPT_IDS,
  CheckpointCodeRollbackRequestSchema,
  CheckpointCodeRollbackResultSchema,
} from './checkpointCodeRollback.js';

const baseRequest = {
  v: 1,
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd: '/repo',
  expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
  expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
} as const;

describe('CheckpointCodeRollbackRequestSchema', () => {
  it('accepts all ratified rollback modes with matching backup invariants', () => {
    const modes = [
      ['conversation_only', 'happier_checkpoint_only', undefined],
      ['conversation_and_code_with_stash', 'happier_checkpoint_and_git_stash', undefined],
      ['conversation_and_code_without_stash', 'happier_checkpoint_only', undefined],
      ['code_only_with_stash', 'happier_checkpoint_and_git_stash', true],
      ['code_only_without_stash', 'happier_checkpoint_only', true],
    ] as const;

    for (const [codeMode, backupMode, codeOnlyTranscriptDivergenceConfirmed] of modes) {
      expect(CheckpointCodeRollbackRequestSchema.safeParse({
        ...baseRequest,
        codeMode,
        backupMode,
        ...(codeOnlyTranscriptDivergenceConfirmed ? { codeOnlyTranscriptDivergenceConfirmed } : {}),
      }).success).toBe(true);
    }
  });

  it('rejects code-only requests unless transcript divergence is explicitly confirmed', () => {
    const parsed = CheckpointCodeRollbackRequestSchema.safeParse({
      ...baseRequest,
      codeMode: 'code_only_without_stash',
      backupMode: 'happier_checkpoint_only',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('codeOnlyTranscriptDivergenceConfirmed');
    }
  });

  it('rejects no-stash and stash backup mode mismatches', () => {
    expect(CheckpointCodeRollbackRequestSchema.safeParse({
      ...baseRequest,
      codeMode: 'conversation_and_code_without_stash',
      backupMode: 'happier_checkpoint_and_git_stash',
    }).success).toBe(false);

    expect(CheckpointCodeRollbackRequestSchema.safeParse({
      ...baseRequest,
      codeMode: 'conversation_and_code_with_stash',
      backupMode: 'happier_checkpoint_only',
    }).success).toBe(false);
  });
});

describe('CheckpointCodeRollbackResultSchema', () => {
  it('limits receipts to the FD-0058 predeclared receipt ids', () => {
    expect(CHECKPOINT_CODE_ROLLBACK_RECEIPT_IDS).toEqual({
      backupCaptured: 'checkpoint.rollback_backup_captured',
      applied: 'checkpoint.rollback_applied',
      conflict: 'checkpoint.rollback_conflict',
      aborted: 'checkpoint.rollback_aborted',
    });

    expect(CheckpointCodeRollbackResultSchema.safeParse({
      status: 'applied',
      backupCheckpointRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/rollback-backup/rollback-1',
      changedPaths: ['tracked.txt'],
      skippedPaths: [],
      receipts: ['checkpoint.rollback_backup_captured', 'checkpoint.rollback_applied'],
      diagnostics: [],
    }).success).toBe(true);

    expect(CheckpointCodeRollbackResultSchema.safeParse({
      status: 'applied',
      changedPaths: [],
      skippedPaths: [],
      receipts: ['checkpoint.rollback_custom'],
      diagnostics: [],
    }).success).toBe(false);
  });
});
