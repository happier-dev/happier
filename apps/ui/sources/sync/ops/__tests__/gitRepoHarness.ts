import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
    createGitScmCapabilities,
    createScmCapabilities,
    isScmPatchBoundToPath,
    mapGitScmErrorCode,
    normalizeScmRemoteRequest,
    SCM_COMMIT_PATCH_MAX_COUNT,
    SCM_COMMIT_PATCH_MAX_LENGTH,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export function git(cwd: string, args: string[], env?: Record<string, string | undefined>): string {
    return execFileSync('git', args, {
        cwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function runGit(
    cwd: string,
    args: string[],
    input?: string,
    env?: Record<string, string | undefined>,
): { success: true; stdout: string; stderr: string } | { success: false; stderr: string } {
    try {
        const stdout = execFileSync('git', args, {
            cwd,
            ...(env ? { env: { ...process.env, ...env } } : {}),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(input !== undefined ? { input } : {}),
        }).trim();
        return { success: true, stdout, stderr: '' };
    } catch (error) {
        const stderr = error instanceof Error && 'stderr' in error
            ? String((error as any).stderr || '')
            : error instanceof Error
                ? error.message
                : String(error);
        return { success: false, stderr };
    }
}

function readHasStagedChanges(
    cwd: string,
    env?: Record<string, string | undefined>,
): { success: true; hasStagedChanges: boolean } | { success: false; error: string } {
    try {
        execFileSync('git', ['diff', '--cached', '--quiet'], {
            cwd,
            ...(env ? { env: { ...process.env, ...env } } : {}),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { success: true, hasStagedChanges: false };
    } catch (error) {
        const exitCode = typeof error === 'object' && error && 'status' in error
            ? Number((error as any).status)
            : null;
        if (exitCode === 1) {
            return { success: true, hasStagedChanges: true };
        }
        const stderr = error instanceof Error && 'stderr' in error
            ? String((error as any).stderr || '')
            : error instanceof Error
                ? error.message
                : String(error);
        return { success: false, error: stderr || 'Failed to inspect staged changes' };
    }
}

type GitHarnessTempIndex = {
    env: Record<string, string>;
    cleanup: () => void;
};

function createGitHarnessTempIndex(
    cwd: string,
    seed: 'head-or-empty' | 'current-index',
): { success: true; tempIndex: GitHarnessTempIndex } | { success: false; error: string } {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-ui-git-index-'));
    const indexPath = join(tempDir, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    const cleanup = () => {
        rmSync(tempDir, { recursive: true, force: true });
    };

    if (seed === 'current-index') {
        const rawIndexPath = runGit(cwd, ['rev-parse', '--git-path', 'index']);
        if (!rawIndexPath.success) {
            cleanup();
            return { success: false, error: rawIndexPath.stderr || 'Failed to resolve repository index path' };
        }
        const indexSource = rawIndexPath.stdout.trim();
        const absoluteIndexPath = isAbsolute(indexSource) ? indexSource : resolve(cwd, indexSource);
        if (existsSync(absoluteIndexPath)) {
            copyFileSync(absoluteIndexPath, indexPath);
        } else {
            writeFileSync(indexPath, '');
        }
        return { success: true, tempIndex: { env, cleanup } };
    }

    writeFileSync(indexPath, '');
    const readHead = runGit(cwd, ['read-tree', 'HEAD'], undefined, env);
    if (!readHead.success) {
        const readEmpty = runGit(cwd, ['read-tree', '--empty'], undefined, env);
        if (!readEmpty.success) {
            cleanup();
            return {
                success: false,
                error: readHead.stderr || readEmpty.stderr || 'Failed to initialize temporary commit index',
            };
        }
    }
    return { success: true, tempIndex: { env, cleanup } };
}

function isRepo(cwd: string): boolean {
    try {
        return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
    } catch {
        return false;
    }
}

function tryGit(cwd: string, args: string[]): string | null {
    try {
        return git(cwd, args);
    } catch {
        return null;
    }
}

function splitNonEmptyLines(value: string): string[] {
    return value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function sumNumstat(cwd: string, staged: boolean): { added: number; removed: number } {
    const args = staged
        ? ['diff', '--cached', '--numstat']
        : ['diff', '--numstat'];
    const output = git(cwd, args);
    if (!output) {
        return { added: 0, removed: 0 };
    }
    return output.split('\n').reduce(
        (acc, row) => {
            const [added, removed] = row.split('\t');
            acc.added += added === '-' ? 0 : Number(added);
            acc.removed += removed === '-' ? 0 : Number(removed);
            return acc;
        },
        { added: 0, removed: 0 }
    );
}

function buildSnapshot(cwd: string) {
    const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
    const headName = tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']) ?? '';
    const detached = !headName;
    const upstream = tryGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) ?? '';
    const aheadBehind = upstream
        ? git(cwd, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
        : '0\t0';
    const [behindRaw, aheadRaw] = aheadBehind.split(/\s+/);
    const includedFiles = splitNonEmptyLines(git(cwd, ['diff', '--cached', '--name-only']));
    const pendingFiles = splitNonEmptyLines(git(cwd, ['diff', '--name-only']));
    const untrackedFiles = splitNonEmptyLines(git(cwd, ['ls-files', '--others', '--exclude-standard']));
    const stagedStats = sumNumstat(cwd, true);
    const unstagedStats = sumNumstat(cwd, false);

    const paths = new Set<string>([...includedFiles, ...pendingFiles, ...untrackedFiles]);
    const entries = Array.from(paths).map((path) => {
        const isUntracked = untrackedFiles.includes(path);
        const hasIncludedDelta = includedFiles.includes(path);
        const hasPendingDelta = pendingFiles.includes(path) || isUntracked;
        return {
            path,
            previousPath: null,
            kind: isUntracked ? 'untracked' : 'modified',
            includeStatus: hasIncludedDelta ? 'M' : '.',
            pendingStatus: hasPendingDelta ? 'M' : '.',
            hasIncludedDelta,
            hasPendingDelta,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                isBinary: false,
            },
        };
    });

    return {
        projectKey: `local:${repoRoot}`,
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: repoRoot, backendId: 'git', mode: '.git' as const },
        capabilities: createGitScmCapabilities(),
        branch: {
            head: headName || null,
            upstream: upstream || null,
            ahead: Number(aheadRaw || 0),
            behind: Number(behindRaw || 0),
            detached,
        },
        stashCount: splitNonEmptyLines(git(cwd, ['stash', 'list'])).length,
        hasConflicts: splitNonEmptyLines(git(cwd, ['diff', '--name-only', '--diff-filter=U'])).length > 0,
        entries,
        totals: {
            includedFiles: includedFiles.length,
            pendingFiles: pendingFiles.length,
            untrackedFiles: untrackedFiles.length,
            includedAdded: stagedStats.added,
            includedRemoved: stagedStats.removed,
            pendingAdded: unstagedStats.added,
            pendingRemoved: unstagedStats.removed,
        },
    };
}

export function createGitSessionRpcHarness(workspace: string) {
    return async (_sessionId: string, method: string, request: any) => {
        const cwd = resolve(workspace, request?.cwd ?? '.');

        if (method === RPC_METHODS.SCM_STATUS_SNAPSHOT) {
            if (!isRepo(cwd)) {
                return {
                    success: true,
                    snapshot: {
                        projectKey: `local:${cwd}`,
                        fetchedAt: Date.now(),
                        repo: { isRepo: false, rootPath: null, backendId: null, mode: null },
                        capabilities: createScmCapabilities(),
                        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
                        stashCount: 0,
                        hasConflicts: false,
                        entries: [],
                        totals: {
                            includedFiles: 0,
                            pendingFiles: 0,
                            untrackedFiles: 0,
                            includedAdded: 0,
                            includedRemoved: 0,
                            pendingAdded: 0,
                            pendingRemoved: 0,
                        },
                    },
                };
            }

            return {
                success: true,
                snapshot: buildSnapshot(cwd),
            };
        }

        if (!isRepo(cwd)) {
            return {
                success: false,
                error: 'Not a git repository',
                errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            };
        }

        if (method === RPC_METHODS.SCM_CHANGE_INCLUDE) {
            const patch = typeof request?.patch === 'string' ? request.patch : '';
            if (patch.trim()) {
                const check = runGit(cwd, ['apply', '--check', '--cached', '--unidiff-zero', '--recount', '-'], patch);
                if (!check.success) {
                    return {
                        success: false,
                        error: check.stderr || 'Patch check failed',
                        errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                        stderr: check.stderr,
                    };
                }
                const apply = runGit(cwd, ['apply', '--cached', '--unidiff-zero', '--recount', '-'], patch);
                return apply.success
                    ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
                    : {
                        success: false,
                        error: apply.stderr || 'Patch apply failed',
                        errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                        stderr: apply.stderr,
                    };
            }

            const paths = request?.paths as string[] | undefined;
            if (!paths || paths.length === 0) {
                return {
                    success: false,
                    error: 'Missing paths',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            git(cwd, ['add', '--', ...paths]);
            return { success: true, stdout: '', stderr: '' };
        }

        if (method === RPC_METHODS.SCM_CHANGE_EXCLUDE) {
            const patch = typeof request?.patch === 'string' ? request.patch : '';
            if (patch.trim()) {
                const check = runGit(cwd, ['apply', '--check', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'], patch);
                if (!check.success) {
                    return {
                        success: false,
                        error: check.stderr || 'Patch reverse-check failed',
                        errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                        stderr: check.stderr,
                    };
                }
                const apply = runGit(cwd, ['apply', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'], patch);
                return apply.success
                    ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
                    : {
                        success: false,
                        error: apply.stderr || 'Patch reverse apply failed',
                        errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                        stderr: apply.stderr,
                    };
            }

            const paths = request?.paths as string[] | undefined;
            if (!paths || paths.length === 0) {
                return {
                    success: false,
                    error: 'Missing paths',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            git(cwd, ['reset', '--', ...paths]);
            return { success: true, stdout: '', stderr: '' };
        }

        if (method === RPC_METHODS.SCM_COMMIT_CREATE) {
            const message = (request?.message as string | undefined)?.trim();
            if (!message) {
                return {
                    success: false,
                    error: 'Commit message is required',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const patches = Array.isArray(request?.patches)
                ? request.patches.filter((value: unknown): value is { path: string; patch: string } => {
                    if (!value || typeof value !== 'object') return false;
                    const candidate = value as { path?: unknown; patch?: unknown };
                    return typeof candidate.path === 'string'
                        && candidate.path.length > 0
                        && typeof candidate.patch === 'string'
                        && candidate.patch.trim().length > 0;
                })
                : [];
            const scope = request?.scope as
                | { kind: 'all-pending' }
                | { kind: 'paths'; include: string[]; exclude?: string[] }
                | undefined;
            if (patches.length > SCM_COMMIT_PATCH_MAX_COUNT) {
                return {
                    success: false,
                    error: `Patch selection exceeds maximum count of ${SCM_COMMIT_PATCH_MAX_COUNT}`,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }

            const normalizedPatchPathSet = new Set<string>();
            for (const patchSelection of patches) {
                if (patchSelection.patch.length > SCM_COMMIT_PATCH_MAX_LENGTH) {
                    return {
                        success: false,
                        error: `Patch selection exceeds maximum size of ${SCM_COMMIT_PATCH_MAX_LENGTH} characters`,
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    };
                }
                const normalizedPath = patchSelection.path.trim();
                if (!normalizedPath) {
                    return {
                        success: false,
                        error: 'Patch selection path is required',
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    };
                }
                if (!isScmPatchBoundToPath(normalizedPath, patchSelection.patch)) {
                    return {
                        success: false,
                        error: `Patch content is not bound to declared path: ${normalizedPath}`,
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    };
                }
                normalizedPatchPathSet.add(normalizedPath);
            }
            if (patches.length > 0 && scope?.kind === 'all-pending') {
                return {
                    success: false,
                    error: 'Patch selection cannot be combined with all-pending commit scope',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const usesIsolatedIndex = Boolean(scope) || patches.length > 0;
            const indexResetPaths = new Set<string>();
            if (scope?.kind !== 'all-pending') {
                for (const patchPath of normalizedPatchPathSet) {
                    indexResetPaths.add(patchPath);
                }
            }

            const tempIndex = usesIsolatedIndex
                ? createGitHarnessTempIndex(cwd, scope?.kind === 'all-pending' ? 'current-index' : 'head-or-empty')
                : null;
            if (tempIndex && !tempIndex.success) {
                return {
                    success: false,
                    error: tempIndex.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                };
            }

            const gitEnv = tempIndex?.success ? tempIndex.tempIndex.env : undefined;
            try {
                if (scope?.kind === 'all-pending') {
                    const addAll = runGit(cwd, ['add', '-A'], undefined, gitEnv);
                    if (!addAll.success) {
                        return {
                            success: false,
                            error: addAll.stderr || 'Failed to stage pending changes',
                            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                        };
                    }
                }

                if (scope?.kind === 'paths') {
                    const include = Array.isArray(scope.include)
                        ? scope.include
                            .filter((value) => typeof value === 'string' && value.length > 0)
                            .map((value) => value.trim())
                        : [];
                    if (include.length === 0) {
                        return {
                            success: false,
                            error: 'Commit scope include list is required',
                            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                        };
                    }
                    for (const includedPath of include) {
                        indexResetPaths.add(includedPath);
                    }

                    const exclude = Array.isArray(scope.exclude)
                        ? scope.exclude
                            .filter((value) => typeof value === 'string' && value.length > 0)
                            .map((value) => value.trim())
                        : [];
                    const excludedSet = new Set(exclude);
                    const effectiveScope = new Set(include.filter((path) => !excludedSet.has(path)));
                    for (const path of normalizedPatchPathSet) {
                        effectiveScope.delete(path);
                    }

                    if (effectiveScope.size === 0 && patches.length === 0) {
                        return {
                            success: false,
                            error: 'Commit scope excludes all included paths',
                            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                        };
                    }

                    if (effectiveScope.size > 0) {
                        const addScoped = runGit(cwd, ['add', '-A', '--', ...Array.from(effectiveScope)], undefined, gitEnv);
                        if (!addScoped.success) {
                            return {
                                success: false,
                                error: addScoped.stderr || 'Failed to stage scoped commit paths',
                                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                            };
                        }
                        const effectiveExclude = exclude.filter((path) => !normalizedPatchPathSet.has(path));
                        if (effectiveExclude.length > 0) {
                            const resetExcluded = runGit(cwd, ['reset', '--', ...effectiveExclude], undefined, gitEnv);
                            if (!resetExcluded.success) {
                                return {
                                    success: false,
                                    error: resetExcluded.stderr || 'Failed to exclude scoped commit paths',
                                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                                };
                            }
                        }
                    }
                }

                if (patches.length > 0) {
                    for (const patchSelection of patches) {
                        const check = runGit(
                            cwd,
                            ['apply', '--check', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
                            patchSelection.patch,
                            gitEnv,
                        );
                        if (!check.success) {
                            return {
                                success: false,
                                error: check.stderr || 'Patch check failed',
                                errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                            };
                        }
                        const apply = runGit(
                            cwd,
                            ['apply', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'],
                            patchSelection.patch,
                            gitEnv,
                        );
                        if (!apply.success) {
                            return {
                                success: false,
                                error: apply.stderr || 'Patch apply failed',
                                errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
                            };
                        }
                    }
                }

                const hasStaged = readHasStagedChanges(cwd, gitEnv);
                if (!hasStaged.success) {
                    return {
                        success: false,
                        error: hasStaged.error,
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    };
                }
                if (!hasStaged.hasStagedChanges) {
                    return {
                        success: false,
                        error: 'No included changes to commit',
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                    };
                }

                const commit = runGit(cwd, ['commit', '-m', message], undefined, gitEnv);
                if (!commit.success) {
                    return {
                        success: false,
                        error: commit.stderr || 'Commit failed',
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    };
                }

                if (usesIsolatedIndex) {
                    if (scope?.kind === 'all-pending') {
                        runGit(cwd, ['reset', '--mixed', 'HEAD']);
                    } else if (indexResetPaths.size > 0) {
                        runGit(cwd, ['reset', '--mixed', 'HEAD', '--', ...Array.from(indexResetPaths)]);
                    }
                }

                return {
                    success: true,
                    commitSha: git(cwd, ['rev-parse', 'HEAD']),
                };
            } finally {
                if (tempIndex?.success) {
                    tempIndex.tempIndex.cleanup();
                }
            }
        }

        if (method === RPC_METHODS.SCM_LOG_LIST) {
            const limit = Number(request?.limit ?? 50);
            const skip = Number(request?.skip ?? 0);
            const raw = git(cwd, [
                'log',
                `--max-count=${limit}`,
                `--skip=${skip}`,
                '--date=unix',
                '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e',
            ]);
            const entries = raw
                .split('\x1e')
                .map((row) => row.trim())
                .filter(Boolean)
                .map((row) => {
                    const [sha, shortSha, authorName, authorEmail, timestamp, subject, body = ''] = row.split('\x1f');
                    return {
                        sha,
                        shortSha,
                        authorName,
                        authorEmail,
                        timestamp: Number(timestamp),
                        subject,
                        body,
                    };
                });
            return {
                success: true,
                entries,
            };
        }

        if (method === RPC_METHODS.SCM_REMOTE_FETCH) {
            const normalized = normalizeScmRemoteRequest({
                remote: request?.remote as string | undefined,
                branch: request?.branch as string | undefined,
            });
            if (!normalized.ok) {
                return {
                    success: false,
                    error: normalized.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const remote = normalized.request.remote || 'origin';
            const fetch = runGit(cwd, ['fetch', '--prune', remote]);
            return fetch.success
                ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
                : {
                    success: false,
                    error: fetch.stderr || 'Fetch failed',
                    errorCode: mapGitScmErrorCode(fetch.stderr),
                    stderr: fetch.stderr,
                };
        }

        if (method === RPC_METHODS.SCM_REMOTE_PUSH) {
            const normalized = normalizeScmRemoteRequest({
                remote: request?.remote as string | undefined,
                branch: request?.branch as string | undefined,
            });
            if (!normalized.ok) {
                return {
                    success: false,
                    error: normalized.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const snapshot = buildSnapshot(cwd);
            const hasExplicitRemoteOrBranch = Boolean(normalized.request.remote || normalized.request.branch);
            if (!hasExplicitRemoteOrBranch && !snapshot.branch.upstream) {
                return {
                    success: false,
                    error: 'Set an upstream branch before push.',
                    errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Push is unavailable while HEAD is detached',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts) {
                return {
                    success: false,
                    error: 'Resolve conflicts before pushing.',
                    errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }
            if (snapshot.branch.behind > 0) {
                return {
                    success: false,
                    error: 'Local branch is behind upstream. Pull before pushing.',
                    errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                };
            }
            const args = ['push'];
            const remote = normalized.request.remote;
            const branch = normalized.request.branch;
            if (remote) {
                args.push(remote);
                if (branch) args.push(branch);
            } else if (branch) {
                args.push('origin', branch);
            }
            const push = runGit(cwd, args);
            return push.success
                ? { success: true, stdout: push.stdout, stderr: push.stderr }
                : {
                    success: false,
                    error: push.stderr || 'Push failed',
                    errorCode: mapGitScmErrorCode(push.stderr),
                    stderr: push.stderr,
                };
        }

        if (method === RPC_METHODS.SCM_REMOTE_PULL) {
            const normalized = normalizeScmRemoteRequest({
                remote: request?.remote as string | undefined,
                branch: request?.branch as string | undefined,
            });
            if (!normalized.ok) {
                return {
                    success: false,
                    error: normalized.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const snapshot = buildSnapshot(cwd);
            const hasExplicitRemoteOrBranch = Boolean(normalized.request.remote || normalized.request.branch);
            if (!hasExplicitRemoteOrBranch && !snapshot.branch.upstream) {
                return {
                    success: false,
                    error: 'Set an upstream branch before pull.',
                    errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Pull is unavailable while HEAD is detached',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts || snapshot.entries.length > 0) {
                return {
                    success: false,
                    error: 'Working tree must be clean before pull',
                    errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }
            const args = ['pull', '--ff-only'];
            const remote = normalized.request.remote;
            const branch = normalized.request.branch;
            if (remote) {
                args.push(remote);
                if (branch) args.push(branch);
            } else if (branch) {
                args.push('origin', branch);
            }
            const pull = runGit(cwd, args);
            return pull.success
                ? { success: true, stdout: pull.stdout, stderr: pull.stderr }
                : {
                    success: false,
                    error: pull.stderr || 'Pull failed',
                    errorCode: mapGitScmErrorCode(pull.stderr),
                    stderr: pull.stderr,
                };
        }

        if (method === RPC_METHODS.SCM_COMMIT_BACKOUT) {
            const snapshot = buildSnapshot(cwd);
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Revert is unavailable while HEAD is detached',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts || snapshot.entries.length > 0) {
                return {
                    success: false,
                    error: 'Working tree must be clean before revert',
                    errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }

            const commit = String(request?.commit ?? '').trim();
            if (!commit) {
                return {
                    success: false,
                    error: 'Commit reference cannot be empty',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }

            const revert = runGit(cwd, ['revert', '--no-edit', commit]);
            if (revert.success) {
                return {
                    success: true,
                    stdout: revert.stdout,
                    stderr: revert.stderr,
                };
            }

            const lower = revert.stderr.toLowerCase();
            if (lower.includes('is a merge but no -m option was given')) {
                return {
                    success: false,
                    error: 'Cannot revert merge commit without selecting a mainline parent.',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    stderr: revert.stderr,
                };
            }

            return {
                success: false,
                error: revert.stderr || 'Revert failed',
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                stderr: revert.stderr,
            };
        }

        throw new Error(`Unsupported test method: ${method}`);
    };
}

export function initRepo(cwd: string): void {
    git(cwd, ['init']);
    // Enforce a deterministic initial branch name in test repos.
    // CI images may still default `git init` to "master" unless configured otherwise.
    git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(cwd, ['config', 'user.email', 'test@example.com']);
    git(cwd, ['config', 'user.name', 'Test User']);
}
