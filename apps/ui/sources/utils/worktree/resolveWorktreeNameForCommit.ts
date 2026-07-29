import { hasForbiddenGitRefName, normalizeWorktreeDisplayName } from '@happier-dev/protocol';

/**
 * Resolve the worktree/branch name to commit into the new-session checkout
 * draft from a user-typed value, falling back to the generated suggestion.
 *
 * Uses the canonical protocol sanitizer ([[scm/worktreeName]]) so the name we
 * store in the draft (and show on the checkout chip) matches the branch git
 * will actually create on the daemon. When the typed value normalizes to
 * nothing or contains a git-forbidden segment (a bare `@` or a `.lock` suffix —
 * which the daemon rejects rather than rewrites), we fall back to the
 * suggestion so the create flow never commits a name git would refuse.
 */
export function resolveWorktreeNameForCommit(rawName: string, suggestion: string): string {
    const normalized = normalizeWorktreeDisplayName(rawName);
    if (!normalized || hasForbiddenGitRefName(normalized)) {
        return suggestion;
    }
    return normalized;
}
