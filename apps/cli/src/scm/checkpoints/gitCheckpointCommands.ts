import { createGitTemporaryIndex, type GitTemporaryIndex } from '@happier-dev/cli-common/scm/gitTemporaryIndex';

import { runScmCommand, type ScmExecResult } from '../runtime';
import type { RepositoryCheckpointAvailabilityReason } from './types';

export type GitCheckpointCommandOptions = Readonly<{
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Record<string, string | undefined>;
}>;

export type GitCheckpointTemporaryIndex = GitTemporaryIndex;

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
    const head = await runGitCheckpointCommand({ cwd: input.cwd, args: ['rev-parse', '--verify', 'HEAD'], timeoutMs: 5000 });
    const result = await createGitTemporaryIndex({
        cwd: input.cwd,
        seed: head.success ? { kind: 'tree', treeOid: head.stdout.trim() } : { kind: 'empty' },
        runGit: (command) => runGitCheckpointCommand({ ...command, timeoutMs: 5000 }),
    });
    if (result.success) return result;
    const failure = result.commandResult
        ? classifyGitCheckpointCommandFailure(result.commandResult, result.error)
        : { reason: 'command_failed' as const, error: result.error };
    return { success: false, ...failure };
}
