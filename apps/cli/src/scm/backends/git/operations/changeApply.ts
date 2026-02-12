import type { ScmChangeApplyRequest, ScmChangeApplyResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';

import { normalizePaths } from './normalizePaths';

async function applyPatchWithCheck(input: {
    cwd: string;
    patch: string;
    checkArgs: string[];
    applyArgs: string[];
    checkError: string;
    applyError: string;
}): Promise<ScmChangeApplyResponse> {
    const check = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.checkArgs,
        stdin: input.patch,
        timeoutMs: 15_000,
    });
    if (!check.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: check.stderr || input.checkError,
            stderr: check.stderr,
        };
    }

    const apply = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.applyArgs,
        stdin: input.patch,
        timeoutMs: 15_000,
    });
    return apply.success
        ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: apply.stderr || input.applyError,
            stderr: apply.stderr,
        };
}

export async function gitChangeInclude(input: {
    context: ScmBackendContext;
    request: ScmChangeApplyRequest;
}): Promise<ScmChangeApplyResponse> {
    const { context, request } = input;
    if (request.patch && request.patch.trim().length > 0) {
        return applyPatchWithCheck({
            cwd: context.cwd,
            patch: request.patch,
            checkArgs: ['apply', '--check', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
            applyArgs: ['apply', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
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
        return applyPatchWithCheck({
            cwd: context.cwd,
            patch: request.patch,
            checkArgs: [
                'apply',
                '--check',
                '--cached',
                '--reverse',
                '--unidiff-zero',
                '--recount',
                '--whitespace=nowarn',
                '-',
            ],
            applyArgs: ['apply', '--cached', '--reverse', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
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
