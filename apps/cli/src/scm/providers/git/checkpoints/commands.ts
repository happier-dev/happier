import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runScmCommand, type ScmExecResult } from '../../../runtime';
import type { RepositoryCheckpointAvailabilityReason } from '../../../checkpoints';

export type GitCheckpointCommandOptions = Readonly<{
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Record<string, string | undefined>;
}>;

export type GitCheckpointTemporaryIndex = Readonly<{
    indexPath: string;
    env: Record<string, string>;
    cleanup: () => void;
}>;

export type GitCheckpointCommandFailure = Readonly<{
    reason: Extract<RepositoryCheckpointAvailabilityReason, 'command_failed' | 'missing_git' | 'permission_denied'>;
    error: string;
}>;

export function runGitCheckpointCommand(input: GitCheckpointCommandOptions): Promise<ScmExecResult> {
    return runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: [...input.args],
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        maxOutputBytes: input.maxOutputBytes,
        env: input.env,
    });
}

export function classifyGitCheckpointCommandFailure(
    result: ScmExecResult,
    fallbackError: string,
): GitCheckpointCommandFailure {
    const error = result.stderr.trim() || fallbackError;
    if (result.exitCode === -1 && /\b(?:ENOENT|not found|no such file)\b/i.test(error)) {
        return { reason: 'missing_git', error };
    }
    if (result.exitCode === -1 && /\b(?:EACCES|permission denied)\b/i.test(error)) {
        return { reason: 'permission_denied', error };
    }
    return { reason: 'command_failed', error };
}

export async function createGitCheckpointTemporaryIndex(input: {
    cwd: string;
}): Promise<
    | { success: true; tempIndex: GitCheckpointTemporaryIndex }
    | { success: false; reason: GitCheckpointCommandFailure['reason']; error: string }
> {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-scm-checkpoint-index-'));
    const indexPath = join(tempDir, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    const cleanup = () => {
        rmSync(tempDir, { recursive: true, force: true });
    };

    writeFileSync(indexPath, '');
    const readHead = await runGitCheckpointCommand({
        cwd: input.cwd,
        args: ['read-tree', 'HEAD'],
        timeoutMs: 5000,
        env,
    });
    if (!readHead.success) {
        const readEmpty = await runGitCheckpointCommand({
            cwd: input.cwd,
            args: ['read-tree', '--empty'],
            timeoutMs: 5000,
            env,
        });
        if (!readEmpty.success) {
            const failure = classifyGitCheckpointCommandFailure(
                readEmpty,
                readHead.stderr || 'Failed to initialize temporary checkpoint index',
            );
            cleanup();
            return {
                success: false,
                reason: failure.reason,
                error: failure.error,
            };
        }
    }

    return {
        success: true,
        tempIndex: {
            indexPath,
            env,
            cleanup,
        },
    };
}
