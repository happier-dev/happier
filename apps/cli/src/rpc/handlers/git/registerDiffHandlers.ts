import type {
    GitDiffCommitRequest,
    GitDiffCommitResponse,
    GitDiffFileRequest,
    GitDiffFileResponse,
} from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolve } from 'path';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { getSnapshotForCwd, normalizeCommitRef, normalizePathspec, resolveCwd, runGitCommand } from './runtime';

export function registerGitDiffHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitDiffFileResponse>(
        RPC_METHODS.GIT_DIFF_FILE,
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
            const pathspec = normalizePathspec(request.path, cwdResult.cwd);
            if (!pathspec.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: pathspec.error,
                };
            }
            const mode = request.mode ?? 'unstaged';
            const args =
                mode === 'staged'
                    ? ['diff', '--no-ext-diff', '--cached', '--', pathspec.pathspec]
                    : mode === 'both'
                        ? ['diff', '--no-ext-diff', 'HEAD', '--', pathspec.pathspec]
                        : ['diff', '--no-ext-diff', '--', pathspec.pathspec];
            const result = await runGitCommand({ cwd: cwdResult.cwd, args, timeoutMs: 10_000 });
            return result.success
                ? { success: true, diff: result.stdout }
                : {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: result.stderr || 'Failed to load file diff',
                };
        }
    );

    rpcHandlerManager.registerHandler<GitDiffCommitRequest, GitDiffCommitResponse>(
        RPC_METHODS.GIT_DIFF_COMMIT,
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
            const commitRef = normalizeCommitRef(request.commit);
            if (!commitRef.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: commitRef.error,
                };
            }
            const result = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['show', '--no-ext-diff', '--patch', '--format=fuller', commitRef.commit],
                timeoutMs: 15_000,
            });
            return result.success
                ? { success: true, diff: result.stdout }
                : {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: result.stderr || 'Failed to load commit diff',
                };
        }
    );
}
