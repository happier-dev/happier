import type { ScmWorkingSnapshotInput as ProtocolScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { ScmHostingProviderRefSchema, ScmPullRequestStatusProjectionSchema } from '@happier-dev/protocol/scm';

import type { ScmCapabilities, ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export const EMPTY_SCM_CAPABILITIES: ScmCapabilities = {
    capabilityScope: 'local-backend',
    readStatus: false,
    readDiffFile: false,
    readDiffCommit: false,
    readLog: false,
    writeInclude: false,
    writeExclude: false,
    writeCommit: false,
    writeCommitUndoLast: false,
    writeCommitPathSelection: false,
    writeCommitLineSelection: false,
    writeBackout: false,
    writeRemoteFetch: false,
    writeRemotePull: false,
    writeRemotePush: false,
    writeRemotePublish: false,
    writeRemoteAdd: false,
    writeRemoteSetUrl: false,
    writeRemoteRemove: false,
    readHostingProvider: false,
    readPullRequestStatus: false,
    writePullRequestCreate: false,
    writePullRequestCheckout: false,
    writePullRequestPrepareWorktree: false,
    writePullRequestRunStacked: false,
    defaultBranchPushPolicy: 'deny',
    writeRepositoryInit: false,
    readHostingRepositoryPublishTargets: false,
    writeHostingRepositoryPublish: false,
    writeRepositoryRemoveIndexLock: false,
    readBranches: false,
    writeBranchCreate: false,
    writeBranchCheckout: false,
    writeBranchMerge: false,
    writeBranchRebase: false,
    writeBranchOperationControl: false,
    readStash: false,
    writeStash: false,
    worktreeCreate: false,
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
        previousPath: entry.previousPath ?? null,
        kind: entry.kind,
        includeStatus: entry.includeStatus,
        pendingStatus: entry.pendingStatus,
        hasIncludedDelta: entry.hasIncludedDelta ?? false,
        hasPendingDelta: entry.hasPendingDelta ?? false,
        stats: {
            includedAdded: entry.stats?.includedAdded ?? 0,
            includedRemoved: entry.stats?.includedRemoved ?? 0,
            pendingAdded: entry.stats?.pendingAdded ?? 0,
            pendingRemoved: entry.stats?.pendingRemoved ?? 0,
            isBinary: entry.stats?.isBinary ?? false,
            ...(entry.stats?.isComplete === undefined ? {} : { isComplete: entry.stats.isComplete }),
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
            defaultBranch: snapshot.repo.defaultBranch ?? null,
            worktrees: snapshot.repo.worktrees ?? [],
            remotes: snapshot.repo.remotes ?? [],
        },
        capabilities: mergeScmCapabilities(snapshot.capabilities),
        branch: {
            head: snapshot.branch.head,
            ...(snapshot.branch.headOid === undefined ? {} : { headOid: snapshot.branch.headOid }),
            upstream: snapshot.branch.upstream,
            ...(snapshot.branch.upstreamOid === undefined ? {} : { upstreamOid: snapshot.branch.upstreamOid }),
            ahead: snapshot.branch.ahead,
            behind: snapshot.branch.behind,
            detached: snapshot.branch.detached,
        },
        stashCount: snapshot.stashCount ?? 0,
        operationState: snapshot.operationState ?? null,
        hostingProvider: snapshot.hostingProvider == null ? null : ScmHostingProviderRefSchema.parse(snapshot.hostingProvider),
        pullRequestStatus: snapshot.pullRequestStatus == null ? null : ScmPullRequestStatusProjectionSchema.parse(snapshot.pullRequestStatus),
        hasConflicts: snapshot.hasConflicts,
        entries: snapshot.entries.map(mapProtocolEntryToUiEntry),
        ...(snapshot.entriesPage ? { entriesPage: { ...snapshot.entriesPage } } : {}),
        ...(snapshot.detail ? { detail: snapshot.detail } : {}),
        ...(snapshot.listRevision ? { listRevision: snapshot.listRevision } : {}),
        ...(snapshot.summary ? { summary: { ...snapshot.summary } } : {}),
        totals: {
            includedFiles: snapshot.totals.includedFiles,
            pendingFiles: snapshot.totals.pendingFiles,
            untrackedFiles: snapshot.totals.untrackedFiles,
            includedAdded: snapshot.totals.includedAdded,
            includedRemoved: snapshot.totals.includedRemoved,
            pendingAdded: snapshot.totals.pendingAdded,
            pendingRemoved: snapshot.totals.pendingRemoved,
            ...(snapshot.totals.isComplete === undefined ? {} : { isComplete: snapshot.totals.isComplete }),
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
