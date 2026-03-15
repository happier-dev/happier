import { rmSync } from 'fs';
import path from 'node:path';

import type { ScmChangeApplyResponse, ScmChangeDiscardRequest, ScmChangeDiscardResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { normalizePathspec, runScmCommand } from '../../../runtime';

export function saplingChangeInclude(): ScmChangeApplyResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'Sapling backend does not support include operations in this version',
    };
}

export function saplingChangeExclude(): ScmChangeApplyResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: 'Sapling backend does not support exclude operations in this version',
    };
}

export async function saplingChangeDiscard(input: {
    context: ScmBackendContext;
    request: ScmChangeDiscardRequest;
}): Promise<ScmChangeDiscardResponse> {
    const { context, request } = input;
    const entries = request.entries ?? [];
    if (entries.length === 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: '`entries` must be provided',
        };
    }

    const revertPaths: string[] = [];
    const removePaths: string[] = [];

    for (const entry of entries) {
        const normalized = normalizePathspec(entry.path, context.cwd);
        if (!normalized.ok) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                error: normalized.error,
            };
        }

        const pathspec = normalized.pathspec;
        if (entry.kind === 'untracked') {
            removePaths.push(pathspec);
        } else {
            revertPaths.push(pathspec);
            if (entry.kind === 'added') {
                removePaths.push(pathspec);
            }
        }
    }

    if (revertPaths.length > 0) {
        const revert = await runScmCommand({
            bin: 'sl',
            cwd: context.cwd,
            args: ['revert', '--no-backup', '--', ...revertPaths],
            timeoutMs: 15_000,
        });
        if (!revert.success) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: revert.stderr || 'Failed to discard files',
                stderr: revert.stderr,
            };
        }
    }

    for (const entry of removePaths) {
        const absolutePath = path.join(context.cwd, entry);
        try {
            rmSync(absolutePath, { force: true, recursive: true });
        } catch (error) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: error instanceof Error ? error.message : 'Failed to remove file',
            };
        }
    }

    return { success: true };
}
