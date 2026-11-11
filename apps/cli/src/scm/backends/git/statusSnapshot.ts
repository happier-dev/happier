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
import { parseGitRemoteHeadRefs } from './remoteHeadRefParser';
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

function uniqueRemoteNames(names: readonly (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
        const trimmed = name?.trim() ?? '';
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

function resolveRemoteDefaultBranch(input: Readonly<{
    remoteHeadRefsOutput?: string;
    remotes: readonly ScmRemoteInfo[];
    upstreamRef: string | null | undefined;
    hostingProvider: ScmHostingProvider | null;
}>): string | null {
    const refs = parseGitRemoteHeadRefs(input.remoteHeadRefsOutput ?? '');
    if (refs.length === 0) return null;

    const refsByRemote = new Map(refs.map((ref) => [ref.remoteName, ref.branch]));
    const preferredRemoteNames = uniqueRemoteNames([
        extractUpstreamRemoteName(input.upstreamRef),
        input.hostingProvider?.remoteName,
        'origin',
        ...input.remotes
            .map((remote) => remote.name)
            .slice()
            .sort((left, right) => left.localeCompare(right)),
    ]);

    for (const remoteName of preferredRemoteNames) {
        const branch = refsByRemote.get(remoteName);
        if (branch) return branch;
    }

    return refs
        .slice()
        .sort((left, right) => left.remoteName.localeCompare(right.remoteName))[0]
        ?.branch ?? null;
}

/**
 * Canonical total order over SCM entry paths: code-point comparison, NOT
 * `localeCompare` (locale-dependent). This is the contract order for BOTH the
 * snapshot entry list and the `scm.status.entries` paging cursor, so a
 * truncated snapshot's prefix and its paged continuation observe one order;
 * mixed-case paths at the truncation boundary can otherwise be skipped or
 * duplicated. Exported for the paging RPC (`statusEntries.ts`).
 */
export function compareScmEntryPaths(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
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
    includedNumStatSuccess?: boolean;
    pendingNumStatSuccess?: boolean;
    untrackedStatsByPath?: Record<string, { pendingAdded: number; isBinary: boolean }>;
    /**
     * 'normal'-mode only: truthful untracked-FILE facts from the bounded
     * `git ls-files --others` enumeration. Absent ('all' mode, or enumeration
     * failure) → totals fall back to entry-derived counts.
     */
    untrackedEnumeration?: {
        totalFileCount: number;
        fileCountByDirectoryPath: ReadonlyMap<string, number>;
    };
    worktreesOutput?: string;
    remotesOutput?: string;
    remoteHeadRefsOutput?: string;
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
                ...((isMeaningfulStatus(statusEntry.index) && input.includedNumStatSuccess === false)
                    || (isMeaningfulStatus(statusEntry.workingDir) && input.pendingNumStatSuccess === false)
                    ? { isComplete: false } : {}),
            },
        });
    }

    for (const path of parsedStatus.notAdded) {
        if (entries.has(path)) continue;
        const untrackedStats = input.untrackedStatsByPath?.[path] ?? null;
        // git -unormal reports collapsed untracked directories with a trailing
        // separator ('? D/'); in 'all' mode every notAdded path is a file.
        const isCollapsedDirectory = path.endsWith('/');
        const untrackedFileCount = isCollapsedDirectory
            ? input.untrackedEnumeration?.fileCountByDirectoryPath.get(path)
            : undefined;
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
                ...(untrackedStats ? {} : { isComplete: false }),
            },
            ...(isCollapsedDirectory ? { isDirectory: true } : {}),
            ...(typeof untrackedFileCount === 'number' ? { untrackedFileCount } : {}),
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

    const sortedEntries = Array.from(entries.values()).sort((a, b) => compareScmEntryPaths(a.path, b.path));
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
    const defaultBranch = resolveRemoteDefaultBranch({
        remoteHeadRefsOutput: input.remoteHeadRefsOutput,
        remotes,
        upstreamRef: parsedStatus.branch.upstream ?? null,
        hostingProvider,
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

    // T2: totals keep FILE semantics in every mode. With collapsed directory
    // entries present, entries.length and the entry-derived untracked count
    // both undercount — corrected from the enumeration; when the enumeration
    // (or any per-directory count) is missing, fall back to entry-derived
    // counts and let the existing isComplete/stats.isComplete flags carry the
    // incompleteness. 'all' mode has no collapsed entries, so both values are
    // exactly today's entry-derived counts.
    const collapsedDirectoryEntries = sortedEntries.filter((entry) => entry.isDirectory === true);
    const collapsedFileCount = collapsedDirectoryEntries.reduce(
        (acc, entry) => acc + (typeof entry.untrackedFileCount === 'number' ? entry.untrackedFileCount : 0),
        0,
    );
    const collapsedCountsAreComplete = collapsedDirectoryEntries.length > 0
        && collapsedDirectoryEntries.every((entry) => typeof entry.untrackedFileCount === 'number');
    const changedFileTotal = collapsedCountsAreComplete
        ? sortedEntries.length - collapsedDirectoryEntries.length + collapsedFileCount
        : sortedEntries.length;
    const untrackedFileTotal = input.untrackedEnumeration
        ? input.untrackedEnumeration.totalFileCount
        : sortedEntries.filter((entry) => entry.kind === 'untracked').length;

    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt,
        repo: {
            isRepo: true,
            rootPath: input.rootPath,
            backendId: 'git',
            mode: '.git',
            ...(defaultBranch ? { defaultBranch } : {}),
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
            ...(sortedEntries.some((entry) => entry.stats.isComplete === false) ? { isComplete: false } : {}),
            includedFiles: sortedEntries.filter((entry) => entry.hasIncludedDelta).length,
            pendingFiles: sortedEntries.filter((entry) => entry.hasPendingDelta).length,
            untrackedFiles: untrackedFileTotal,
            changedFiles: changedFileTotal,
            includedAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.includedAdded, 0),
            includedRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.includedRemoved, 0),
            pendingAdded: sortedEntries.reduce((acc, entry) => acc + entry.stats.pendingAdded, 0),
            pendingRemoved: sortedEntries.reduce((acc, entry) => acc + entry.stats.pendingRemoved, 0),
        },
    };
}
