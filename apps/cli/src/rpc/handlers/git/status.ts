import type { GitWorkingEntry, GitWorkingSnapshot } from '@happier-dev/protocol';
import { parseGitStatusPorcelainV2Z, parseNumStatZ } from './status/parser';

function detectEntryKind(indexStatus: string, worktreeStatus: string): GitWorkingEntry['kind'] {
    if (indexStatus === 'U' || worktreeStatus === 'U') return 'conflicted';
    if (indexStatus === '?' || worktreeStatus === '?') return 'untracked';
    if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed';
    if (indexStatus === 'C' || worktreeStatus === 'C') return 'copied';
    if (indexStatus === 'A' || worktreeStatus === 'A') return 'added';
    if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted';
    return 'modified';
}

function isMeaningfulStatus(statusChar: string): boolean {
    return statusChar !== ' ' && statusChar !== '.';
}

export function createEmptySnapshot(projectKey: string, fetchedAt: number): GitWorkingSnapshot {
    return {
        projectKey,
        fetchedAt,
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
    };
}

export function buildSnapshot(input: {
    projectKey: string;
    fetchedAt: number;
    rootPath: string | null;
    statusOutput: string;
    stagedNumStatOutput: string;
    unstagedNumStatOutput: string;
}): GitWorkingSnapshot {
    const parsedStatus = parseGitStatusPorcelainV2Z(input.statusOutput);
    const stagedSummary = parseNumStatZ(input.stagedNumStatOutput);
    const unstagedSummary = parseNumStatZ(input.unstagedNumStatOutput);
    const stagedMap = new Map(stagedSummary.files.map((item) => [item.file, item]));
    const unstagedMap = new Map(unstagedSummary.files.map((item) => [item.file, item]));
    const entries = new Map<string, GitWorkingEntry>();

    for (const statusEntry of parsedStatus.files) {
        const stagedStats = stagedMap.get(statusEntry.path);
        const unstagedStats = unstagedMap.get(statusEntry.path);
        entries.set(statusEntry.path, {
            path: statusEntry.path,
            previousPath: statusEntry.from,
            kind: detectEntryKind(statusEntry.index, statusEntry.workingDir),
            indexStatus: statusEntry.index,
            worktreeStatus: statusEntry.workingDir,
            hasStagedDelta: (isMeaningfulStatus(statusEntry.index) && statusEntry.index !== '?') || Boolean(stagedStats),
            hasUnstagedDelta:
                isMeaningfulStatus(statusEntry.workingDir) || statusEntry.workingDir === '?' || Boolean(unstagedStats),
            stats: {
                stagedAdded: stagedStats?.insertions ?? 0,
                stagedRemoved: stagedStats?.deletions ?? 0,
                unstagedAdded: unstagedStats?.insertions ?? 0,
                unstagedRemoved: unstagedStats?.deletions ?? 0,
                isBinary: Boolean(stagedStats?.binary || unstagedStats?.binary),
            },
        });
    }

    for (const path of parsedStatus.notAdded) {
        if (entries.has(path)) continue;
        entries.set(path, {
            path,
            previousPath: null,
            kind: 'untracked',
            indexStatus: '?',
            worktreeStatus: '?',
            hasStagedDelta: false,
            hasUnstagedDelta: true,
            stats: {
                stagedAdded: 0,
                stagedRemoved: 0,
                unstagedAdded: 0,
                unstagedRemoved: 0,
                isBinary: false,
            },
        });
    }

    const ensureEntry = (path: string) => {
        if (entries.has(path)) return;
        const stagedStats = stagedMap.get(path);
        const unstagedStats = unstagedMap.get(path);
        const hasStaged = stagedMap.has(path);
        const hasUnstaged = unstagedMap.has(path);
        entries.set(path, {
            path,
            previousPath: null,
            kind: 'modified',
            indexStatus: hasStaged ? 'M' : ' ',
            worktreeStatus: hasUnstaged ? 'M' : ' ',
            hasStagedDelta: hasStaged,
            hasUnstagedDelta: hasUnstaged,
            stats: {
                stagedAdded: stagedStats?.insertions ?? 0,
                stagedRemoved: stagedStats?.deletions ?? 0,
                unstagedAdded: unstagedStats?.insertions ?? 0,
                unstagedRemoved: unstagedStats?.deletions ?? 0,
                isBinary: Boolean(stagedStats?.binary || unstagedStats?.binary),
            },
        });
    };

    const allNumstatPaths = new Set([...stagedMap.keys(), ...unstagedMap.keys()]);
    for (const path of allNumstatPaths) ensureEntry(path);

    const sortedEntries = Array.from(entries.values()).sort((a, b) => a.path.localeCompare(b.path));
    const headRaw = parsedStatus.branch.head ?? null;
    const detached =
        headRaw === null ||
        headRaw === '(unknown)' ||
        headRaw === '(no branch)' ||
        headRaw.startsWith('(detached');

    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt,
        repo: {
            isGitRepo: true,
            rootPath: input.rootPath,
        },
        branch: {
            head: detached ? null : headRaw,
            upstream: parsedStatus.branch.upstream ?? null,
            ahead: parsedStatus.branch.ahead ?? 0,
            behind: parsedStatus.branch.behind ?? 0,
            detached,
        },
        stashCount: parsedStatus.stashCount,
        hasConflicts: sortedEntries.some((entry) => entry.kind === 'conflicted'),
        entries: sortedEntries,
        totals: {
            stagedFiles: sortedEntries.filter((entry) => entry.hasStagedDelta).length,
            unstagedFiles: sortedEntries.filter((entry) => entry.hasUnstagedDelta).length,
            untrackedFiles: sortedEntries.filter((entry) => entry.kind === 'untracked').length,
            stagedAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.stagedAdded, 0),
            stagedRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.stagedRemoved, 0),
            unstagedAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.unstagedAdded, 0),
            unstagedRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.unstagedRemoved, 0),
        },
    };
}
