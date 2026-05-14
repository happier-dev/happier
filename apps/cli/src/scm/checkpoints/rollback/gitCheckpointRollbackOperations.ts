import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './receipts';
import type { CheckpointCodeRollbackRequest } from './types';
import {
    buildGitCheckpointRollbackScopeId,
    buildGitRollbackBackupRef,
    validateGitCheckpointRollbackRequestScope,
} from './gitCheckpointRollbackScope';
import { resolveRepositoryCheckpointAvailability } from '../availability';
import type { ScmBackendContext } from '../../types';
import {
    classifyGitCheckpointCommandFailure,
    createGitCheckpointTemporaryIndex,
    runGitCheckpointCommand,
} from '../gitCheckpointCommands';

const CHECKPOINT_COMMIT_AUTHOR_ENV = {
    GIT_AUTHOR_NAME: 'Happier Checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@happier.dev',
    GIT_COMMITTER_NAME: 'Happier Checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@happier.dev',
} as const;

export async function createGitRollbackBackup(input: Readonly<{
    context: ScmBackendContext;
    request: CheckpointCodeRollbackRequest;
    rollbackId: string;
}>): Promise<
    | { success: true; backupCheckpointRef: string; commitSha: string; treeSha: string; receipts: readonly ['checkpoint.rollback_backup_captured'] }
    | { success: false; diagnostics: readonly string[]; receipts: readonly [] }
> {
    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) return { success: false, diagnostics: [availability.reason, availability.message], receipts: [] };

    const scopeDiagnostics = validateGitCheckpointRollbackRequestScope({
        context: input.context,
        request: input.request,
        repoRoot: availability.repoRoot,
    });
    if (scopeDiagnostics.length > 0) return { success: false, diagnostics: scopeDiagnostics, receipts: [] };

    let backupCheckpointRef: string;
    try {
        backupCheckpointRef = buildGitRollbackBackupRef({
            rollbackId: input.rollbackId,
            scopeId: buildGitCheckpointRollbackScopeId({
                repoRoot: availability.repoRoot,
                sessionId: input.request.sessionId,
            }),
        });
    } catch (error) {
        return { success: false, diagnostics: [error instanceof Error ? error.message : 'invalid rollback backup ref'], receipts: [] };
    }

    const temporaryIndex = await createGitCheckpointTemporaryIndex({ cwd: availability.repoRoot });
    if (!temporaryIndex.success) return { success: false, diagnostics: [temporaryIndex.reason, temporaryIndex.error], receipts: [] };

    try {
        const stageAll = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['add', '-A', '--', '.'],
            timeoutMs: 10_000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!stageAll.success) {
            const failure = classifyGitCheckpointCommandFailure(stageAll, 'Failed to stage rollback backup checkpoint contents');
            return { success: false, diagnostics: [failure.reason, failure.error], receipts: [] };
        }

        const writeTree = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['write-tree'],
            timeoutMs: 5000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!writeTree.success) {
            const failure = classifyGitCheckpointCommandFailure(writeTree, 'Failed to write rollback backup checkpoint tree');
            return { success: false, diagnostics: [failure.reason, failure.error], receipts: [] };
        }
        const treeSha = writeTree.stdout.trim();
        if (!treeSha) return { success: false, diagnostics: ['Failed to write rollback backup checkpoint tree'], receipts: [] };

        const commitTree = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['commit-tree', treeSha],
            stdin: [
                'Happier checkpoint rollback backup',
                '',
                `Session: ${input.request.sessionId}`,
                `Turn: ${input.request.turnId}`,
                `Rollback: ${input.rollbackId}`,
            ].join('\n'),
            timeoutMs: 5000,
            env: {
                ...temporaryIndex.tempIndex.env,
                ...CHECKPOINT_COMMIT_AUTHOR_ENV,
            },
        });
        if (!commitTree.success) {
            const failure = classifyGitCheckpointCommandFailure(commitTree, 'Failed to create rollback backup checkpoint commit');
            return { success: false, diagnostics: [failure.reason, failure.error], receipts: [] };
        }
        const commitSha = commitTree.stdout.trim();
        if (!commitSha) return { success: false, diagnostics: ['Failed to create rollback backup checkpoint commit'], receipts: [] };

        const updateRef = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['update-ref', backupCheckpointRef, commitSha],
            timeoutMs: 5000,
        });
        if (!updateRef.success) {
            const failure = classifyGitCheckpointCommandFailure(updateRef, 'Failed to update rollback backup checkpoint ref');
            return { success: false, diagnostics: [failure.reason, failure.error], receipts: [] };
        }

        return {
            success: true,
            backupCheckpointRef,
            commitSha,
            treeSha,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.backupCaptured],
        };
    } finally {
        temporaryIndex.tempIndex.cleanup();
    }
}

async function findStoredStashRef(input: Readonly<{
    cwd: string;
    message: string;
}>): Promise<string | null> {
    const list = await runGitCheckpointCommand({
        cwd: input.cwd,
        args: ['stash', 'list'],
        timeoutMs: 5000,
        maxOutputBytes: 512 * 1024,
    });
    if (!list.success) return null;
    const row = list.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.includes(input.message));
    if (!row) return null;
    const colonIndex = row.indexOf(':');
    return colonIndex > 0 ? row.slice(0, colonIndex) : null;
}

export async function createGitRollbackStash(input: Readonly<{
    context: ScmBackendContext;
    request: CheckpointCodeRollbackRequest;
    rollbackId: string;
}>): Promise<
    | { success: true; gitStashRef: string; diagnostics: readonly string[] }
    | { success: false; diagnostics: readonly string[]; receipts: readonly ['checkpoint.rollback_aborted'] }
> {
    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return {
            success: false,
            diagnostics: [availability.reason, availability.message],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
        };
    }

    const scopeDiagnostics = validateGitCheckpointRollbackRequestScope({
        context: input.context,
        request: input.request,
        repoRoot: availability.repoRoot,
    });
    if (scopeDiagnostics.length > 0) {
        return {
            success: false,
            diagnostics: scopeDiagnostics,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
        };
    }

    const message = `Happier rollback backup session=${input.request.sessionId} turn=${input.request.turnId} rollback=${input.rollbackId}`;
    const created = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['stash', 'create', message],
        timeoutMs: 10_000,
        maxOutputBytes: 512 * 1024,
    });
    if (!created.success) {
        const failure = classifyGitCheckpointCommandFailure(created, 'Failed to create rollback Git stash');
        return {
            success: false,
            diagnostics: [failure.reason, failure.error],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
        };
    }

    const stashCommit = created.stdout.trim();
    if (!stashCommit) {
        return {
            success: false,
            diagnostics: ['rollback_git_stash_no_tracked_changes'],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
        };
    }

    const stored = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['stash', 'store', '-m', message, stashCommit],
        timeoutMs: 10_000,
        maxOutputBytes: 512 * 1024,
    });
    if (!stored.success) {
        const failure = classifyGitCheckpointCommandFailure(stored, 'Failed to store rollback Git stash');
        return {
            success: false,
            diagnostics: [failure.reason, failure.error],
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
        };
    }

    return {
        success: true,
        gitStashRef: await findStoredStashRef({ cwd: availability.repoRoot, message }) ?? 'stash@{0}',
        diagnostics: [],
    };
}

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

async function compareCurrentWorktreeToExpectedFinal(input: Readonly<{
    cwd: string;
    expectedFinalRef: string;
}>): Promise<
    | { success: true; diverged: boolean }
    | { success: false; diagnostics: readonly string[] }
> {
    const expectedTree = await runGitCheckpointCommand({
        cwd: input.cwd,
        args: ['rev-parse', `${input.expectedFinalRef}^{tree}`],
        timeoutMs: 5000,
    });
    if (!expectedTree.success) {
        const failure = classifyGitCheckpointCommandFailure(expectedTree, 'Failed to read expected checkpoint final tree');
        return { success: false, diagnostics: [failure.reason, failure.error] };
    }
    const expectedTreeSha = expectedTree.stdout.trim();
    if (!expectedTreeSha) return { success: false, diagnostics: ['Failed to read expected checkpoint final tree'] };

    const temporaryIndex = await createGitCheckpointTemporaryIndex({ cwd: input.cwd });
    if (!temporaryIndex.success) return { success: false, diagnostics: [temporaryIndex.reason, temporaryIndex.error] };

    try {
        const stageCurrent = await runGitCheckpointCommand({
            cwd: input.cwd,
            args: ['add', '-A', '--', '.'],
            timeoutMs: 10_000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!stageCurrent.success) {
            const failure = classifyGitCheckpointCommandFailure(stageCurrent, 'Failed to stage current rollback candidate contents');
            return { success: false, diagnostics: [failure.reason, failure.error] };
        }

        const currentTree = await runGitCheckpointCommand({
            cwd: input.cwd,
            args: ['write-tree'],
            timeoutMs: 5000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!currentTree.success) {
            const failure = classifyGitCheckpointCommandFailure(currentTree, 'Failed to write current rollback candidate tree');
            return { success: false, diagnostics: [failure.reason, failure.error] };
        }
        const currentTreeSha = currentTree.stdout.trim();
        if (!currentTreeSha) return { success: false, diagnostics: ['Failed to write current rollback candidate tree'] };

        return { success: true, diverged: currentTreeSha !== expectedTreeSha };
    } finally {
        temporaryIndex.tempIndex.cleanup();
    }
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

    const changedPaths = await readChangedPaths({
        cwd: availability.repoRoot,
        expectedStartRef: input.request.expectedStartRef,
        expectedFinalRef: input.request.expectedFinalRef,
    });

    const currentMatchesExpectedFinal = await compareCurrentWorktreeToExpectedFinal({
        cwd: availability.repoRoot,
        expectedFinalRef: input.request.expectedFinalRef,
    });
    if (!currentMatchesExpectedFinal.success) {
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: changedPaths,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted],
            diagnostics: currentMatchesExpectedFinal.diagnostics,
        };
    }
    if (currentMatchesExpectedFinal.diverged) {
        return {
            status: 'conflict',
            changedPaths: [],
            skippedPaths: changedPaths,
            receipts: [CHECKPOINT_ROLLBACK_RECEIPT_IDS.conflict],
            diagnostics: ['checkpoint_rollback_worktree_diverged'],
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
