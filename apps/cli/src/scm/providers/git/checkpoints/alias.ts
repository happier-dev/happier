import {
    buildRepositoryCheckpointRef,
    REPOSITORY_CHECKPOINT_RECEIPT_IDS,
    resolveRepositoryCheckpointAvailability,
} from '../../../checkpoints';
import type {
    RepositoryCheckpointAliasRequest,
    RepositoryCheckpointAliasResult,
    RepositoryCheckpointRef,
} from '../../../checkpoints';
import { classifyGitCheckpointCommandFailure, runGitCheckpointCommand } from './commands';

function validateAliasRefs(sourceRef: RepositoryCheckpointRef, targetRef: RepositoryCheckpointRef): string | null {
    if (sourceRef.scopeId !== targetRef.scopeId) {
        return 'Checkpoint alias refs must share the same scope.';
    }
    if (sourceRef.phase !== 'message-start') {
        return 'Checkpoint alias source must be a message-start ref.';
    }
    if (targetRef.phase !== 'turn-start') {
        return 'Checkpoint alias target must be a turn-start ref.';
    }
    for (const checkpointRef of [sourceRef, targetRef]) {
        const expected = buildRepositoryCheckpointRef({
            scopeId: checkpointRef.scopeId,
            phase: checkpointRef.phase,
            checkpointId: checkpointRef.checkpointId,
        });
        if (checkpointRef.encodedScope !== expected.encodedScope || checkpointRef.ref !== expected.ref) {
            return 'Checkpoint alias ref is outside the Happier checkpoint namespace.';
        }
    }
    return null;
}

export async function aliasGitRepositoryCheckpoint(
    input: RepositoryCheckpointAliasRequest,
): Promise<RepositoryCheckpointAliasResult> {
    const refError = validateAliasRefs(input.sourceRef, input.targetRef);
    if (refError) {
        return {
            success: false,
            kind: 'failed',
            reason: 'invalid_ref',
            error: refError,
            receipts: [],
        };
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

    const source = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['rev-parse', '--verify', `${input.sourceRef.ref}^{commit}`],
        timeoutMs: 5000,
    });
    if (!source.success) {
        const stderr = source.stderr.trim();
        if (/\b(needed a single revision|unknown revision|not a valid object name|bad revision)\b/i.test(stderr)) {
            return {
                success: false,
                kind: 'unavailable',
                reason: 'missing_source',
                error: 'Checkpoint alias source ref is unavailable.',
                receipts: [],
            };
        }
        const failure = classifyGitCheckpointCommandFailure(source, 'Failed to read checkpoint alias source ref');
        return {
            success: false,
            kind: 'unavailable',
            reason: failure.reason,
            error: failure.error,
            receipts: [],
        };
    }

    const commitSha = source.stdout.trim();
    if (!commitSha) {
        return {
            success: false,
            kind: 'unavailable',
            reason: 'missing_source',
            error: 'Checkpoint alias source ref is unavailable.',
            receipts: [],
        };
    }

    const update = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['update-ref', input.targetRef.ref, commitSha],
        timeoutMs: 5000,
    });
    if (!update.success) {
        const failure = classifyGitCheckpointCommandFailure(update, 'Failed to update checkpoint alias target ref');
        return {
            success: false,
            kind: 'unavailable',
            reason: failure.reason,
            error: failure.error,
            receipts: [],
        };
    }

    return {
        success: true,
        sourceRef: input.sourceRef,
        targetRef: input.targetRef,
        commitSha,
        receipts: [{
            id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.aliased,
            ref: input.targetRef.ref,
            commitSha,
            phase: input.targetRef.phase,
        }],
    };
}
