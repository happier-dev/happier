import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

export function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function runGit(
    cwd: string,
    args: string[],
    input?: string
): { success: true; stdout: string; stderr: string } | { success: false; stderr: string } {
    try {
        const stdout = execFileSync('git', args, {
            cwd,
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

function isGitRepo(cwd: string): boolean {
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

function mapGitErrorCode(stderr: string): (typeof GIT_OPERATION_ERROR_CODES)[keyof typeof GIT_OPERATION_ERROR_CODES] {
    const lower = stderr.toLowerCase();
    if (lower.includes('not a git repository')) {
        return GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO;
    }
    if (lower.includes('no such remote') || lower.includes('does not appear to be a git repository')) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND;
    }
    if (
        lower.includes('authentication failed') ||
        lower.includes('permission denied') ||
        lower.includes('could not read username') ||
        lower.includes('terminal prompts disabled')
    ) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED;
    }
    if (
        lower.includes('no upstream configured') ||
        lower.includes('has no upstream branch') ||
        lower.includes('no tracking information for the current branch')
    ) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED;
    }
    if (
        lower.includes('non-fast-forward') ||
        lower.includes('fetch first') ||
        lower.includes('tip of your current branch is behind')
    ) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD;
    }
    if (lower.includes('not possible to fast-forward') || (lower.includes('ff-only') && lower.includes('aborting'))) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED;
    }
    if (
        lower.includes('remote rejected') ||
        lower.includes('pre-receive hook declined') ||
        lower.includes('protected branch hook declined')
    ) {
        return GIT_OPERATION_ERROR_CODES.REMOTE_REJECTED;
    }
    return GIT_OPERATION_ERROR_CODES.COMMAND_FAILED;
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
    const stagedFiles = splitNonEmptyLines(git(cwd, ['diff', '--cached', '--name-only']));
    const unstagedFiles = splitNonEmptyLines(git(cwd, ['diff', '--name-only']));
    const untrackedFiles = splitNonEmptyLines(git(cwd, ['ls-files', '--others', '--exclude-standard']));
    const stagedStats = sumNumstat(cwd, true);
    const unstagedStats = sumNumstat(cwd, false);

    const paths = new Set<string>([...stagedFiles, ...unstagedFiles, ...untrackedFiles]);
    const entries = Array.from(paths).map((path) => {
        const isUntracked = untrackedFiles.includes(path);
        const hasStagedDelta = stagedFiles.includes(path);
        const hasUnstagedDelta = unstagedFiles.includes(path) || isUntracked;
        return {
            path,
            previousPath: null,
            kind: isUntracked ? 'untracked' : 'modified',
            indexStatus: hasStagedDelta ? 'M' : '.',
            worktreeStatus: hasUnstagedDelta ? 'M' : '.',
            hasStagedDelta,
            hasUnstagedDelta,
            stats: {
                stagedAdded: 0,
                stagedRemoved: 0,
                unstagedAdded: 0,
                unstagedRemoved: 0,
                isBinary: false,
            },
        };
    });

    return {
        projectKey: `local:${repoRoot}`,
        fetchedAt: Date.now(),
        repo: { isGitRepo: true, rootPath: repoRoot },
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
            stagedFiles: stagedFiles.length,
            unstagedFiles: unstagedFiles.length,
            untrackedFiles: untrackedFiles.length,
            stagedAdded: stagedStats.added,
            stagedRemoved: stagedStats.removed,
            unstagedAdded: unstagedStats.added,
            unstagedRemoved: unstagedStats.removed,
        },
    };
}

export function createGitSessionRpcHarness(workspace: string) {
    return async (_sessionId: string, method: string, request: any) => {
        const cwd = resolve(workspace, request?.cwd ?? '.');

        if (method === RPC_METHODS.GIT_STATUS_SNAPSHOT) {
            if (!isGitRepo(cwd)) {
                return {
                    success: true,
                    snapshot: {
                        projectKey: `local:${cwd}`,
                        fetchedAt: Date.now(),
                        repo: { isGitRepo: false, rootPath: null },
                        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
                        stashCount: 0,
                        hasConflicts: false,
                        entries: [],
                        totals: {
                            stagedFiles: 0,
                            unstagedFiles: 0,
                            untrackedFiles: 0,
                            stagedAdded: 0,
                            stagedRemoved: 0,
                            unstagedAdded: 0,
                            unstagedRemoved: 0,
                        },
                    },
                };
            }

            return {
                success: true,
                snapshot: buildSnapshot(cwd),
            };
        }

        if (!isGitRepo(cwd)) {
            return {
                success: false,
                error: 'Not a git repository',
                errorCode: GIT_OPERATION_ERROR_CODES.NOT_GIT_REPO,
            };
        }

        if (method === RPC_METHODS.GIT_STAGE_APPLY) {
            const patch = typeof request?.patch === 'string' ? request.patch : '';
            if (patch.trim()) {
                const check = runGit(cwd, ['apply', '--check', '--cached', '--unidiff-zero', '--recount', '-'], patch);
                if (!check.success) {
                    return {
                        success: false,
                        error: check.stderr || 'Patch check failed',
                        errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
                        stderr: check.stderr,
                    };
                }
                const apply = runGit(cwd, ['apply', '--cached', '--unidiff-zero', '--recount', '-'], patch);
                return apply.success
                    ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
                    : {
                        success: false,
                        error: apply.stderr || 'Patch apply failed',
                        errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
                        stderr: apply.stderr,
                    };
            }

            const paths = request?.paths as string[] | undefined;
            if (!paths || paths.length === 0) {
                return {
                    success: false,
                    error: 'Missing paths',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            git(cwd, ['add', '--', ...paths]);
            return { success: true, stdout: '', stderr: '' };
        }

        if (method === RPC_METHODS.GIT_UNSTAGE_APPLY) {
            const patch = typeof request?.patch === 'string' ? request.patch : '';
            if (patch.trim()) {
                const check = runGit(cwd, ['apply', '--check', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'], patch);
                if (!check.success) {
                    return {
                        success: false,
                        error: check.stderr || 'Patch reverse-check failed',
                        errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
                        stderr: check.stderr,
                    };
                }
                const apply = runGit(cwd, ['apply', '--cached', '--reverse', '--unidiff-zero', '--recount', '-'], patch);
                return apply.success
                    ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
                    : {
                        success: false,
                        error: apply.stderr || 'Patch reverse apply failed',
                        errorCode: GIT_OPERATION_ERROR_CODES.PATCH_APPLY_FAILED,
                        stderr: apply.stderr,
                    };
            }

            const paths = request?.paths as string[] | undefined;
            if (!paths || paths.length === 0) {
                return {
                    success: false,
                    error: 'Missing paths',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            git(cwd, ['reset', '--', ...paths]);
            return { success: true, stdout: '', stderr: '' };
        }

        if (method === RPC_METHODS.GIT_COMMIT_CREATE) {
            const message = (request?.message as string | undefined)?.trim();
            if (!message) {
                return {
                    success: false,
                    error: 'Commit message is required',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            git(cwd, ['commit', '-m', message]);
            return {
                success: true,
                commitSha: git(cwd, ['rev-parse', 'HEAD']),
            };
        }

        if (method === RPC_METHODS.GIT_LOG_LIST) {
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

        if (method === RPC_METHODS.GIT_REMOTE_FETCH) {
            const remote = (request?.remote as string | undefined) || 'origin';
            const fetch = runGit(cwd, ['fetch', '--prune', remote]);
            return fetch.success
                ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
                : {
                    success: false,
                    error: fetch.stderr || 'Fetch failed',
                    errorCode: mapGitErrorCode(fetch.stderr),
                    stderr: fetch.stderr,
                };
        }

        if (method === RPC_METHODS.GIT_REMOTE_PUSH) {
            const snapshot = buildSnapshot(cwd);
            const hasExplicitRemoteOrBranch = Boolean(request?.remote || request?.branch);
            if (!hasExplicitRemoteOrBranch && !snapshot.branch.upstream) {
                return {
                    success: false,
                    error: 'Set an upstream branch before push.',
                    errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Push is unavailable while HEAD is detached',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts) {
                return {
                    success: false,
                    error: 'Resolve conflicts before pushing.',
                    errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }
            if (snapshot.branch.behind > 0) {
                return {
                    success: false,
                    error: 'Local branch is behind upstream. Pull before pushing.',
                    errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
                };
            }
            const args = ['push'];
            const remote = (request?.remote as string | undefined)?.trim();
            const branch = (request?.branch as string | undefined)?.trim();
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
                    errorCode: mapGitErrorCode(push.stderr),
                    stderr: push.stderr,
                };
        }

        if (method === RPC_METHODS.GIT_REMOTE_PULL) {
            const snapshot = buildSnapshot(cwd);
            const hasExplicitRemoteOrBranch = Boolean(request?.remote || request?.branch);
            if (!hasExplicitRemoteOrBranch && !snapshot.branch.upstream) {
                return {
                    success: false,
                    error: 'Set an upstream branch before pull.',
                    errorCode: GIT_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Pull is unavailable while HEAD is detached',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts || snapshot.entries.length > 0) {
                return {
                    success: false,
                    error: 'Working tree must be clean before pull',
                    errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }
            const args = ['pull', '--ff-only'];
            const remote = (request?.remote as string | undefined)?.trim();
            const branch = (request?.branch as string | undefined)?.trim();
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
                    errorCode: mapGitErrorCode(pull.stderr),
                    stderr: pull.stderr,
                };
        }

        if (method === RPC_METHODS.GIT_COMMIT_REVERT) {
            const snapshot = buildSnapshot(cwd);
            if (snapshot.branch.detached) {
                return {
                    success: false,
                    error: 'Revert is unavailable while HEAD is detached',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (snapshot.hasConflicts || snapshot.entries.length > 0) {
                return {
                    success: false,
                    error: 'Working tree must be clean before revert',
                    errorCode: GIT_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }

            const commit = String(request?.commit ?? '').trim();
            if (!commit) {
                return {
                    success: false,
                    error: 'Commit reference cannot be empty',
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
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
                    errorCode: GIT_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    stderr: revert.stderr,
                };
            }

            return {
                success: false,
                error: revert.stderr || 'Revert failed',
                errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
                stderr: revert.stderr,
            };
        }

        throw new Error(`Unsupported test method: ${method}`);
    };
}

export function initRepo(cwd: string): void {
    git(cwd, ['init']);
    git(cwd, ['config', 'user.email', 'test@example.com']);
    git(cwd, ['config', 'user.name', 'Test User']);
}
