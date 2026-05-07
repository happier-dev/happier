import {
    type ScmHostingProvider,
    type ScmRemoteInfo,
    type ScmWorktree,
    createGitScmCapabilities,
    type ScmOperationState,
    type ScmWorkingEntry,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import { parseGitStatusPorcelainV2Z, parseNumStatZ } from './statusParser';
import { parseGitWorktreeListPorcelain } from './worktreeListParser';
import { parseGitRemoteVerbose } from './remoteListParser';
import { defaultScmHostingProviderRegistry } from '../../hostingProviders/registry';
import { defaultPrStatusCache, type PrStatusCache } from '../../hostingProviders/prStatusCache';

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

function detectHostingProviderForRemote(remote: ScmRemoteInfo): ScmHostingProvider | null {
    return (
        defaultScmHostingProviderRegistry.detectRemote({
            remoteName: remote.name,
            remoteUrl: remote.fetchUrl ?? '',
        })
        ?? defaultScmHostingProviderRegistry.detectRemote({
            remoteName: remote.name,
            remoteUrl: remote.pushUrl ?? '',
        })
    );
}

function extractUpstreamRemoteName(upstreamRef: string | null | undefined): string | null {
    const upstream = upstreamRef?.trim();
    if (!upstream) return null;
    const slashIndex = upstream.indexOf('/');
    if (slashIndex <= 0) return null;
    return upstream.slice(0, slashIndex);
}

function resolveHostingProviderFromRemotes(input: {
    remotes: readonly ScmRemoteInfo[];
    upstreamRef: string | null | undefined;
}): ScmHostingProvider | null {
    const detectedProviders = input.remotes
        .map((remote) => ({
            remoteName: remote.name,
            provider: detectHostingProviderForRemote(remote),
        }))
        .filter((entry): entry is { remoteName: string; provider: ScmHostingProvider } => entry.provider !== null);
    if (detectedProviders.length === 0) return null;

    const upstreamRemoteName = extractUpstreamRemoteName(input.upstreamRef);
    if (upstreamRemoteName) {
        const upstreamMatch = detectedProviders.find((entry) => entry.remoteName === upstreamRemoteName);
        if (upstreamMatch) return upstreamMatch.provider;
    }

    const originMatch = detectedProviders.find((entry) => entry.remoteName === 'origin');
    if (originMatch) return originMatch.provider;

    return detectedProviders
        .slice()
        .sort((left, right) => left.remoteName.localeCompare(right.remoteName))[0]
        ?.provider ?? null;
}

export function resolveGitHostingProviderFromOutputs(input: {
    statusOutput: string;
    remotesOutput?: string;
}): ScmHostingProvider | null {
    const parsedStatus = parseGitStatusPorcelainV2Z(input.statusOutput);
    const remotes = parseGitRemoteVerbose(input.remotesOutput ?? '');
    return resolveHostingProviderFromRemotes({
        remotes,
        upstreamRef: parsedStatus.branch.upstream ?? null,
    });
}

export function buildGitSnapshot(input: {
    projectKey: string;
    fetchedAt: number;
    rootPath: string | null;
    currentWorktreePath?: string | null;
    mainWorktreePath?: string | null;
    statusOutput: string;
    includedNumStatOutput: string;
    pendingNumStatOutput: string;
    untrackedStatsByPath?: Record<string, { pendingAdded: number; isBinary: boolean }>;
    worktreesOutput?: string;
    remotesOutput?: string;
    operationState?: ScmOperationState | null;
    hostingProvider?: ScmHostingProvider | null;
    prStatusCache?: PrStatusCache;
    pullRequestAuthProfileKey?: string | null;
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
        const untrackedStats = input.untrackedStatsByPath?.[path] ?? null;
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
                pendingAdded: untrackedStats ? Math.max(0, Number(untrackedStats.pendingAdded) || 0) : 0,
                pendingRemoved: 0,
                isBinary: untrackedStats ? Boolean(untrackedStats.isBinary) : false,
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
    const worktrees: ScmWorktree[] = input.worktreesOutput
        ? [...parseGitWorktreeListPorcelain({
            worktreesOutput: input.worktreesOutput,
            currentWorktreePath: input.currentWorktreePath ?? input.rootPath,
            mainWorktreePath: input.mainWorktreePath ?? input.rootPath,
        })]
        : [];
    const remotes = parseGitRemoteVerbose(input.remotesOutput ?? '');
    const hostingProvider = input.hostingProvider ?? resolveHostingProviderFromRemotes({
        remotes,
        upstreamRef: parsedStatus.branch.upstream ?? null,
    });
    const pullRequest = (() => {
        if (!hostingProvider || detached || !headRaw || !input.rootPath || !input.pullRequestAuthProfileKey) return null;
        const cached = (input.prStatusCache ?? defaultPrStatusCache).getFresh({
            repoRootPath: input.rootPath,
            provider: hostingProvider,
            head: headRaw,
            authProfileKey: input.pullRequestAuthProfileKey,
        });
        return cached?.kind === 'success' ? (cached.pullRequests[0] ?? null) : null;
    })();

    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt,
        repo: {
            isRepo: true,
            rootPath: input.rootPath,
            backendId: 'git',
            mode: '.git',
            worktrees,
            remotes,
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
        operationState: input.operationState ?? null,
        hostingProvider,
        pullRequest,
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
