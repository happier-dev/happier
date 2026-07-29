/**
 * Canonical sanitization for Git worktree / branch display names (UI/contract side).
 *
 * Used by the UI to preview / commit a user-chosen name into the new-session
 * checkout draft so the stored `displayName` matches the branch name git will
 * actually create. The daemon SCM plugin (`@happier-dev/plugins-scm-git`) keeps
 * its own equivalent normalization because, by design, the plugin depends on
 * `@happier-dev/plugin-sdk` rather than `@happier-dev/protocol`; both sides
 * apply identical Git ref-name rules.
 *
 * The transforms mirror Git's ref-name restrictions:
 *  - whitespace collapses to `-`
 *  - `@{`, `~`, `^`, `:`, `?`, `*`, `[`, `]`, `\` become `-`
 *  - runs of `.` collapse to `-`
 *  - leading / trailing `.`, `/`, `-` per segment are stripped
 *  - `/` is preserved as a path separator between normalized segments
 *
 * A segment is "forbidden" (must be rejected, not silently rewritten) when it
 * is a bare `@` or ends in `.lock` — both ambiguous to Git's ref machinery.
 */

function normalizeWorktreeNameSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return '';

  return trimmed
    .replace(/\s+/g, '-')
    .replace(/@\{/g, '-')
    .replace(/[~^:?*[\]\\]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/(^[./-]+)|([./-]+$)/g, '')
    .replace(/-+/g, '-');
}

function hasForbiddenGitRefSegment(segment: string): boolean {
  const normalizedSegment = normalizeWorktreeNameSegment(segment);
  return normalizedSegment === '@' || normalizedSegment.endsWith('.lock');
}

/**
 * Normalize a free-form worktree/branch display name into a Git-safe ref name.
 * Returns an empty string when the input has no usable characters (callers
 * should fall back to a generated name or reject as appropriate).
 */
export function normalizeWorktreeDisplayName(value: string): string {
  const normalizedSegments = value
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .map(normalizeWorktreeNameSegment)
    .filter((segment) => segment.length > 0);

  return normalizedSegments.join('/');
}

/**
 * True when any segment of the name is forbidden by Git's ref rules (bare `@`
 * or a `.lock` suffix). Such names must be rejected rather than normalized,
 * because normalization cannot make them valid.
 */
export function hasForbiddenGitRefName(value: string): boolean {
  return value
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .some(hasForbiddenGitRefSegment);
}

/**
 * Repo-root-relative parent directory under which Happier materializes managed
 * worktrees (e.g. `<repoRoot>/.dev/worktree/<branchName>`). The daemon creates
 * this directory and places each worktree inside it; the UI previews the same
 * location so the new-session chip can show where a pending worktree will land.
 *
 * Centralized here so the daemon's authoritative `git worktree add` path and the
 * UI's predicted path can never drift apart.
 */
export const WORKTREE_RELATIVE_PARENT_DIR = '.dev/worktree';

/**
 * Build the repo-root-relative path of a worktree for the given (already
 * git-sanitized) branch name: `${WORKTREE_RELATIVE_PARENT_DIR}/<branchName>`.
 *
 * The daemon uses this for the authoritative `git worktree add` target; the UI
 * uses it (joined onto the repo root) to predict where a pending worktree will
 * be created. Returns the parent dir alone when the name is empty so callers
 * never produce a trailing-slash path.
 */
export function buildWorktreeRelativePath(branchName: string): string {
  const trimmed = branchName.trim();
  return trimmed ? `${WORKTREE_RELATIVE_PARENT_DIR}/${trimmed}` : WORKTREE_RELATIVE_PARENT_DIR;
}
