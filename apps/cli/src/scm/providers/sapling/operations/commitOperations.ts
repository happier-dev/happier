import type {
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
} from '@happier-dev/protocol';
import {
    SCM_COMMIT_MESSAGE_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
    resolveScmScopedChangedPaths,
} from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { normalizeCommitRef, normalizePathspec, runScmCommand } from '../../../runtime';

import { mapSaplingErrorCode } from '../errorCodes';
import { getSaplingHead } from '../repository';
import { parseSaplingStatusLine } from '../statusParser';

export async function saplingCommitCreate(input: {
    context: ScmBackendContext;
    request: ScmCommitCreateRequest;
}): Promise<ScmCommitCreateResponse> {
    const { context, request } = input;
    const message = (request.message ?? '').trim();
    if (!message) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Commit message cannot be empty',
        };
    }
    if (message.length > SCM_COMMIT_MESSAGE_MAX_LENGTH) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: `Commit message exceeds maximum length of ${SCM_COMMIT_MESSAGE_MAX_LENGTH} characters`,
        };
    }
    if (request.patches && request.patches.length > 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            error: 'Patch-based commit selection is not supported by Sapling backend.',
        };
    }

    const status = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: ['status', '--root-relative'],
        timeoutMs: 5000,
    });
    if (!status.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: status.stderr || 'Failed to inspect working copy',
        };
    }

    const statusEntries = status.stdout
        .split(/\r?\n/g)
        .map(parseSaplingStatusLine)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (statusEntries.length === 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
            error: 'No changes to commit',
        };
    }

    let commitArgs = ['commit', '-A', '-m', message];
    if (request.scope?.kind === 'paths') {
        const includedPaths: string[] = [];
        for (const path of request.scope.include) {
            const normalized = normalizePathspec(path, context.cwd);
            if (!normalized.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalized.error,
                };
            }
            includedPaths.push(normalized.pathspec);
        }

        const excluded = new Set<string>();
        for (const path of request.scope.exclude ?? []) {
            const normalized = normalizePathspec(path, context.cwd);
            if (!normalized.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalized.error,
                };
            }
            excluded.add(normalized.pathspec);
        }

        const candidateScopePaths = includedPaths.filter((path) => !excluded.has(path));
        if (candidateScopePaths.length === 0) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Commit scope excludes all included paths',
            };
        }

        const scopedChangedPaths = resolveScmScopedChangedPaths({
            changedPaths: statusEntries.map((entry) => entry.path),
            include: candidateScopePaths,
            exclude: Array.from(excluded),
        });
        if (scopedChangedPaths.length === 0) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                error: 'No pending changes match the requested commit scope',
            };
        }

        commitArgs = ['commit', '-A', '-m', message, ...scopedChangedPaths];
    }

    const commit = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: commitArgs,
        timeoutMs: 20_000,
    });
    if (!commit.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: commit.stderr || 'Commit failed',
        };
    }

    const sha = await getSaplingHead(context.cwd);
    return {
        success: true,
        commitSha: sha ?? undefined,
    };
}

export async function saplingCommitBackout(input: {
    context: ScmBackendContext;
    request: ScmCommitBackoutRequest;
}): Promise<ScmCommitBackoutResponse> {
    const { context, request } = input;
    const commitRef = normalizeCommitRef(request.commit);
    if (!commitRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: commitRef.error,
        };
    }

    const status = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: ['status', '--root-relative'],
        timeoutMs: 5000,
    });
    if (!status.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: status.stderr || 'Failed to inspect working copy',
        };
    }
    if (status.stdout.trim().length > 0) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Working copy must be clean before backout',
        };
    }

    const backout = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: ['backout', '--rev', commitRef.commit],
        timeoutMs: 20_000,
    });

    return backout.success
        ? { success: true, stdout: backout.stdout, stderr: backout.stderr }
        : {
            success: false,
            errorCode: mapSaplingErrorCode(backout.stderr),
            error: backout.stderr || 'Backout failed',
            stderr: backout.stderr,
        };
}
