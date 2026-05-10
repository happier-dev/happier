import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './shared.js';
import { resolveRepositoryCheckpointAvailability } from '../shared.js';
import type { ScmBackendContext } from '../../types.js';
import type { CheckpointCodeRollbackRequest } from './shared.js';
import { classifyGitCheckpointCommandFailure, runGitCheckpointCommand } from '../commands.js';
import { validateGitCheckpointRollbackRequestScope } from './validateRollbackRequestScope.js';

async function readChangedPaths(input: Readonly<{
    cwd: string;
    expectedStartRef: string;
    expectedFinalRef: string;
}>): Promise<readonly string[]> {
    const result = await runGitCheckpointCommand({
        cwd: input.cwd,
        args: ['diff', '--name-only', '-z', input.expectedStartRef, input.expectedFinalRef],
        timeoutMs: 10_000,
    });
    if (!result.success) return [];
    return result.stdout.split('\0').filter((path) => path.trim().length > 0);
}

export async function applyGitCheckpointReversePatch(input: Readonly<{
    context: ScmBackendContext;
    request: CheckpointCodeRollbackRequest;
    backupCaptured: boolean;
}>): Promise<Readonly<{
    status: 'applied' | 'conflict' | 'unavailable' | 'aborted';
    changedPaths: readonly string[];
    skippedPaths: readonly string[];
    receipts: readonly ('checkpoint.rollback_applied' | 'checkpoint.rollback_conflict' | 'checkpoint.rollback_aborted')[];
    diagnostics: readonly string[];
}>> {
    if (!input.backupCaptured) {
        return {
            status: 'aborted',
            changedPaths: [],
            skippedPaths: [],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: ['rollback_backup_checkpoint_required'],
        };
    }

    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: [],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: [availability.reason, availability.message],
        };
    }

    const scopeDiagnostics = validateGitCheckpointRollbackRequestScope({
        context: input.context,
        request: input.request,
        repoRoot: availability.repoRoot,
    });
    if (scopeDiagnostics.length > 0) {
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: [],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: scopeDiagnostics,
        };
    }

    const diff = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['diff', '--binary', input.request.expectedFinalRef, input.request.expectedStartRef],
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
    });
    if (!diff.success) {
        const failure = classifyGitCheckpointCommandFailure(diff, 'Failed to compute checkpoint rollback reverse patch');
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: [],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: [failure.reason, failure.error],
        };
    }
    if (/GIT binary patch|Binary files .* differ/i.test(diff.stdout)) {
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: await readChangedPaths({
                cwd: availability.repoRoot,
                expectedStartRef: input.request.expectedStartRef,
                expectedFinalRef: input.request.expectedFinalRef,
            }),
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: ['binary_checkpoint_rollback_unsupported'],
        };
    }

    const changedPaths = await readChangedPaths({
        cwd: availability.repoRoot,
        expectedStartRef: input.request.expectedStartRef,
        expectedFinalRef: input.request.expectedFinalRef,
    });

    const preflight = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['apply', '--check'],
        stdin: diff.stdout,
        timeoutMs: 10_000,
        maxOutputBytes: 512 * 1024,
    });
    if (!preflight.success) {
        const failure = classifyGitCheckpointCommandFailure(preflight, 'Checkpoint rollback reverse patch does not apply cleanly');
        return {
            status: 'conflict',
            changedPaths: [],
            skippedPaths: changedPaths,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.conflict],
            diagnostics: [failure.error],
        };
    }

    const apply = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['apply'],
        stdin: diff.stdout,
        timeoutMs: 10_000,
        maxOutputBytes: 512 * 1024,
    });
    if (!apply.success) {
        const failure = classifyGitCheckpointCommandFailure(apply, 'Checkpoint rollback reverse patch failed');
        return {
            status: 'conflict',
            changedPaths: [],
            skippedPaths: changedPaths,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.conflict],
            diagnostics: [failure.error],
        };
    }

    return {
        status: 'applied',
        changedPaths,
        skippedPaths: [],
        receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.applied],
        diagnostics: [],
    };
}
