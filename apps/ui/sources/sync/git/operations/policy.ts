import type { GitWorkingSnapshot } from '@happier-dev/protocol';

export type GitOperationIntent =
    | 'fetch'
    | 'pull'
    | 'push'
    | 'commit'
    | 'revert'
    | 'stage'
    | 'unstage'
    | 'line_selection';

export type GitOperationBlockReason =
    | 'write_disabled'
    | 'missing_session_path'
    | 'not_git_repo'
    | 'conflicts_present'
    | 'staged_changes_required'
    | 'clean_worktree_required'
    | 'upstream_required'
    | 'detached_head'
    | 'branch_behind_remote';

export type GitOperationPreflightResult =
    | { allowed: true }
    | { allowed: false; reason: GitOperationBlockReason; message: string };

export function evaluateGitOperationPreflight(input: {
    intent: GitOperationIntent;
    gitWriteEnabled: boolean;
    sessionPath: string | null;
    snapshot: GitWorkingSnapshot | null | undefined;
}): GitOperationPreflightResult {
    const { intent, gitWriteEnabled, sessionPath, snapshot } = input;

    if (!sessionPath) {
        return blocked('missing_session_path', 'Session path is unavailable.');
    }

    if (!gitWriteEnabled) {
        return blocked('write_disabled', 'Enable experimental Git operations in Settings.');
    }

    if (!snapshot?.repo.isGitRepo) {
        return blocked('not_git_repo', 'The selected path is not a Git repository.');
    }

    if (requiresConflictFree(intent) && snapshot.hasConflicts) {
        return blocked('conflicts_present', 'Resolve conflicts before continuing.');
    }

    if (intent === 'commit' && snapshot.totals.stagedFiles === 0) {
        return blocked('staged_changes_required', 'Stage at least one file before committing.');
    }

    if (intent === 'pull' || intent === 'revert') {
        if (!isCleanWorktree(snapshot)) {
            return blocked('clean_worktree_required', 'Operation requires a clean working tree.');
        }
    }

    if ((intent === 'push' || intent === 'pull') && !snapshot.branch.upstream) {
        return blocked('upstream_required', 'Set an upstream branch before pull or push.');
    }

    if ((intent === 'push' || intent === 'pull' || intent === 'revert') && snapshot.branch.detached) {
        return blocked('detached_head', 'Operation is unavailable while HEAD is detached.');
    }

    if (intent === 'push' && snapshot.branch.behind > 0) {
        return blocked('branch_behind_remote', 'Pull remote changes before pushing local commits.');
    }

    return { allowed: true };
}

function requiresConflictFree(intent: GitOperationIntent): boolean {
    return intent !== 'fetch';
}

function isCleanWorktree(snapshot: GitWorkingSnapshot): boolean {
    return (
        snapshot.totals.stagedFiles === 0 &&
        snapshot.totals.unstagedFiles === 0 &&
        snapshot.totals.untrackedFiles === 0 &&
        !snapshot.hasConflicts
    );
}

function blocked(reason: GitOperationBlockReason, message: string): GitOperationPreflightResult {
    return { allowed: false, reason, message };
}
