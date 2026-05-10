import {
    buildRepositoryCheckpointRef,
    REPOSITORY_CHECKPOINT_RECEIPT_IDS,
    resolveRepositoryCheckpointAvailability,
} from '../checkpoints/shared.js';
import type { RepositoryCheckpointCaptureRequest, RepositoryCheckpointCaptureResult } from '../checkpoints/shared.js';
import {
    classifyGitCheckpointCommandFailure,
    createGitCheckpointTemporaryIndex,
    runGitCheckpointCommand,
} from './commands.js';

const CHECKPOINT_COMMIT_AUTHOR_ENV = {
    GIT_AUTHOR_NAME: 'Happier Checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@happier.dev',
    GIT_COMMITTER_NAME: 'Happier Checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@happier.dev',
} as const;

function captureFailure(error: string): RepositoryCheckpointCaptureResult {
    return {
        success: false,
        kind: 'failed',
        reason: 'capture_failed',
        error,
        receipts: [],
    };
}

function captureCommandFailure(
    result: Parameters<typeof classifyGitCheckpointCommandFailure>[0],
    fallbackError: string,
): RepositoryCheckpointCaptureResult {
    const failure = classifyGitCheckpointCommandFailure(result, fallbackError);
    return {
        success: false,
        kind: 'unavailable',
        reason: failure.reason,
        error: failure.error,
        receipts: [],
    };
}

function buildCheckpointCommitMessage(input: RepositoryCheckpointCaptureRequest): string {
    if (input.message && input.message.trim().length > 0) {
        return input.message;
    }
    return [
        `Happier repository checkpoint: ${input.checkpointRef.phase}`,
        '',
        `Scope: ${input.checkpointRef.encodedScope}`,
        `Checkpoint: ${input.checkpointRef.checkpointId}`,
    ].join('\n');
}

function validateCheckpointRef(input: RepositoryCheckpointCaptureRequest): string | null {
    try {
        const expected = buildRepositoryCheckpointRef({
            scopeId: input.checkpointRef.scopeId,
            phase: input.checkpointRef.phase,
            checkpointId: input.checkpointRef.checkpointId,
        });
        if (
            input.checkpointRef.encodedScope !== expected.encodedScope
            || input.checkpointRef.ref !== expected.ref
        ) {
            return 'Checkpoint ref is outside the Happier checkpoint namespace.';
        }
    } catch (error) {
        return error instanceof Error ? error.message : 'Checkpoint ref is invalid.';
    }
    return null;
}

export async function captureGitRepositoryCheckpoint(
    input: RepositoryCheckpointCaptureRequest,
): Promise<RepositoryCheckpointCaptureResult> {
    const checkpointRefError = validateCheckpointRef(input);
    if (checkpointRefError) {
        return captureFailure(checkpointRefError);
    }

    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return {
            success: false,
            kind: 'unavailable',
            reason: availability.reason,
            error: availability.message,
            receipts: [],
        };
    }

    const temporaryIndex = await createGitCheckpointTemporaryIndex({ cwd: availability.repoRoot });
    if (!temporaryIndex.success) {
        return {
            success: false,
            kind: 'unavailable',
            reason: temporaryIndex.reason,
            error: temporaryIndex.error,
            receipts: [],
        };
    }

    try {
        const stageAll = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['add', '-A', '--', '.'],
            timeoutMs: 10_000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!stageAll.success) {
            return captureCommandFailure(stageAll, 'Failed to stage checkpoint contents');
        }

        const writeTree = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['write-tree'],
            timeoutMs: 5000,
            env: temporaryIndex.tempIndex.env,
        });
        if (!writeTree.success) {
            return captureCommandFailure(writeTree, 'Failed to write checkpoint tree');
        }
        const treeSha = writeTree.stdout.trim();
        if (!treeSha) {
            return captureFailure('Failed to write checkpoint tree');
        }

        const commitTree = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['commit-tree', treeSha],
            stdin: buildCheckpointCommitMessage(input),
            timeoutMs: 5000,
            env: {
                ...temporaryIndex.tempIndex.env,
                ...CHECKPOINT_COMMIT_AUTHOR_ENV,
            },
        });
        if (!commitTree.success) {
            return captureCommandFailure(commitTree, 'Failed to create checkpoint commit');
        }
        const commitSha = commitTree.stdout.trim();
        if (!commitSha) {
            return captureFailure('Failed to create checkpoint commit');
        }

        const updateRef = await runGitCheckpointCommand({
            cwd: availability.repoRoot,
            args: ['update-ref', input.checkpointRef.ref, commitSha],
            timeoutMs: 5000,
        });
        if (!updateRef.success) {
            return captureCommandFailure(updateRef, 'Failed to update checkpoint ref');
        }

        return {
            success: true,
            checkpointRef: input.checkpointRef,
            commitSha,
            treeSha,
            receipts: [
                {
                    id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.captured,
                    ref: input.checkpointRef.ref,
                    commitSha,
                    treeSha,
                    phase: input.checkpointRef.phase,
                },
                ...(input.checkpointRef.phase === 'turn-final'
                    ? [{
                        id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.finalized,
                        ref: input.checkpointRef.ref,
                        commitSha,
                        treeSha,
                        phase: input.checkpointRef.phase,
                    } as const]
                    : []),
            ],
        };
    } finally {
        temporaryIndex.tempIndex.cleanup();
    }
}
