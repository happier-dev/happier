import type { GitDiffFileMode } from '@happier-dev/protocol';
import type { GitWorkingEntry } from '@/sync/storageTypes';

export function canUseLineSelection(input: {
    gitWriteEnabled: boolean;
    hasConflicts: boolean;
    isBinary: boolean;
    diffMode: GitDiffFileMode;
    diffContent: string | null;
}): boolean {
    if (!input.gitWriteEnabled) return false;
    if (input.hasConflicts) return false;
    if (input.isBinary) return false;
    if (input.diffMode === 'both') return false;
    if (!input.diffContent || input.diffContent.trim().length === 0) return false;
    return true;
}

export function buildFileLineSelectionFingerprint(
    entry: Pick<
        GitWorkingEntry,
        'path' | 'previousPath' | 'indexStatus' | 'worktreeStatus' | 'hasStagedDelta' | 'hasUnstagedDelta' | 'stats'
    > | null | undefined,
): string {
    if (!entry) return 'none';

    return [
        entry.path,
        entry.previousPath ?? '',
        entry.indexStatus,
        entry.worktreeStatus,
        String(entry.hasStagedDelta),
        String(entry.hasUnstagedDelta),
        String(entry.stats.stagedAdded),
        String(entry.stats.stagedRemoved),
        String(entry.stats.unstagedAdded),
        String(entry.stats.unstagedRemoved),
        String(entry.stats.isBinary),
    ].join('|');
}
