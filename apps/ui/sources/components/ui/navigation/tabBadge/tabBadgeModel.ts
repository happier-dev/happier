import type { ScmStatus } from '@/sync/domains/state/storageTypes';

/**
 * Display string for a numeric tab badge. Caps at `max` with a trailing `+`
 * (e.g. `99+`) and clamps non-finite/negative inputs to `0`.
 */
export function formatBadgeCount(value: number, max = 99): string {
    const normalized = normalizeCount(value);
    return normalized > max ? `${max}+` : String(normalized);
}

export type ScmDiffBadgeModel = Readonly<{
    added: number;
    removed: number;
    modifiedCount: number;
}>;

/**
 * Derives the git diff badge shown on the cockpit Git tab from the session's
 * SCM status. Returns `null` when there is nothing worth surfacing so callers
 * can skip rendering a badge entirely.
 */
export function formatScmDiffBadge(scm: ScmStatus | null | undefined): ScmDiffBadgeModel | null {
    if (!scm) {
        return null;
    }
    const added = normalizeCount(scm.linesAdded);
    const removed = normalizeCount(scm.linesRemoved);
    const modifiedCount = normalizeCount(scm.modifiedCount);
    if (added === 0 && removed === 0 && modifiedCount === 0) {
        return null;
    }
    return { added, removed, modifiedCount };
}

function normalizeCount(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.floor(value));
}

export type TabBarGitBadgeMode = 'changedFiles' | 'diffLines' | 'off';

export type GitTabBadge =
    | Readonly<{ kind: 'count'; value: number }>
    | Readonly<{ kind: 'diff'; added: number; removed: number; modifiedCount: number }>;

/**
 * Resolves the cockpit Git tab badge from the user's preferred mode and the
 * session SCM status. `changedFiles` (default) shows a compact changed-file
 * count; `diffLines` shows the added/removed line chip; `off` hides it.
 * Returns `null` when there is nothing to show.
 */
export function resolveGitTabBadge(
    mode: TabBarGitBadgeMode,
    scm: ScmStatus | null | undefined,
): GitTabBadge | null {
    if (mode === 'off') {
        return null;
    }
    const diff = formatScmDiffBadge(scm);
    if (!diff) {
        return null;
    }
    if (mode === 'changedFiles') {
        return diff.modifiedCount > 0 ? { kind: 'count', value: diff.modifiedCount } : null;
    }
    return { kind: 'diff', added: diff.added, removed: diff.removed, modifiedCount: diff.modifiedCount };
}
