import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import { isAtomicCommitStrategy } from '@/scm/settings/commitStrategy';
import {
    evaluateScmRemoteMutationPolicy,
    scmPathMatchesScopePath,
    type ScmRemoteMutationReason,
} from '@happier-dev/protocol';
import { mapUiSnapshotToRemotePolicySnapshot } from '@/scm/core/snapshotMappers';

export type ScmOperationIntent =
    | 'fetch'
    | 'pull'
    | 'push'
    | 'commit'
    | 'revert'
    | 'stage'
    | 'unstage'
    | 'line_selection';

export type ScmOperationBlockReason =
    | 'write_disabled'
    | 'missing_session_path'
    | 'not_repository'
    | 'feature_unsupported'
    | 'conflicts_present'
    | 'included_changes_required'
    | 'clean_worktree_required'
    | 'upstream_required'
    | 'detached_head'
    | 'branch_behind_remote';

export type ScmOperationPreflightResult =
    | { allowed: true }
    | { allowed: false; reason: ScmOperationBlockReason; message: string };

export function evaluateScmOperationPreflight(input: {
    intent: ScmOperationIntent;
    scmWriteEnabled: boolean;
    sessionPath: string | null;
    snapshot: ScmWorkingSnapshot | null | undefined;
    commitStrategy?: ScmCommitStrategy;
    commitSelectionPaths?: string[] | null;
}): ScmOperationPreflightResult {
    const {
        intent,
        scmWriteEnabled,
        sessionPath,
        snapshot,
        commitStrategy = 'git_staging',
        commitSelectionPaths,
    } = input;

    if (!sessionPath) {
        return blocked('missing_session_path', 'Session path is unavailable.');
    }

    if (!scmWriteEnabled) {
        return blocked('write_disabled', 'Enable experimental source control write operations in Settings.');
    }

    if (!snapshot?.repo.isRepo) {
        return blocked('not_repository', 'The selected path is not a source control repository.');
    }

    const policy = scmUiBackendRegistry.getPluginForSnapshot(snapshot).mapCapabilitiesToUiPolicy(snapshot);
    if (!supportsOperation(snapshot, intent)) {
        return blocked('feature_unsupported', 'This operation is not supported by the active source control backend.');
    }

    if (isAtomicCommitStrategy(commitStrategy) && (intent === 'stage' || intent === 'unstage')) {
        return blocked('feature_unsupported', 'Live staging is disabled while atomic commit strategy is enabled.');
    }
    if (
        isAtomicCommitStrategy(commitStrategy)
        && intent === 'line_selection'
        && snapshot.capabilities?.writeCommitLineSelection !== true
    ) {
        return blocked('feature_unsupported', 'Line selection is not supported by the active source control backend.');
    }

    if (requiresConflictFree(intent) && snapshot.hasConflicts) {
        return blocked('conflicts_present', 'Resolve conflicts before continuing.');
    }

    if (intent === 'commit') {
        if (isAtomicCommitStrategy(commitStrategy)) {
            const hasSelection = hasSelectedPendingChanges(snapshot, commitSelectionPaths);
            if (hasSelection === false) {
                return blocked('included_changes_required', 'No selected changes to commit.');
            }
            if (hasSelection === null && !hasAnyPendingChanges(snapshot)) {
                return blocked('included_changes_required', 'No pending changes to commit.');
            }
        } else if (policy.changeSetModel === 'index') {
            if (snapshot.totals.includedFiles === 0) {
                return blocked('included_changes_required', 'Include at least one change before committing.');
            }
        } else if (!hasAnyPendingChanges(snapshot)) {
            return blocked('included_changes_required', 'No pending changes to commit.');
        }
    }

    if (intent === 'revert') {
        if (!isCleanWorktree(snapshot)) {
            return blocked('clean_worktree_required', 'Operation requires a clean working tree.');
        }
    }

    if (intent === 'push' || intent === 'pull') {
        const inferredTarget = scmUiBackendRegistry.getPluginForSnapshot(snapshot).inferRemoteTarget(snapshot);
        const hasInferredTarget = policy.changeSetModel === 'working-copy' && Boolean(inferredTarget.branch);
        const remotePolicyResult = evaluateScmRemoteMutationPolicy({
            kind: intent,
            snapshot: mapUiSnapshotToRemotePolicySnapshot(snapshot),
            hasExplicitTarget: hasInferredTarget,
            policy: {
                requireUpstreamWhenNoExplicitTarget: true,
                requireActiveHead: policy.changeSetModel === 'working-copy',
                blockPushOnConflicts: true,
                blockPushWhenBehind: policy.changeSetModel === 'index',
                requireCleanPull: true,
            },
        });
        if (!remotePolicyResult.ok) {
            return blockFromRemotePolicyReason(remotePolicyResult.reason);
        }
    }

    if ((intent === 'revert') && snapshot.branch.detached) {
        return blocked('detached_head', 'Operation is unavailable while HEAD is detached.');
    }

    return { allowed: true };
}

function requiresConflictFree(intent: ScmOperationIntent): boolean {
    return intent === 'commit' || intent === 'pull' || intent === 'push' || intent === 'revert';
}

function isCleanWorktree(snapshot: ScmWorkingSnapshot): boolean {
    return (
        snapshot.totals.includedFiles === 0 &&
        snapshot.totals.pendingFiles === 0 &&
        snapshot.totals.untrackedFiles === 0 &&
        !snapshot.hasConflicts
    );
}

function hasAnyPendingChanges(snapshot: ScmWorkingSnapshot): boolean {
    return (
        snapshot.totals.includedFiles > 0
        || snapshot.totals.pendingFiles > 0
        || snapshot.totals.untrackedFiles > 0
    );
}

function hasSelectedPendingChanges(
    snapshot: ScmWorkingSnapshot,
    selectedPaths: string[] | null | undefined
): boolean | null {
    if (!selectedPaths || selectedPaths.length === 0) {
        return null;
    }

    const selectedScopes = selectedPaths
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    if (selectedScopes.length === 0) {
        return null;
    }

    return snapshot.entries.some((entry) =>
        selectedScopes.some((scopePath) =>
            scmPathMatchesScopePath({ changedPath: entry.path, scopePath }),
        )
        && (entry.hasPendingDelta || entry.hasIncludedDelta),
    );
}

function supportsOperation(snapshot: ScmWorkingSnapshot, intent: ScmOperationIntent): boolean {
    const capabilities = snapshot.capabilities;
    if (!capabilities) {
        return false;
    }
    switch (intent) {
        case 'fetch':
            return capabilities.writeRemoteFetch;
        case 'pull':
            return capabilities.writeRemotePull;
        case 'push':
            return capabilities.writeRemotePush;
        case 'commit':
            return capabilities.writeCommit;
        case 'revert':
            return capabilities.writeBackout;
        case 'stage':
            return capabilities.writeInclude;
        case 'unstage':
            return capabilities.writeExclude;
        case 'line_selection':
            return capabilities.writeCommitLineSelection || capabilities.writeInclude || capabilities.writeExclude;
        default:
            return true;
    }
}

function blocked(reason: ScmOperationBlockReason, message: string): ScmOperationPreflightResult {
    return { allowed: false, reason, message };
}

function blockFromRemotePolicyReason(reason: ScmRemoteMutationReason): ScmOperationPreflightResult {
    switch (reason) {
        case 'conflicts_present':
            return blocked('conflicts_present', 'Resolve conflicts before continuing.');
        case 'upstream_required':
            return blocked('upstream_required', 'Set a tracking target before pull or push.');
        case 'detached_head':
            return blocked('detached_head', 'Operation is unavailable while HEAD is detached.');
        case 'branch_behind_remote':
            return blocked('branch_behind_remote', 'Pull remote changes before pushing local commits.');
        case 'clean_worktree_required':
            return blocked('clean_worktree_required', 'Operation requires a clean working tree.');
        default:
            return blocked('feature_unsupported', 'This operation is not supported by the active source control backend.');
    }
}
