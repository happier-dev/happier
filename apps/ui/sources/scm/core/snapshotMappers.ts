import type { ScmWorkingSnapshot as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol';

import type { ScmCapabilities, ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export const EMPTY_SCM_CAPABILITIES: ScmCapabilities = {
    readStatus: false,
    readDiffFile: false,
    readDiffCommit: false,
    readLog: false,
    writeInclude: false,
    writeExclude: false,
    writeCommit: false,
    writeCommitPathSelection: false,
    writeCommitLineSelection: false,
    writeBackout: false,
    writeRemoteFetch: false,
    writeRemotePull: false,
    writeRemotePush: false,
    workspaceWorktreeCreate: false,
    changeSetModel: 'working-copy',
    supportedDiffAreas: ['pending', 'both'],
};

export function mergeScmCapabilities(capabilities: Partial<ScmCapabilities> | null | undefined): ScmCapabilities {
    return {
        ...EMPTY_SCM_CAPABILITIES,
        ...(capabilities ?? {}),
    };
}

export function mapProtocolEntryToUiEntry(entry: ProtocolScmWorkingSnapshot['entries'][number]): ScmWorkingEntry {
    return {
        path: entry.path,
        previousPath: entry.previousPath,
        kind: entry.kind,
        includeStatus: entry.includeStatus,
        pendingStatus: entry.pendingStatus,
        hasIncludedDelta: entry.hasIncludedDelta,
        hasPendingDelta: entry.hasPendingDelta,
        stats: {
            includedAdded: entry.stats.includedAdded,
            includedRemoved: entry.stats.includedRemoved,
            pendingAdded: entry.stats.pendingAdded,
            pendingRemoved: entry.stats.pendingRemoved,
            isBinary: entry.stats.isBinary,
        },
    };
}

export function mapProtocolSnapshotToUiSnapshot(
    snapshot: ProtocolScmWorkingSnapshot,
    projectKey: string
): ScmWorkingSnapshot {
    return {
        projectKey: snapshot.projectKey || projectKey,
        fetchedAt: snapshot.fetchedAt,
        repo: {
            isRepo: snapshot.repo.isRepo,
            rootPath: snapshot.repo.rootPath,
            backendId: snapshot.repo.backendId,
            mode: snapshot.repo.mode,
        },
        capabilities: mergeScmCapabilities(snapshot.capabilities),
        branch: {
            head: snapshot.branch.head,
            upstream: snapshot.branch.upstream,
            ahead: snapshot.branch.ahead,
            behind: snapshot.branch.behind,
            detached: snapshot.branch.detached,
        },
        stashCount: snapshot.stashCount ?? 0,
        hasConflicts: snapshot.hasConflicts,
        entries: snapshot.entries.map(mapProtocolEntryToUiEntry),
        totals: {
            includedFiles: snapshot.totals.includedFiles,
            pendingFiles: snapshot.totals.pendingFiles,
            untrackedFiles: snapshot.totals.untrackedFiles,
            includedAdded: snapshot.totals.includedAdded,
            includedRemoved: snapshot.totals.includedRemoved,
            pendingAdded: snapshot.totals.pendingAdded,
            pendingRemoved: snapshot.totals.pendingRemoved,
        },
    };
}

export function mapUiSnapshotToRemotePolicySnapshot(snapshot: ScmWorkingSnapshot): {
    hasConflicts: boolean;
    branch: {
        head: string | null;
        upstream: string | null;
        behind: number;
        detached: boolean;
    };
    totals: {
        includedFiles: number;
        pendingFiles: number;
        untrackedFiles: number;
    };
} {
    return {
        hasConflicts: snapshot.hasConflicts,
        branch: {
            head: snapshot.branch.head,
            upstream: snapshot.branch.upstream,
            behind: snapshot.branch.behind,
            detached: snapshot.branch.detached,
        },
        totals: {
            includedFiles: snapshot.totals.includedFiles,
            pendingFiles: snapshot.totals.pendingFiles,
            untrackedFiles: snapshot.totals.untrackedFiles,
        },
    };
}
