import { Buffer } from 'node:buffer';

import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './shared.js';
import { resolveRepositoryCheckpointAvailability } from '../shared.js';
import type { CheckpointCodeRollbackRequest } from './shared.js';
import type { ScmBackendContext } from '../../types.js';
import {
    classifyGitCheckpointCommandFailure,
    createGitCheckpointTemporaryIndex,
    runGitCheckpointCommand,
} from '../commands.js';
import {
    buildGitCheckpointRollbackScopeId,
    validateGitCheckpointRollbackRequestScope,
} from './validateRollbackRequestScope.js';

const CHECKPOINT_COMMIT_AUTHOR_ENV = {
    GIT_AUTHOR_NAME: 'Happier Checkpoint',
    GIT_AUTHOR_EMAIL: 'checkpoint@happier.dev',
    GIT_COMMITTER_NAME: 'Happier Checkpoint',
    GIT_COMMITTER_EMAIL: 'checkpoint@happier.dev',
} as const;

const INVALID_REF_SEGMENT = /[\u0000-\u0020\u007f~^:?*[\\]/;

function assertSafeSegment(value: string, label: string): void {
    if (
        value.trim().length === 0
        || value.includes('/')
        || value.includes('..')
        || value.includes('@{')
        || value.endsWith('.lock')
        || value.startsWith('.')
        || value.endsWith('.')
        || INVALID_REF_SEGMENT.test(value)
    ) {
        throw new Error(`${label} is not safe for a rollback checkpoint ref`);
    }
}

export function buildGitRollbackBackupRef(input: Readonly<{
    rollbackId: string;
    scopeId: string;
}>): string {
    assertSafeSegment(input.rollbackId, 'rollbackId');
    const encodedScope = Buffer.from(input.scopeId, 'utf8').toString('base64url');
    return `refs/happier/checkpoints/${encodedScope}/rollback-backup/${input.rollbackId}`;
}

export async function createGitRollbackBackup(input: Readonly<{
    context: ScmBackendContext;
    request: CheckpointCodeRollbackRequest;
    rollbackId: string;
}>): Promise<
    | { success: true; backupCheckpointRef: string; commitSha: string; treeSha: string; receipts: readonly ['checkpoint.rollback_backup_captured'] }
    | { success: false; diagnostics: readonly string[]; receipts: readonly [] }
> {
    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return { success: false, diagnostics: [availability.reason, availability.message], receipts: [] };
    }

    const scopeDiagnostics = validateGitCheckpointRollbackRequestScope({
        context: input.context,
        request: input.request,
        repoRoot: availability.repoRoot,
    });
    if (scopeDiagnostics.length > 0) {
        return { success: false, diagnostics: scopeDiagnostics, receipts: [] };
    }

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
    if (!temporaryIndex.success) {
        return { success: false, diagnostics: [temporaryIndex.reason, temporaryIndex.error], receipts: [] };
    }

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
        if (!treeSha) {
            return { success: false, diagnostics: ['Failed to write rollback backup checkpoint tree'], receipts: [] };
        }

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
        if (!commitSha) {
            return { success: false, diagnostics: ['Failed to create rollback backup checkpoint commit'], receipts: [] };
        }

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
