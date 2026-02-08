import { resolve } from 'path';

import type {
    GitCommitCreateRequest,
    GitCommitCreateResponse,
    GitCommitRevertRequest,
    GitCommitRevertResponse,
    GitLogEntry,
    GitLogListRequest,
    GitLogListResponse,
} from '@happier-dev/protocol';
import { GIT_COMMIT_MESSAGE_MAX_LENGTH, GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mapGitErrorCode } from './remote';
import {
    getSnapshotForCwd,
    hasAnyWorktreeChanges,
    normalizeCommitRef,
    resolveCwd,
    runGitCommand,
} from './runtime';

const GIT_LOG_FIELDS_PER_ENTRY = 7;

function parseGitLogEntries(rawOutput: string): GitLogEntry[] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let fieldStart = 0;

    for (let index = 0; index < rawOutput.length; index += 1) {
        if (rawOutput.charCodeAt(index) !== 0) {
            continue;
        }

        currentRow.push(rawOutput.slice(fieldStart, index));
        fieldStart = index + 1;

        if (currentRow.length === GIT_LOG_FIELDS_PER_ENTRY) {
            rows.push(currentRow);
            currentRow = [];
        }
    }

    return rows.map((row) => {
        const timestampRaw = Number(row[4] || 0);
        return {
            sha: row[0] || '',
            shortSha: row[1] || '',
            authorName: row[2] || '',
            authorEmail: row[3] || '',
            timestamp: Number.isFinite(timestampRaw) ? timestampRaw : 0,
            subject: row[5] || '',
            body: row[6] || '',
        };
    });
}

export function registerGitCommitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitCommitCreateRequest, GitCommitCreateResponse>(
        RPC_METHODS.GIT_COMMIT_CREATE,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const snapshot = await getSnapshotForCwd(cwdResult.cwd, `${resolve(workingDirectory)}:${cwdResult.cwd}`);
            if (!snapshot.success || !snapshot.snapshot) {
                return {
                    success: false,
                    errorCode: snapshot.errorCode ?? GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: snapshot.error || 'Failed to evaluate repository state',
                };
            }
            if (!snapshot.snapshot.repo.isGitRepo) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO,
                    error: 'The selected path is not a Git repository.',
                };
            }
            const message = (request.message ?? '').trim();
            if (!message) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Commit message cannot be empty',
                };
            }
            if (message.length > GIT_COMMIT_MESSAGE_MAX_LENGTH) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: `Commit message exceeds maximum length of ${GIT_COMMIT_MESSAGE_MAX_LENGTH} characters`,
                };
            }
            const hasStagedChanges = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['diff', '--cached', '--quiet'],
                timeoutMs: 5000,
            });
            if (hasStagedChanges.exitCode === 0) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                    error: 'No staged changes to commit',
                };
            }
            const commit = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['commit', '-m', message],
                timeoutMs: 20_000,
            });
            if (!commit.success) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: commit.stderr || 'Commit failed',
                };
            }
            const sha = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['rev-parse', 'HEAD'],
                timeoutMs: 5000,
            });
            return {
                success: true,
                commitSha: sha.success ? sha.stdout.trim() : undefined,
            };
        }
    );

    rpcHandlerManager.registerHandler<GitLogListRequest, GitLogListResponse>(
        RPC_METHODS.GIT_LOG_LIST,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const snapshot = await getSnapshotForCwd(cwdResult.cwd, `${resolve(workingDirectory)}:${cwdResult.cwd}`);
            if (!snapshot.success || !snapshot.snapshot) {
                return {
                    success: false,
                    errorCode: snapshot.errorCode ?? GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: snapshot.error || 'Failed to evaluate repository state',
                };
            }
            if (!snapshot.snapshot.repo.isGitRepo) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO,
                    error: 'The selected path is not a Git repository.',
                };
            }
            const limit = request.limit ?? 50;
            const skip = request.skip ?? 0;
            const log = await runGitCommand({
                cwd: cwdResult.cwd,
                args: [
                    'log',
                    `--max-count=${limit}`,
                    `--skip=${skip}`,
                    '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00',
                ],
                timeoutMs: 15_000,
            });
            if (!log.success) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: log.stderr || 'Failed to list commits',
                };
            }
            const entries = parseGitLogEntries(log.stdout);
            return { success: true, entries };
        }
    );

    rpcHandlerManager.registerHandler<GitCommitRevertRequest, GitCommitRevertResponse>(
        RPC_METHODS.GIT_COMMIT_REVERT,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const snapshot = await getSnapshotForCwd(cwdResult.cwd, `${resolve(workingDirectory)}:${cwdResult.cwd}`);
            if (!snapshot.success || !snapshot.snapshot) {
                return {
                    success: false,
                    errorCode: snapshot.errorCode ?? GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: snapshot.error || 'Failed to evaluate repository state',
                };
            }
            if (!snapshot.snapshot.repo.isGitRepo) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO,
                    error: 'The selected path is not a Git repository.',
                };
            }
            if (snapshot.snapshot.branch.detached) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Revert is unavailable while HEAD is detached',
                };
            }
            if (hasAnyWorktreeChanges(snapshot.snapshot) || snapshot.snapshot.hasConflicts) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                    error: 'Working tree must be clean before revert',
                };
            }
            const commitRef = normalizeCommitRef(request.commit);
            if (!commitRef.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: commitRef.error,
                };
            }
            const parents = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['rev-list', '--parents', '-n', '1', commitRef.commit],
                timeoutMs: 5000,
            });
            if (!parents.success) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: parents.stderr || 'Failed to inspect commit parents',
                };
            }
            const parentTokens = parents.stdout.trim().split(/\s+/).filter((token) => token.length > 0);
            // `rev-list --parents` returns: <commit> <parent1> <parent2>...
            // More than one parent means this is a merge commit and requires `-m`.
            if (parentTokens.length > 2) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Reverting merge commits is not supported yet.',
                };
            }
            const revert = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['revert', '--no-edit', commitRef.commit],
                timeoutMs: 20_000,
            });
            return revert.success
                ? { success: true, stdout: revert.stdout, stderr: revert.stderr }
                : {
                    success: false,
                    errorCode: mapGitErrorCode(revert.stderr),
                    error: revert.stderr || 'Failed to revert commit',
                    stderr: revert.stderr,
                };
        }
    );
}
