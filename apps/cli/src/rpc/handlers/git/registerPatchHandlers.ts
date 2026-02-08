import type { GitPatchApplyRequest, GitPatchApplyResponse } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { normalizePathspec, resolveCwd, runGitCommand } from './runtime';

function normalizePaths(paths: string[], cwd: string): { ok: true; normalizedPaths: string[] } | { ok: false; error: string } {
    const normalizedPaths: string[] = [];
    for (const path of paths) {
        const normalized = normalizePathspec(path, cwd);
        if (!normalized.ok) {
            return { ok: false, error: normalized.error };
        }
        normalizedPaths.push(normalized.pathspec);
    }
    return { ok: true, normalizedPaths };
}

async function applyPatchWithCheck(input: {
    cwd: string;
    patch: string;
    checkArgs: string[];
    applyArgs: string[];
    checkError: string;
    applyError: string;
}): Promise<GitPatchApplyResponse> {
    const check = await runGitCommand({
        cwd: input.cwd,
        args: input.checkArgs,
        stdin: input.patch,
        timeoutMs: 15_000,
    });
    if (!check.success) {
        return {
            success: false,
            errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
            error: check.stderr || input.checkError,
            stderr: check.stderr,
        };
    }

    const apply = await runGitCommand({
        cwd: input.cwd,
        args: input.applyArgs,
        stdin: input.patch,
        timeoutMs: 15_000,
    });
    return apply.success
        ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
        : {
            success: false,
            errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
            error: apply.stderr || input.applyError,
            stderr: apply.stderr,
        };
}

export function registerGitPatchHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitPatchApplyRequest, GitPatchApplyResponse>(
        RPC_METHODS.GIT_STAGE_APPLY,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }

            if (request.patch && request.patch.trim().length > 0) {
                return applyPatchWithCheck({
                    cwd: cwdResult.cwd,
                    patch: request.patch,
                    checkArgs: ['apply', '--check', '--cached', '--unidiff-zero', '--recount', '-'],
                    applyArgs: ['apply', '--cached', '--unidiff-zero', '--recount', '-'],
                    checkError: 'Patch check failed',
                    applyError: 'Patch apply failed',
                });
            }

            const paths = request.paths ?? [];
            if (paths.length === 0) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Either `paths` or `patch` must be provided',
                };
            }

            const normalized = normalizePaths(paths, cwdResult.cwd);
            if (!normalized.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalized.error,
                };
            }

            const stage = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['add', '--', ...normalized.normalizedPaths],
                timeoutMs: 10_000,
            });
            return stage.success
                ? { success: true, stdout: stage.stdout, stderr: stage.stderr }
                : {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: stage.stderr || 'Failed to stage files',
                    stderr: stage.stderr,
                };
        }
    );

    rpcHandlerManager.registerHandler<GitPatchApplyRequest, GitPatchApplyResponse>(
        RPC_METHODS.GIT_UNSTAGE_APPLY,
        async (request) => {
            const cwdResult = resolveCwd(request.cwd, workingDirectory);
            if (!cwdResult.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: cwdResult.error,
                };
            }

            if (request.patch && request.patch.trim().length > 0) {
                return applyPatchWithCheck({
                    cwd: cwdResult.cwd,
                    patch: request.patch,
                    checkArgs: ['apply', '--check', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'],
                    applyArgs: ['apply', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'],
                    checkError: 'Patch reverse-check failed',
                    applyError: 'Patch reverse apply failed',
                });
            }

            const paths = request.paths ?? [];
            if (paths.length === 0) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Either `paths` or `patch` must be provided',
                };
            }

            const normalized = normalizePaths(paths, cwdResult.cwd);
            if (!normalized.ok) {
                return {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalized.error,
                };
            }

            const unstage = await runGitCommand({
                cwd: cwdResult.cwd,
                args: ['reset', '--', ...normalized.normalizedPaths],
                timeoutMs: 10_000,
            });
            return unstage.success
                ? { success: true, stdout: unstage.stdout, stderr: unstage.stderr }
                : {
                    success: false,
                    errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: unstage.stderr || 'Failed to unstage files',
                    stderr: unstage.stderr,
                };
        }
    );
}
