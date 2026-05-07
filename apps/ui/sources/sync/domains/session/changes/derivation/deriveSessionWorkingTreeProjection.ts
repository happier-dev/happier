import {
    reconcileWithScmSnapshot,
    type SessionChangeSet,
    type ScmWorkingSnapshot as ProtocolScmWorkingSnapshot,
} from '@happier-dev/protocol';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { mergeScmCapabilities } from '@/scm/core/snapshotMappers';

export function deriveSessionWorkingTreeProjection(params: Readonly<{
    sessionChangeSet: SessionChangeSet | null;
    snapshot: ScmWorkingSnapshot | null;
}>): ReturnType<typeof reconcileWithScmSnapshot> | null {
    if (!params.sessionChangeSet) return null;
    const mergedCapabilities = params.snapshot
        ? mergeScmCapabilities(params.snapshot.capabilities)
        : null;
    const normalizedSnapshot: ProtocolScmWorkingSnapshot | null = params.snapshot
        ? {
            projectKey: params.snapshot.projectKey,
            fetchedAt: params.snapshot.fetchedAt,
            repo: {
                isRepo: params.snapshot.repo.isRepo,
                rootPath: params.snapshot.repo.rootPath,
                backendId: params.snapshot.repo.backendId ?? null,
                mode: params.snapshot.repo.mode ?? null,
                worktrees: params.snapshot.repo.worktrees ?? [],
                remotes: params.snapshot.repo.remotes ?? [],
            },
            capabilities: {
                readStatus: mergedCapabilities!.readStatus ?? false,
                readDiffFile: mergedCapabilities!.readDiffFile ?? false,
                readDiffCommit: mergedCapabilities!.readDiffCommit ?? false,
                readLog: mergedCapabilities!.readLog ?? false,
                readBranches: mergedCapabilities!.readBranches,
                readStash: mergedCapabilities!.readStash,
                writeInclude: mergedCapabilities!.writeInclude ?? false,
                writeExclude: mergedCapabilities!.writeExclude ?? false,
                writeDiscard: mergedCapabilities!.writeDiscard,
                writeCommit: mergedCapabilities!.writeCommit ?? false,
                writeCommitPathSelection: mergedCapabilities!.writeCommitPathSelection ?? false,
                writeCommitLineSelection: mergedCapabilities!.writeCommitLineSelection ?? false,
                writeBackout: mergedCapabilities!.writeBackout ?? false,
                writeBranchCreate: mergedCapabilities!.writeBranchCreate,
                writeBranchCheckout: mergedCapabilities!.writeBranchCheckout,
                writeRemoteFetch: mergedCapabilities!.writeRemoteFetch ?? false,
                writeRemotePull: mergedCapabilities!.writeRemotePull ?? false,
                writeRemotePush: mergedCapabilities!.writeRemotePush ?? false,
                writeRemotePublish: mergedCapabilities!.writeRemotePublish,
                writeStash: mergedCapabilities!.writeStash,
                worktreeCreate: mergedCapabilities!.worktreeCreate ?? false,
                changeSetModel: mergedCapabilities!.changeSetModel ?? 'working-copy',
                supportedDiffAreas: mergedCapabilities!.supportedDiffAreas ?? ['pending', 'both'],
                operationLabels: mergedCapabilities!.operationLabels,
            },
            branch: {
                head: params.snapshot.branch.head,
                upstream: params.snapshot.branch.upstream,
                ahead: params.snapshot.branch.ahead,
                behind: params.snapshot.branch.behind,
                detached: params.snapshot.branch.detached,
            },
            stashCount: params.snapshot.stashCount ?? 0,
            hasConflicts: params.snapshot.hasConflicts,
            entries: params.snapshot.entries,
            totals: {
                includedFiles: params.snapshot.totals.includedFiles,
                pendingFiles: params.snapshot.totals.pendingFiles,
                untrackedFiles: params.snapshot.totals.untrackedFiles,
                includedAdded: params.snapshot.totals.includedAdded,
                includedRemoved: params.snapshot.totals.includedRemoved,
                pendingAdded: params.snapshot.totals.pendingAdded,
                pendingRemoved: params.snapshot.totals.pendingRemoved,
            },
        }
        : null;
    return reconcileWithScmSnapshot({
        sessionChangeSet: params.sessionChangeSet,
        snapshot: normalizedSnapshot,
    });
}
