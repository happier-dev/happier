import { resolve } from 'path';

import type { GitRemoteRequest, GitRemoteResponse } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    buildGitPullArgs,
    buildGitPushArgs,
    mapGitErrorCode,
    normalizeGitRemoteRequest,
} from './remote';
import { evaluateRemoteMutationPreconditions } from './remoteGuards';
import { getSnapshotForCwd, resolveCwd, runGitCommand } from './runtime';

export function registerGitRemoteHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitRemoteRequest, GitRemoteResponse>(
        RPC_METHODS.GIT_REMOTE_FETCH,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const normalizedRemoteRequest = normalizeGitRemoteRequest(request);
            if (!normalizedRemoteRequest.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: normalizedRemoteRequest.error,
                };
            }
            const args = ['fetch', '--prune'];
            if (normalizedRemoteRequest.request.remote) args.push(normalizedRemoteRequest.request.remote);
            const fetch = await runGitCommand({ cwd: cwdResult.cwd, args, timeoutMs: 30_000 });
            return fetch.success
                ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
                : {
                    success: false,
                    errorCode: mapGitErrorCode(fetch.stderr),
                    error: fetch.stderr || 'Fetch failed',
                    stderr: fetch.stderr,
                };
        }
    );

    rpcHandlerManager.registerHandler<GitRemoteRequest, GitRemoteResponse>(
        RPC_METHODS.GIT_REMOTE_PUSH,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const normalizedRemoteRequest = normalizeGitRemoteRequest(request);
            if (!normalizedRemoteRequest.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: normalizedRemoteRequest.error,
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
            const guard = evaluateRemoteMutationPreconditions({
                kind: 'push',
                snapshot: snapshot.snapshot,
                hasExplicitRemoteOrBranch: Boolean(
                    normalizedRemoteRequest.request.remote || normalizedRemoteRequest.request.branch
                ),
            });
            if (!guard.ok) {
                return {
                    success: false,
                    errorCode: guard.errorCode,
                    error: guard.error,
                };
            }
            const args = buildGitPushArgs(normalizedRemoteRequest.request);
            const push = await runGitCommand({ cwd: cwdResult.cwd, args, timeoutMs: 30_000 });
            return push.success
                ? { success: true, stdout: push.stdout, stderr: push.stderr }
                : {
                    success: false,
                    errorCode: mapGitErrorCode(push.stderr),
                    error: push.stderr || 'Push failed',
                    stderr: push.stderr,
                };
        }
    );

    rpcHandlerManager.registerHandler<GitRemoteRequest, GitRemoteResponse>(
        RPC_METHODS.GIT_REMOTE_PULL,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }
            const normalizedRemoteRequest = normalizeGitRemoteRequest(request);
            if (!normalizedRemoteRequest.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: normalizedRemoteRequest.error,
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
            const guard = evaluateRemoteMutationPreconditions({
                kind: 'pull',
                snapshot: snapshot.snapshot,
                hasExplicitRemoteOrBranch: Boolean(
                    normalizedRemoteRequest.request.remote || normalizedRemoteRequest.request.branch
                ),
            });
            if (!guard.ok) {
                return {
                    success: false,
                    errorCode: guard.errorCode,
                    error: guard.error,
                };
            }
            const args = buildGitPullArgs(normalizedRemoteRequest.request);
            const pull = await runGitCommand({ cwd: cwdResult.cwd, args, timeoutMs: 30_000 });
            return pull.success
                ? { success: true, stdout: pull.stdout, stderr: pull.stderr }
                : {
                    success: false,
                    errorCode: mapGitErrorCode(pull.stderr),
                    error: pull.stderr || 'Pull failed',
                    stderr: pull.stderr,
                };
        }
    );
}
