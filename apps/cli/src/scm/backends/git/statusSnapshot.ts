import {
    createGitScmCapabilities,
    type ScmWorkingEntry,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import { parseGitStatusPorcelainV2Z, parseNumStatZ } from './statusParser';

function detectEntryKind(includeStatus: string, pendingStatus: string): ScmWorkingEntry['kind'] {
    if (includeStatus === 'U' || pendingStatus === 'U') return 'conflicted';
    if (includeStatus === '?' || pendingStatus === '?') return 'untracked';
    if (includeStatus === 'R' || pendingStatus === 'R') return 'renamed';
    if (includeStatus === 'C' || pendingStatus === 'C') return 'copied';
    if (includeStatus === 'A' || pendingStatus === 'A') return 'added';
    if (includeStatus === 'D' || pendingStatus === 'D') return 'deleted';
    return 'modified';
}

function isMeaningfulStatus(statusChar: string): boolean {
    return statusChar !== ' ' && statusChar !== '.';
}

export function createGitCapabilities() {
    return createGitScmCapabilities();
}

export function buildGitSnapshot(input: {
    projectKey: string;
    fetchedAt: number;
    rootPath: string | null;
    statusOutput: string;
    includedNumStatOutput: string;
    pendingNumStatOutput: string;
}): ScmWorkingSnapshot {
    const parsedStatus = parseGitStatusPorcelainV2Z(input.statusOutput);
    const includedSummary = parseNumStatZ(input.includedNumStatOutput);
    const pendingSummary = parseNumStatZ(input.pendingNumStatOutput);
    const includedMap = new Map(includedSummary.files.map((item) => [item.file, item]));
    const pendingMap = new Map(pendingSummary.files.map((item) => [item.file, item]));
    const entries = new Map<string, ScmWorkingEntry>();

    for (const statusEntry of parsedStatus.files) {
        const includedStats = includedMap.get(statusEntry.path);
        const pendingStats = pendingMap.get(statusEntry.path);
        entries.set(statusEntry.path, {
            path: statusEntry.path,
            previousPath: statusEntry.from,
            kind: detectEntryKind(statusEntry.index, statusEntry.workingDir),
            includeStatus: statusEntry.index,
            pendingStatus: statusEntry.workingDir,
            hasIncludedDelta: (isMeaningfulStatus(statusEntry.index) && statusEntry.index !== '?') || Boolean(includedStats),
            hasPendingDelta: isMeaningfulStatus(statusEntry.workingDir) || statusEntry.workingDir === '?' || Boolean(pendingStats),
            stats: {
                includedAdded: includedStats?.insertions ?? 0,
                includedRemoved: includedStats?.deletions ?? 0,
                pendingAdded: pendingStats?.insertions ?? 0,
                pendingRemoved: pendingStats?.deletions ?? 0,
                isBinary: Boolean(includedStats?.binary || pendingStats?.binary),
            },
        });
    }

    for (const path of parsedStatus.notAdded) {
        if (entries.has(path)) continue;
        entries.set(path, {
            path,
            previousPath: null,
            kind: 'untracked',
            includeStatus: '?',
            pendingStatus: '?',
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

    const ensureEntry = (path: string) => {
        if (entries.has(path)) return;
        const includedStats = includedMap.get(path);
        const pendingStats = pendingMap.get(path);
        const hasIncluded = includedMap.has(path);
        const hasPending = pendingMap.has(path);
        entries.set(path, {
            path,
            previousPath: null,
            kind: 'modified',
            includeStatus: hasIncluded ? 'M' : ' ',
            pendingStatus: hasPending ? 'M' : ' ',
            hasIncludedDelta: hasIncluded,
            hasPendingDelta: hasPending,
            stats: {
                includedAdded: includedStats?.insertions ?? 0,
                includedRemoved: includedStats?.deletions ?? 0,
                pendingAdded: pendingStats?.insertions ?? 0,
                pendingRemoved: pendingStats?.deletions ?? 0,
                isBinary: Boolean(includedStats?.binary || pendingStats?.binary),
            },
        });
    };

    const allNumstatPaths = new Set([...includedMap.keys(), ...pendingMap.keys()]);
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
            isRepo: true,
            rootPath: input.rootPath,
            backendId: 'git',
            mode: '.git',
        },
        capabilities: createGitCapabilities(),
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
            includedFiles: sortedEntries.filter((entry) => entry.hasIncludedDelta).length,
            pendingFiles: sortedEntries.filter((entry) => entry.hasPendingDelta).length,
            untrackedFiles: sortedEntries.filter((entry) => entry.kind === 'untracked').length,
            includedAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.includedAdded, 0),
            includedRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.includedRemoved, 0),
            pendingAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.pendingAdded, 0),
            pendingRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.pendingRemoved, 0),
        },
    };
}
