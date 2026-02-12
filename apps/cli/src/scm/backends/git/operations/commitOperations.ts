import type {
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
} from '@happier-dev/protocol';
import {
    SCM_COMMIT_MESSAGE_MAX_LENGTH,
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
    isScmPatchBoundToPath,
} from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { normalizeCommitRef, runScmCommand } from '../../../runtime';
import { mapGitErrorCode } from '../remote';
import {
    applyPatchToIndex,
    createGitTemporaryIndex,
    type GitTemporaryIndex,
    runGitCommand,
} from './commitExecutionRuntime';

import { normalizePaths } from './normalizePaths';
import { hasAnyIncludedOrPendingChanges, readGitSnapshotForChecks } from './snapshotChecks';

function parseZTerminatedTokens(input: string): string[] {
    // Git uses `\0` as a separator for `-z` outputs; a trailing separator is common.
    if (!input) {
        return [];
    }
    return input.split('\0').filter(Boolean);
}

function parseGitNameStatusZPaths(input: string): Set<string> {
    const tokens = parseZTerminatedTokens(input);
    const paths = new Set<string>();

    for (let i = 0; i < tokens.length; i += 1) {
        const statusToken = tokens[i];
        if (!statusToken) {
            continue;
        }

        const statusCode = statusToken[0];
        if (statusCode === 'R' || statusCode === 'C') {
            const oldPath = tokens[i + 1];
            const newPath = tokens[i + 2];
            if (oldPath) {
                paths.add(oldPath);
            }
            if (newPath) {
                paths.add(newPath);
            }
            i += 2;
            continue;
        }

        const path = tokens[i + 1];
        if (path) {
            paths.add(path);
        }
        i += 1;
    }

    return paths;
}

export async function gitCommitCreate(input: {
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

    const hasPatchSelection = Array.isArray(request.patches) && request.patches.length > 0;
    if (hasPatchSelection && request.scope?.kind === 'all-pending') {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Patch selection cannot be combined with all-pending commit scope',
        };
    }

    const normalizedPatchPathSet = new Set<string>();
    if (hasPatchSelection) {
        if ((request.patches?.length ?? 0) > SCM_COMMIT_PATCH_MAX_COUNT) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: `Patch selection exceeds maximum count of ${SCM_COMMIT_PATCH_MAX_COUNT}`,
            };
        }

        for (const patch of request.patches ?? []) {
            if (patch.patch.length > SCM_COMMIT_PATCH_MAX_LENGTH) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: `Patch selection exceeds maximum size of ${SCM_COMMIT_PATCH_MAX_LENGTH} characters`,
                };
            }

            const patchText = patch.patch?.trim() ?? '';
            if (!patchText) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Patch selection contains an empty patch',
                };
            }

            const normalizedPatchPath = normalizePaths([patch.path], context.cwd);
            if (!normalizedPatchPath.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedPatchPath.error,
                };
            }
            const normalizedDeclaredPath = normalizedPatchPath.normalizedPaths[0]!;
            if (!isScmPatchBoundToPath(normalizedDeclaredPath, patch.patch)) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: `Patch content is not bound to declared path: ${normalizedDeclaredPath}`,
                };
            }
            normalizedPatchPathSet.add(normalizedDeclaredPath);
        }
    }

    const usesIsolatedIndex = Boolean(request.scope) || hasPatchSelection;
    let temporaryIndex: GitTemporaryIndex | null = null;
    if (usesIsolatedIndex) {
        const tempIndex = await createGitTemporaryIndex({
            cwd: context.cwd,
            seed: request.scope?.kind === 'all-pending' ? 'current-index' : 'head-or-empty',
        });
        if (!tempIndex.success) {
            return tempIndex;
        }
        temporaryIndex = tempIndex.tempIndex;
    }
    const gitEnv = temporaryIndex?.env;

    // Snapshot the current live index selection so atomic commits can synchronize safely without
    // clobbering other actors' staged changes.
    const preStagedPathsResult = usesIsolatedIndex
        ? await runGitCommand({
            cwd: context.cwd,
            args: ['diff', '--cached', '--name-status', '-z'],
            timeoutMs: 5000,
        })
        : null;
    const preStagedPathSet = preStagedPathsResult?.success
        ? parseGitNameStatusZPaths(preStagedPathsResult.stdout)
        : new Set<string>();

    try {
        if (request.scope?.kind === 'all-pending') {
            const stageAll = await runGitCommand({
                cwd: context.cwd,
                args: ['add', '-A'],
                timeoutMs: 10_000,
                env: gitEnv,
            });
            if (!stageAll.success) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: stageAll.stderr || 'Failed to stage pending changes',
                };
            }
        }

        if (request.scope?.kind === 'paths') {
            const normalizedInclude = normalizePaths(request.scope.include, context.cwd);
            if (!normalizedInclude.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedInclude.error,
                };
            }

            const normalizedExclude = request.scope.exclude && request.scope.exclude.length > 0
                ? normalizePaths(request.scope.exclude, context.cwd)
                : { ok: true as const, normalizedPaths: [] as string[] };
            if (!normalizedExclude.ok) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    error: normalizedExclude.error,
                };
            }

            const excludedSet = new Set(normalizedExclude.normalizedPaths);
            const effectiveScope = new Set(normalizedInclude.normalizedPaths.filter((path) => !excludedSet.has(path)));
            if (hasPatchSelection) {
                for (const path of normalizedPatchPathSet) {
                    effectiveScope.delete(path);
                }
            }
            if (effectiveScope.size === 0 && !hasPatchSelection) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: 'Commit scope excludes all included paths',
                };
            }

            if (effectiveScope.size > 0) {
                const includeResult = await runGitCommand({
                    cwd: context.cwd,
                    args: ['add', '-A', '--', ...Array.from(effectiveScope)],
                    timeoutMs: 10_000,
                    env: gitEnv,
                });
                if (!includeResult.success) {
                    return {
                        success: false,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        error: includeResult.stderr || 'Failed to stage scoped commit paths',
                    };
                }

                const effectiveExclude = normalizedExclude.normalizedPaths.filter((path) => !normalizedPatchPathSet.has(path));
                if (effectiveExclude.length > 0) {
                    const excludeResult = await runGitCommand({
                        cwd: context.cwd,
                        args: ['reset', '--', ...effectiveExclude],
                        timeoutMs: 10_000,
                        env: gitEnv,
                    });
                    if (!excludeResult.success) {
                        return {
                            success: false,
                            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                            error: excludeResult.stderr || 'Failed to exclude scoped commit paths',
                        };
                    }
                }
            }
        }

        if (hasPatchSelection) {
            for (const patch of request.patches ?? []) {
                const patchResult = await applyPatchToIndex({
                    cwd: context.cwd,
                    patch: patch.patch,
                    env: gitEnv,
                });
                if (patchResult) {
                    return patchResult;
                }
            }
        }

        const hasIncludedChanges = await runGitCommand({
            cwd: context.cwd,
            args: ['diff', '--cached', '--quiet'],
            timeoutMs: 5000,
            env: gitEnv,
        });
        if (!hasIncludedChanges.success && hasIncludedChanges.exitCode !== 1) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: hasIncludedChanges.stderr
                    ? `Failed to inspect included changes: ${hasIncludedChanges.stderr}`
                    : 'Failed to inspect included changes',
            };
        }
        if (hasIncludedChanges.exitCode === 0) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                error: 'No included changes to commit',
            };
        }

        const commit = await runGitCommand({
            cwd: context.cwd,
            args: ['commit', '-m', message],
            timeoutMs: 20_000,
            env: gitEnv,
        });
        if (!commit.success) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: commit.stderr || 'Commit failed',
            };
        }

        const sha = await runGitCommand({
            cwd: context.cwd,
            args: ['rev-parse', 'HEAD'],
            timeoutMs: 5000,
        });
        const commitSha = sha.success ? sha.stdout.trim() : undefined;

        let liveIndexSyncError: string | null = null;
        if (usesIsolatedIndex) {
            if (!commitSha) {
                liveIndexSyncError = 'Failed to resolve commit SHA for post-commit index synchronization';
            } else {
                // Synchronize live index entries for files touched by the commit so the live index doesn't appear
                // "staged against HEAD" due to HEAD advancing in an isolated index.
                // Important: do not reset paths that were already staged in the live index.
                const touched = await runGitCommand({
                    cwd: context.cwd,
                    args: ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', commitSha],
                    timeoutMs: 5000,
                });
                if (!touched.success) {
                    if (preStagedPathSet.size === 0) {
                        // Safe fallback: no live staging to preserve, so we can fully resync.
                        const resetAll = await runGitCommand({
                            cwd: context.cwd,
                            args: ['reset', '--mixed', 'HEAD'],
                            timeoutMs: 10_000,
                        });
                        if (!resetAll.success) {
                            liveIndexSyncError = resetAll.stderr || 'Failed to synchronize live index after commit';
                        }
                    } else {
                        liveIndexSyncError =
                            touched.stderr || 'Failed to compute commit paths for safe live index synchronization';
                    }
                } else {
                    const touchedPaths = parseGitNameStatusZPaths(touched.stdout);
                    const pathsToReset = Array.from(touchedPaths).filter((p) => !preStagedPathSet.has(p));
                    if (pathsToReset.length > 0) {
                        const resetResult = await runGitCommand({
                            cwd: context.cwd,
                            args: ['reset', '--mixed', 'HEAD', '--', ...pathsToReset],
                            timeoutMs: 10_000,
                        });
                        if (!resetResult.success) {
                            liveIndexSyncError = resetResult.stderr || 'Failed to synchronize live index after commit';
                        }
                    }
                }
            }
        }

        if (liveIndexSyncError) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: `Commit was created, but live index synchronization failed: ${liveIndexSyncError}`,
                commitSha,
            };
        }
        return {
            success: true,
            commitSha,
        };
    } finally {
        temporaryIndex?.cleanup();
    }
}

export async function gitCommitBackout(input: {
    context: ScmBackendContext;
    request: ScmCommitBackoutRequest;
}): Promise<ScmCommitBackoutResponse> {
    const { context, request } = input;
    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) {
        return {
            success: false,
            errorCode: snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: snapshotResponse.error || 'Failed to evaluate repository state',
        };
    }

    const snapshot = snapshotResponse.snapshot;
    if (snapshot.branch.detached) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Backout is unavailable while HEAD is detached',
        };
    }
    if (hasAnyIncludedOrPendingChanges(snapshot) || snapshot.hasConflicts) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
            error: 'Working tree must be clean before backout',
        };
    }

    const commitRef = normalizeCommitRef(request.commit);
    if (!commitRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: commitRef.error,
        };
    }

    const parents = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-list', '--parents', '-n', '1', commitRef.commit],
        timeoutMs: 5000,
    });
    if (!parents.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: parents.stderr || 'Failed to inspect commit parents',
        };
    }

    const parentTokens = parents.stdout.trim().split(/\s+/).filter((token) => token.length > 0);
    if (parentTokens.length > 2) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: 'Backout for merge commits is not supported yet.',
        };
    }

    const backout = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['revert', '--no-edit', commitRef.commit],
        timeoutMs: 20_000,
    });
    return backout.success
        ? { success: true, stdout: backout.stdout, stderr: backout.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(backout.stderr),
            error: backout.stderr || 'Failed to backout commit',
            stderr: backout.stderr,
        };
}
