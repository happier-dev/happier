import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
    createSaplingScmCapabilities,
    createScmCapabilities,
    mapSaplingScmErrorCode,
    normalizeScmRemoteRequest,
    resolveScmScopedChangedPaths,
    SCM_OPERATION_ERROR_CODES,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const SAPLING_TEST_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    // Ensure integration tests do not accidentally pick up user/system Sapling/Mercurial config
    // (extensions, hooks, remotes, credential helpers) that can make commands slow/flaky.
    // Repo-local config (set via `sl config --local …`) is still read.
    HGRCPATH: '/dev/null',
};

type SaplingStatusEntry = {
    path: string;
    kind: 'modified' | 'added' | 'deleted' | 'untracked' | 'conflicted';
    pendingStatus: string;
};

function parseSaplingStatusLine(rawLine: string): SaplingStatusEntry | null {
    const line = rawLine.trimEnd();
    if (!line) return null;
    const status = line[0];
    if (!status) return null;
    const path = line.slice(2).trim();
    if (!path) return null;

    if (status === '?') {
        return { path, kind: 'untracked', pendingStatus: '?' };
    }
    if (status === 'A') {
        return { path, kind: 'added', pendingStatus: 'A' };
    }
    if (status === 'R' || status === '!') {
        return { path, kind: 'deleted', pendingStatus: 'D' };
    }
    if (status === 'U') {
        return { path, kind: 'conflicted', pendingStatus: 'U' };
    }
    if (status === 'M') {
        return { path, kind: 'modified', pendingStatus: 'M' };
    }
    return { path, kind: 'modified', pendingStatus: status };
}

function parseSaplingStatus(cwd: string): SaplingStatusEntry[] {
    const output = runSapling(cwd, ['status', '--root-relative']);
    if (!output) return [];
    return output
        .split('\n')
        .map((line) => parseSaplingStatusLine(line))
        .filter((entry): entry is SaplingStatusEntry => Boolean(entry));
}

function parseLogTimestamp(hgDateValue: string): number {
    const seconds = Number((hgDateValue || '').split(' ')[0] || 0);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

function parseSaplingLogEntries(rawOutput: string) {
    const fields = rawOutput.split('\0');
    const entries: Array<{
        sha: string;
        shortSha: string;
        authorName: string;
        authorEmail: string;
        timestamp: number;
        subject: string;
        body: string;
    }> = [];

    for (let i = 0; i + 6 < fields.length; i += 7) {
        const sha = fields[i] || '';
        if (!sha) continue;
        entries.push({
            sha,
            shortSha: fields[i + 1] || sha.slice(0, 12),
            authorName: fields[i + 2] || '',
            authorEmail: fields[i + 3] || '',
            timestamp: parseLogTimestamp(fields[i + 4] || ''),
            subject: fields[i + 5] || '',
            body: fields[i + 6] || '',
        });
    }

    return entries;
}

function buildSnapshot(cwd: string) {
    const repoRoot = runSapling(cwd, ['root']);
    const mode = existsSync(join(repoRoot, '.sl')) ? '.sl' : '.git';
    const statusEntries = parseSaplingStatus(cwd);

    const entries = statusEntries.map((entry) => ({
        path: entry.path,
        previousPath: null,
        kind: entry.kind,
        includeStatus: ' ',
        pendingStatus: entry.pendingStatus,
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            isBinary: false,
        },
    }));

    const headRaw = trySapling(cwd, ['whereami']) ?? '';
    const head = headRaw && !/^0+$/.test(headRaw) ? headRaw : null;

    return {
        projectKey: `local:${repoRoot}`,
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: repoRoot, backendId: 'sapling' as const, mode: mode as '.sl' | '.git' },
        capabilities: createSaplingScmCapabilities(),
        branch: {
            head,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        stashCount: 0,
        hasConflicts: entries.some((entry) => entry.kind === 'conflicted'),
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: entries.filter((entry) => entry.kind === 'untracked').length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

export function runSapling(cwd: string, args: string[]): string {
    return execFileSync('sl', args, {
        cwd,
        env: SAPLING_TEST_ENV,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function runSaplingResult(
    cwd: string,
    args: string[],
): { success: true; stdout: string; stderr: string } | { success: false; stderr: string } {
    try {
        const stdout = execFileSync('sl', args, {
            cwd,
            env: SAPLING_TEST_ENV,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
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

function trySapling(cwd: string, args: string[]): string | null {
    try {
        return runSapling(cwd, args);
    } catch {
        return null;
    }
}

function isRepo(cwd: string): boolean {
    return trySapling(cwd, ['root']) !== null;
}

function resolvePullDestination(request: { remote?: string; branch?: string }): string | null {
    const branch = request.branch?.trim();
    if (!branch) return null;
    if (branch.includes('/')) return branch;
    if (request.remote?.trim()) {
        return `${request.remote.trim()}/${branch}`;
    }
    return branch;
}

type PullArgsResult =
    | { ok: true; args: string[] }
    | { ok: false; error: string };

function buildPullArgs(request: { remote?: string; branch?: string }, update: boolean): PullArgsResult {
    const args = ['pull'];
    if (update) {
        const destination = resolvePullDestination(request);
        if (!destination) {
            return {
                ok: false,
                error: 'Branch is required for sapling pull updates',
            };
        }
        args.push('--update', '--dest', destination);
    }
    if (request.remote) {
        args.push(request.remote);
    }
    return {
        ok: true,
        args,
    };
}

function buildPushArgs(request: { remote?: string; branch?: string }): string[] {
    const args = ['push'];
    if (request.branch) {
        args.push('--to', request.branch);
    }
    if (request.remote) {
        args.push(request.remote);
    }
    return args;
}

export function createSaplingSessionRpcHarness(workspace: string) {
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
                error: 'Not a repository',
                errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            };
        }

        if (method === RPC_METHODS.SCM_DIFF_FILE) {
            if (request?.area === 'included') {
                return {
                    success: false,
                    error: 'Sapling does not support include-only file diffs',
                    errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                };
            }
            const path = String(request?.path ?? '').trim();
            if (!path) {
                return {
                    success: false,
                    error: 'Missing path',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const diff = runSaplingResult(cwd, ['diff', '-g', '--', path]);
            return diff.success
                ? { success: true, diff: diff.stdout }
                : {
                    success: false,
                    error: diff.stderr || 'Diff failed',
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    stderr: diff.stderr,
                };
        }

        if (method === RPC_METHODS.SCM_DIFF_COMMIT) {
            const commit = String(request?.commit ?? '').trim();
            if (!commit) {
                return {
                    success: false,
                    error: 'Commit reference is required',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const diff = runSaplingResult(cwd, ['show', '-g', commit]);
            return diff.success
                ? { success: true, diff: diff.stdout }
                : {
                    success: false,
                    error: diff.stderr || 'Diff failed',
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    stderr: diff.stderr,
                };
        }

        if (method === RPC_METHODS.SCM_CHANGE_INCLUDE || method === RPC_METHODS.SCM_CHANGE_EXCLUDE) {
            return {
                success: false,
                error: 'Sapling backend does not support include/exclude operations',
                errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            };
        }

        if (method === RPC_METHODS.SCM_COMMIT_CREATE) {
            const message = String(request?.message ?? '').trim();
            if (!message) {
                return {
                    success: false,
                    error: 'Commit message is required',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (Array.isArray(request?.patches) && request.patches.length > 0) {
                return {
                    success: false,
                    error: 'Patch-based commit selection is not supported by Sapling backend.',
                    errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                };
            }

            const status = parseSaplingStatus(cwd);
            if (status.length === 0) {
                return {
                    success: false,
                    error: 'No changes to commit',
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                };
            }

            let commitArgs: string[] = ['commit', '-A', '-m', message];
            if (request?.scope?.kind === 'paths') {
                const include = Array.isArray(request.scope.include)
                    ? request.scope.include.map((path: unknown) => String(path).trim()).filter(Boolean)
                    : [];
                const exclude = new Set<string>(
                    Array.isArray(request.scope.exclude)
                        ? request.scope.exclude.map((path: unknown) => String(path).trim()).filter(Boolean)
                        : [],
                );
                const candidateScopePaths = include.filter((path: string) => !exclude.has(path));
                if (candidateScopePaths.length === 0) {
                    return {
                        success: false,
                        error: 'Commit scope excludes all included paths',
                        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    };
                }
                const scopedChangedPaths = resolveScmScopedChangedPaths({
                    changedPaths: status.map((entry) => entry.path),
                    include: candidateScopePaths,
                    exclude: Array.from(exclude),
                });
                if (scopedChangedPaths.length === 0) {
                    return {
                        success: false,
                        error: 'No pending changes match the requested commit scope',
                        errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                    };
                }
                commitArgs = ['commit', '-A', '-m', message, ...scopedChangedPaths];
            }

            const commit = runSaplingResult(cwd, commitArgs);
            if (!commit.success) {
                return {
                    success: false,
                    error: commit.stderr || 'Commit failed',
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    stderr: commit.stderr,
                };
            }
            return {
                success: true,
                commitSha: trySapling(cwd, ['whereami']) ?? undefined,
            };
        }

        if (method === RPC_METHODS.SCM_LOG_LIST) {
            const limit = Number(request?.limit ?? 50);
            const skip = Number(request?.skip ?? 0);
            const log = runSaplingResult(cwd, [
                'log',
                '--limit',
                String(limit + skip),
                '--template',
                '{node}\\0{node|short}\\0{author|person}\\0{author|email}\\0{date|hgdate}\\0{desc|firstline}\\0{desc}\\0',
            ]);
            if (!log.success) {
                return {
                    success: false,
                    error: log.stderr || 'Log failed',
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    stderr: log.stderr,
                };
            }
            return {
                success: true,
                entries: parseSaplingLogEntries(log.stdout).slice(skip, skip + limit),
            };
        }

        if (method === RPC_METHODS.SCM_COMMIT_BACKOUT) {
            const commit = String(request?.commit ?? '').trim();
            if (!commit) {
                return {
                    success: false,
                    error: 'Commit reference is required',
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            if (parseSaplingStatus(cwd).length > 0) {
                return {
                    success: false,
                    error: 'Working copy must be clean before backout',
                    errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
                };
            }
            const backout = runSaplingResult(cwd, ['backout', '--rev', commit]);
            return backout.success
                ? { success: true, stdout: backout.stdout, stderr: backout.stderr }
                : {
                    success: false,
                    error: backout.stderr || 'Backout failed',
                    errorCode: mapSaplingScmErrorCode(backout.stderr),
                    stderr: backout.stderr,
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
            const pullArgs = buildPullArgs(normalized.request, false);
            if (!pullArgs.ok) {
                return {
                    success: false,
                    error: pullArgs.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const fetch = runSaplingResult(cwd, pullArgs.args);
            return fetch.success
                ? { success: true, stdout: fetch.stdout, stderr: fetch.stderr }
                : {
                    success: false,
                    error: fetch.stderr || 'Fetch failed',
                    errorCode: mapSaplingScmErrorCode(fetch.stderr),
                    stderr: fetch.stderr,
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
            if (!normalized.request.branch) {
                return {
                    success: false,
                    error: 'Set a destination bookmark before pull.',
                    errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            const pullArgs = buildPullArgs(normalized.request, true);
            if (!pullArgs.ok) {
                return {
                    success: false,
                    error: pullArgs.error,
                    errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                };
            }
            const pull = runSaplingResult(cwd, pullArgs.args);
            return pull.success
                ? { success: true, stdout: pull.stdout, stderr: pull.stderr }
                : {
                    success: false,
                    error: pull.stderr || 'Pull failed',
                    errorCode: mapSaplingScmErrorCode(pull.stderr),
                    stderr: pull.stderr,
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
            if (!normalized.request.branch) {
                return {
                    success: false,
                    error: 'Set a destination bookmark before push.',
                    errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED,
                };
            }
            const push = runSaplingResult(cwd, buildPushArgs(normalized.request));
            return push.success
                ? { success: true, stdout: push.stdout, stderr: push.stderr }
                : {
                    success: false,
                    error: push.stderr || 'Push failed',
                    errorCode: mapSaplingScmErrorCode(push.stderr),
                    stderr: push.stderr,
                };
        }

        throw new Error(`Unsupported test method: ${method}`);
    };
}

export function initSaplingRepo(cwd: string): void {
    runSapling(cwd, ['init']);
    runSapling(cwd, ['config', '--local', 'ui.username', 'Test User <test@example.com>']);
}
