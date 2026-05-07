import { existsSync } from 'fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    ScmWorkingEntry,
    ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import type { ScmRepoDetection } from '../../types';
import { runScmCommand } from '../../runtime';

import { createSaplingCapabilities } from './capabilities';
import { parseSaplingStatusLine } from './statusParser';
import { parseGitPatchDiffStats } from './diffStats';

const UNTRACKED_STATS_MAX_FILES = 512;
const UNTRACKED_STATS_MAX_BYTES = 5_000_000;

function countTextLines(buffer: Buffer): number {
    if (buffer.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === 10) lines += 1;
    }
    return lines;
}

async function computeUntrackedStatsByPath(repoRoot: string, rawPaths: string[]): Promise<Record<string, { pendingAdded: number; isBinary: boolean }>> {
    const paths = rawPaths.filter((p) => p && p.trim().length > 0).slice(0, UNTRACKED_STATS_MAX_FILES);
    const statsByPath: Record<string, { pendingAdded: number; isBinary: boolean }> = {};

    for (const relativePath of paths) {
        if (relativePath === '.') continue;
        const absPath = join(repoRoot, relativePath);
        try {
            const info = await stat(absPath);
            if (!info.isFile()) continue;
            if (info.size > UNTRACKED_STATS_MAX_BYTES) {
                statsByPath[relativePath] = { pendingAdded: 0, isBinary: true };
                continue;
            }

            const buf = await readFile(absPath);
            const isBinary = buf.includes(0);
            statsByPath[relativePath] = {
                pendingAdded: isBinary ? 0 : countTextLines(buf),
                isBinary,
            };
        } catch {
            // Ignore unreadable files (permissions/races).
        }
    }

    return statsByPath;
}

export async function detectSaplingRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const root = await runScmCommand({
        bin: 'sl',
        cwd: input.cwd,
        args: ['root'],
        timeoutMs: 5000,
    });
    if (!root.success) {
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rootPath = root.stdout.trim();
    const mode = existsSync(join(rootPath, '.sl')) ? '.sl' : '.git';
    return {
        isRepo: true,
        rootPath,
        mode,
    };
}

export async function getSaplingHead(cwd: string): Promise<string | null> {
    const current = await runScmCommand({
        bin: 'sl',
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
        bin: 'sl',
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
        bin: 'sl',
        cwd: input.cwd,
        args: ['resolve', '--list'],
        timeoutMs: 5000,
    });
    const unresolvedPaths = resolveList.success ? parseSaplingResolveList(resolveList.stdout) : new Set<string>();

    const diff = await runScmCommand({
        bin: 'sl',
        cwd: input.cwd,
        args: ['diff', '-g'],
        timeoutMs: 10_000,
    });
    const diffStatsByPath = diff.success ? parseGitPatchDiffStats(diff.stdout) : new Map();

    const repoRoot = input.detection.rootPath ?? input.cwd;
    const untrackedPaths = statusEntries.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path);
    const untrackedStatsByPath = repoRoot ? await computeUntrackedStatsByPath(repoRoot, untrackedPaths) : {};

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
                },
            };
        }

        const stats = diffStatsByPath.get(entry.path) ?? null;
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
            remotes: [],
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
