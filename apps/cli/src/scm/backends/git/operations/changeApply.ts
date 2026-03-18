import type { ScmChangeApplyRequest, ScmChangeApplyResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';

import { applyValidatedGitPatch } from './applyValidatedGitPatch';
import { normalizePaths } from './normalizePaths';

export async function gitChangeInclude(input: {
    context: ScmBackendContext;
    request: ScmChangeApplyRequest;
}): Promise<ScmChangeApplyResponse> {
    const { context, request } = input;
    if (request.patch && request.patch.trim().length > 0) {
        return applyValidatedGitPatch({
            cwd: context.cwd,
            patch: request.patch,
            target: 'index',
            checkError: 'Patch check failed',
            applyError: 'Patch apply failed',
        });
    }

    const paths = request.paths ?? [];
    if (paths.length === 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Either `paths` or `patch` must be provided',
        };
    }

    const normalized = normalizePaths(paths, context.cwd);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: normalized.error,
        };
    }

    const include = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['add', '--', ...normalized.normalizedPaths],
        timeoutMs: 10_000,
    });
    return include.success
        ? { success: true, stdout: include.stdout, stderr: include.stderr }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: include.stderr || 'Failed to include files',
            stderr: include.stderr,
        };
}

export async function gitChangeExclude(input: {
    context: ScmBackendContext;
    request: ScmChangeApplyRequest;
}): Promise<ScmChangeApplyResponse> {
    const { context, request } = input;
    if (request.patch && request.patch.trim().length > 0) {
        return applyValidatedGitPatch({
            cwd: context.cwd,
            patch: request.patch,
            target: 'index',
            reverse: true,
            checkError: 'Patch reverse-check failed',
            applyError: 'Patch reverse apply failed',
        });
    }

    const paths = request.paths ?? [];
    if (paths.length === 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Either `paths` or `patch` must be provided',
        };
    }

    const normalized = normalizePaths(paths, context.cwd);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: normalized.error,
        };
    }

    const exclude = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['reset', '--', ...normalized.normalizedPaths],
        timeoutMs: 10_000,
    });
    return exclude.success
        ? { success: true, stdout: exclude.stdout, stderr: exclude.stderr }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: exclude.stderr || 'Failed to exclude files',
            stderr: exclude.stderr,
        };
}
