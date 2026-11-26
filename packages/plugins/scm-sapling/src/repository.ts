import { readUntrackedFileStats } from '@happier-dev/plugin-sdk/scm/backend';
import { readRepositoryFileSystem } from './repositoryFileSystem.js';
import { join } from 'node:path';

import type {
  ScmWorkingEntry,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import type { BackendRuntimeDetection as ScmRepoDetection } from '@happier-dev/plugin-sdk/scm/backend';

import { createSaplingCapabilities } from './capabilities.js';
import { runSaplingCommand as runScmCommand, type SaplingExecResult } from './runtime.js';
import { parseGitPatchDiffStats } from './parsing/diffStats.js';
import { parseSaplingPaths } from './parsing/remotePathsParser.js';
import { parseSaplingStatusLine } from './parsing/statusParser.js';


function detectionUnavailable(detail: string): Error {
    return Object.assign(
        new Error(`Unable to determine whether this path is a Sapling repository: ${detail}`),
        { errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE },
    );
}

function commandProducedNoAnswer(result: SaplingExecResult): boolean {
    return result.timedOut === true || result.outputLimitExceeded === true || result.exitCode < 0;
}

export async function detectSaplingRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const root = await runScmCommand({
        cwd: input.cwd,
        args: ['root'],
        timeoutMs: 5000,
    });
    if (root.workingDirectoryMissing === true) {
        throw Object.assign(new Error('The workspace folder no longer exists on this machine'), {
            errorCode: SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND,
        });
    }
    if (root.executableMissing === true) {
        throw Object.assign(new Error(root.stderr || 'Sapling is not installed'), {
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_NOT_INSTALLED,
        });
    }
    if (!root.success) {
        if (commandProducedNoAnswer(root)) {
            throw detectionUnavailable(root.stderr.trim() || 'the repository probe did not complete');
        }

        // This absence diagnostic is pinned by Sapling's eden/scm/tests/test-root.t.
        // Every other refusal remains undetermined, even when `sl --version` succeeds.
        const diagnostic = root.stderr.trim();
        if (!/^abort: '[^\r\n]+' is not inside a repository, but this command requires a repository!(?:\r?\n|$)/.test(diagnostic)) {
            throw detectionUnavailable(diagnostic || 'the repository probe was refused');
        }
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rawRootPath = root.stdout.trim();
    const files = readRepositoryFileSystem();
    const rootPath = files.commandPaths?.fromCommandPath(rawRootPath) ?? rawRootPath;
    let hasSlDir = false;
    try {
        await files.stat(join(rootPath, '.sl'));
        hasSlDir = true;
    } catch {
        hasSlDir = false;
    }
    const mode = hasSlDir ? '.sl' : '.git';
    return {
        isRepo: true,
        rootPath,
        mode,
    };
}

export async function getSaplingHead(cwd: string): Promise<string | null> {
    const current = await runScmCommand({
        cwd,
        args: ['whereami'],
        timeoutMs: 5000,
    });
    if (!current.success) return null;
    const value = current.stdout.trim();
    if (!value || /^0+$/.test(value)) return null;
    return value;
}

function parseSaplingResolveList(rawOutput: string): Set<string> {
    const unresolved = new Set<string>();
    for (const rawLine of rawOutput.split(/\r?\n/g)) {
        const line = rawLine.trimEnd();
        if (!line.startsWith('U ')) continue;
        const path = line.slice(2);
        if (!path) continue;
        unresolved.add(path);
    }
    return unresolved;
}

function buildSnapshotEntries(
    statusEntries: ReturnType<typeof parseSaplingStatusLine>[],
    unresolvedPaths: Set<string>
): ScmWorkingEntry[] {
    const entriesByPath = new Map<string, ScmWorkingEntry>();
    for (const statusEntry of statusEntries) {
        if (!statusEntry) continue;
        const isConflicted = unresolvedPaths.has(statusEntry.path);
        entriesByPath.set(statusEntry.path, {
            path: statusEntry.path,
            previousPath: null,
            kind: isConflicted ? 'conflicted' : statusEntry.kind,
            includeStatus: ' ',
            pendingStatus: isConflicted ? 'U' : statusEntry.pendingStatus,
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                isBinary: false,
            },
        });
    }

    for (const path of unresolvedPaths) {
        if (entriesByPath.has(path)) continue;
        entriesByPath.set(path, {
            path,
            previousPath: null,
            kind: 'conflicted',
            includeStatus: ' ',
            pendingStatus: 'U',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
                isBinary: false,
            },
        });
    }

    return Array.from(entriesByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export async function getSaplingSnapshot(input: {
    cwd: string;
    projectKey: string;
    detection: ScmRepoDetection;
}): Promise<ScmWorkingSnapshot> {
    const status = await runScmCommand({
        cwd: input.cwd,
        args: ['status', '--root-relative'],
        timeoutMs: 10_000,
    });
    if (!status.success) {
        const message = status.stderr.trim() || 'Failed to read sapling status';
        throw new Error(message);
    }
    const statusEntries = status.stdout
        .split(/\r?\n/g)
        .map(parseSaplingStatusLine)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    const resolveList = await runScmCommand({
        cwd: input.cwd,
        args: ['resolve', '--list'],
        timeoutMs: 5000,
    });
    const unresolvedPaths = resolveList.success ? parseSaplingResolveList(resolveList.stdout) : new Set<string>();

    const diff = await runScmCommand({
        cwd: input.cwd,
        args: ['diff', '-g'],
        timeoutMs: 10_000,
    });
    const diffStatsByPath = diff.success ? parseGitPatchDiffStats(diff.stdout) : new Map();

    const repoRoot = input.detection.rootPath ?? input.cwd;
    const remotesResult = await runScmCommand({
        cwd: repoRoot,
        args: ['paths'],
        timeoutMs: 5000,
    });
    if (!remotesResult.success) {
        throw new Error(remotesResult.stderr || 'Failed to read sapling remote paths');
    }
    const remotes = parseSaplingPaths(remotesResult.stdout);

    const untrackedPaths = statusEntries.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path);
    const untrackedStatsByPath = repoRoot ? await readUntrackedFileStats(repoRoot, untrackedPaths) : {};

    const entries = buildSnapshotEntries(statusEntries, unresolvedPaths).map((entry) => {
        if (entry.kind === 'untracked') {
            const stats = untrackedStatsByPath[entry.path] ?? null;
            return {
                ...entry,
                stats: {
                    ...entry.stats,
                    pendingAdded: stats ? Math.max(0, Number(stats.pendingAdded) || 0) : 0,
                    pendingRemoved: 0,
                    isBinary: stats ? Boolean(stats.isBinary) : false,
                    ...(stats ? {} : { isComplete: false }),
                },
            };
        }

        const stats = diffStatsByPath.get(entry.path) ?? null;
        if (!diff.success) return { ...entry, stats: { ...entry.stats, isComplete: false } };
        if (!stats) return entry;
        return {
            ...entry,
            stats: {
                ...entry.stats,
                pendingAdded: Math.max(0, Number(stats.pendingAdded) || 0),
                pendingRemoved: Math.max(0, Number(stats.pendingRemoved) || 0),
                isBinary: Boolean(stats.isBinary),
            },
        };
    });
    const head = await getSaplingHead(input.cwd);

    const pendingAdded = entries.reduce((acc, entry) => acc + (entry.stats?.pendingAdded ?? 0), 0);
    const pendingRemoved = entries.reduce((acc, entry) => acc + (entry.stats?.pendingRemoved ?? 0), 0);

    return {
        projectKey: input.projectKey,
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            rootPath: input.detection.rootPath,
            backendId: 'sapling',
            mode: input.detection.mode,
            worktrees: [],
            remotes,
        },
        capabilities: createSaplingCapabilities(),
        branch: {
            head,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        hasConflicts: unresolvedPaths.size > 0 || entries.some((entry) => entry.kind === 'conflicted'),
        entries,
        totals: {
            ...(entries.some((entry) => entry.stats.isComplete === false) ? { isComplete: false } : {}),
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: entries.filter((entry) => entry.kind === 'untracked').length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded,
            pendingRemoved,
        },
    };
}
