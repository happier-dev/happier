import type { ScmChangeDiscardRequest, ScmChangeDiscardResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { normalizePathspec, runScmCommand } from '../../../runtime';
import type { ScmBackendContext } from '../../../types';

export async function gitChangeDiscard(input: {
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

    const outputs: string[] = [];
    const errors: string[] = [];

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

        const shouldRemove = entry.kind === 'untracked' || entry.kind === 'added';
        if (shouldRemove) {
            const restore = await runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['restore', '--staged', '--worktree', '--', pathspec],
                timeoutMs: 10_000,
            });
            if (restore.stdout) outputs.push(restore.stdout);
            if (!restore.success && restore.stderr) {
                errors.push(restore.stderr);
            }

            const clean = await runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['clean', '-f', '--', pathspec],
                timeoutMs: 10_000,
            });
            if (clean.stdout) outputs.push(clean.stdout);
            if (!clean.success) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: clean.stderr || 'Failed to discard file',
                    stderr: clean.stderr,
                };
            }
            continue;
        }

        const restore = await runScmCommand({
            bin: 'git',
            cwd: context.cwd,
            args: ['restore', '--staged', '--worktree', '--', pathspec],
            timeoutMs: 10_000,
        });
        if (restore.stdout) outputs.push(restore.stdout);
        if (!restore.success) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: restore.stderr || 'Failed to discard file',
                stderr: restore.stderr,
            };
        }
        if (restore.stderr) errors.push(restore.stderr);
    }

    return {
        success: true,
        stdout: outputs.join(''),
        stderr: errors.join(''),
    };
}

