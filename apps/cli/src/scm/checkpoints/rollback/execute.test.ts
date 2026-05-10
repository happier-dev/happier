import { describe, expect, it, vi } from 'vitest';

import { executeCheckpointCodeRollback } from './execute';
import type { CheckpointRollbackOrchestrationDependencies } from './types';

const baseRequest = {
    v: 1,
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/repo',
    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
} as const;

describe('executeCheckpointCodeRollback', () => {
    it('rejects conversation-composition modes before code rollback mutation dependencies run', async () => {
        const captureBackup: CheckpointRollbackOrchestrationDependencies['captureBackup'] = vi.fn(async () => ({
            success: true as const,
            backupCheckpointRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/rollback-backup/rollback-1',
            receipts: ['checkpoint.rollback_backup_captured' as const],
        }));
        const createStash: NonNullable<CheckpointRollbackOrchestrationDependencies['createStash']> = vi.fn(async () => ({
            success: true as const,
            gitStashRef: 'stash@{0}',
        }));
        const applyReversePatch: CheckpointRollbackOrchestrationDependencies['applyReversePatch'] = vi.fn(async () => ({
            status: 'applied' as const,
            changedPaths: [],
            skippedPaths: [],
            receipts: ['checkpoint.rollback_applied' as const],
            diagnostics: [],
        }));

        const result = await executeCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'conversation_and_code_with_stash',
                backupMode: 'happier_checkpoint_and_git_stash',
            },
            conversationRollbackSupported: true,
            deps: {
                captureBackup,
                createStash,
                applyReversePatch,
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.diagnostics).toContain('checkpoint_code_rollback_requires_code_only_mode');
        expect(captureBackup).not.toHaveBeenCalled();
        expect(createStash).not.toHaveBeenCalled();
        expect(applyReversePatch).not.toHaveBeenCalled();
    });

    it('stops before stash and reverse patch when backup capture fails', async () => {
        const createStash = vi.fn();
        const applyReversePatch = vi.fn();

        const result = await executeCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'code_only_with_stash',
                backupMode: 'happier_checkpoint_and_git_stash',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            conversationRollbackSupported: true,
            deps: {
                captureBackup: async () => ({ success: false, diagnostics: ['capture_failed'] }),
                createStash,
                applyReversePatch,
            },
        });

        expect(result.status).toBe('unavailable');
        expect(result.receipts).toEqual(['checkpoint.rollback_aborted']);
        expect(createStash).not.toHaveBeenCalled();
        expect(applyReversePatch).not.toHaveBeenCalled();
    });

    it('stops before reverse patch when optional stash fails', async () => {
        const applyReversePatch = vi.fn();

        const result = await executeCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'code_only_with_stash',
                backupMode: 'happier_checkpoint_and_git_stash',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            conversationRollbackSupported: false,
            deps: {
                captureBackup: async () => ({
                    success: true,
                    backupCheckpointRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/rollback-backup/rollback-1',
                    receipts: ['checkpoint.rollback_backup_captured'],
                }),
                createStash: async () => ({ success: false, diagnostics: ['stash_failed'] }),
                applyReversePatch,
            },
        });

        expect(result.status).toBe('aborted');
        expect(result.backupCheckpointRef).toContain('/rollback-backup/');
        expect(result.receipts).toEqual(['checkpoint.rollback_backup_captured', 'checkpoint.rollback_aborted']);
        expect(applyReversePatch).not.toHaveBeenCalled();
    });

    it('returns applied result with backup receipt before applied receipt', async () => {
        const result = await executeCheckpointCodeRollback({
            request: {
                ...baseRequest,
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            conversationRollbackSupported: true,
            deps: {
                captureBackup: async () => ({
                    success: true,
                    backupCheckpointRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/rollback-backup/rollback-1',
                    receipts: ['checkpoint.rollback_backup_captured'],
                }),
                applyReversePatch: async () => ({
                    status: 'applied',
                    changedPaths: ['tracked.txt'],
                    skippedPaths: [],
                    receipts: ['checkpoint.rollback_applied'],
                    diagnostics: [],
                }),
            },
        });

        expect(result).toMatchObject({
            status: 'applied',
            changedPaths: ['tracked.txt'],
            receipts: ['checkpoint.rollback_backup_captured', 'checkpoint.rollback_applied'],
        });
    });

    it('passes rollback request context through every mutating adapter call', async () => {
        const request = {
            ...baseRequest,
            codeMode: 'code_only_with_stash',
            backupMode: 'happier_checkpoint_and_git_stash',
            codeOnlyTranscriptDivergenceConfirmed: true,
        } as const;
        const captureBackup: CheckpointRollbackOrchestrationDependencies['captureBackup'] = vi.fn(async () => ({
            success: true as const,
            backupCheckpointRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/rollback-backup/rollback-1',
            receipts: ['checkpoint.rollback_backup_captured' as const],
        }));
        const createStash: NonNullable<CheckpointRollbackOrchestrationDependencies['createStash']> = vi.fn(async () => ({
            success: true as const,
            gitStashRef: 'stash@{0}',
            diagnostics: [],
        }));
        const applyReversePatch: CheckpointRollbackOrchestrationDependencies['applyReversePatch'] = vi.fn(async () => ({
            status: 'applied' as const,
            changedPaths: ['tracked.txt'],
            skippedPaths: [],
            receipts: ['checkpoint.rollback_applied' as const],
            diagnostics: [],
        }));

        await executeCheckpointCodeRollback({
            request,
            conversationRollbackSupported: true,
            deps: {
                captureBackup,
                createStash,
                applyReversePatch,
            },
        });

        const expectedContext = expect.objectContaining({
            request,
            sessionId: 'session-1',
            turnId: 'turn-1',
            cwd: '/repo',
            expectedStartRef: baseRequest.expectedStartRef,
            expectedFinalRef: baseRequest.expectedFinalRef,
            codeMode: 'code_only_with_stash',
            backupMode: 'happier_checkpoint_and_git_stash',
        });
        expect(captureBackup).toHaveBeenCalledWith(expectedContext);
        expect(createStash).toHaveBeenCalledWith(expectedContext);
        expect(applyReversePatch).toHaveBeenCalledWith(expect.objectContaining({
            request,
            sessionId: 'session-1',
            turnId: 'turn-1',
            cwd: '/repo',
            expectedStartRef: baseRequest.expectedStartRef,
            expectedFinalRef: baseRequest.expectedFinalRef,
            codeMode: 'code_only_with_stash',
            backupMode: 'happier_checkpoint_and_git_stash',
            backupCaptured: true,
        }));
    });
});
