import { describe, expect, it } from 'vitest';

import { CHECKPOINT_ROLLBACK_RECEIPT_IDS, planCheckpointCodeRollback } from './plan';

const baseRequest = {
    v: 1,
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/repo',
    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
} as const;

describe('planCheckpointCodeRollback', () => {
    it('keeps conversation-only rollback out of code mutation paths', () => {
        const plan = planCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'conversation_only',
                backupMode: 'happier_checkpoint_only',
            },
            conversationRollbackSupported: true,
        });

        expect(plan.status).toBe('unavailable');
        expect(plan.requiresConversationRollback).toBe(true);
        expect(plan.requiresCodeRollback).toBe(false);
        expect(plan.requiresBackupCheckpoint).toBe(false);
        expect(plan.requiresGitStash).toBe(false);
        expect(plan.diagnostics).toContain('checkpoint_code_rollback_requires_code_only_mode');
    });

    it('rejects conversation-plus-code because conversation rollback composition is not owned by code rollback', () => {
        const plan = planCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'conversation_and_code_without_stash',
                backupMode: 'happier_checkpoint_only',
            },
            conversationRollbackSupported: false,
        });

        expect(plan.status).toBe('unavailable');
        expect(plan.requiresCodeRollback).toBe(false);
        expect(plan.diagnostics).toContain('checkpoint_code_rollback_requires_code_only_mode');
    });

    it('requires a hidden backup checkpoint even when Git stash is not selected', () => {
        const plan = planCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            conversationRollbackSupported: false,
        });

        expect(plan.status).toBe('ready');
        expect(plan.requiresConversationRollback).toBe(false);
        expect(plan.requiresCodeRollback).toBe(true);
        expect(plan.requiresBackupCheckpoint).toBe(true);
        expect(plan.requiresGitStash).toBe(false);
    });

    it('declares only the packet-owned rollback receipt ids', () => {
        expect(CHECKPOINT_ROLLBACK_RECEIPT_IDS).toEqual({
            backupCaptured: 'checkpoint.rollback_backup_captured',
            applied: 'checkpoint.rollback_applied',
            conflict: 'checkpoint.rollback_conflict',
            aborted: 'checkpoint.rollback_aborted',
        });
    });
});
