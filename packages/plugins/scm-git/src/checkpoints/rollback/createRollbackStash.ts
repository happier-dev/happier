import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './shared.js';
import { resolveRepositoryCheckpointAvailability } from '../shared.js';
import type { CheckpointCodeRollbackRequest } from './shared.js';
import type { ScmBackendContext } from '../../types.js';
import { classifyGitCheckpointCommandFailure, runGitCheckpointCommand } from '../commands.js';
import { validateGitCheckpointRollbackRequestScope } from './validateRollbackRequestScope.js';

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
