import type { ScmWorkingEntry } from '@/sync/domains/state/storageTypes';

export type ScmDiffFileMode = 'included' | 'pending' | 'both';

export function canUseLineSelection(input: {
    scmWriteEnabled: boolean;
    includeExcludeEnabled?: boolean;
    virtualLineSelectionEnabled?: boolean;
    hasConflicts: boolean;
    isBinary: boolean;
    diffMode: ScmDiffFileMode;
    diffContent: string | null;
}): boolean {
    if (!input.scmWriteEnabled) return false;
    const liveSelectionEnabled = input.includeExcludeEnabled !== false;
    const virtualSelectionEnabled = input.virtualLineSelectionEnabled === true;
    if (!liveSelectionEnabled && !virtualSelectionEnabled) return false;
    if (input.hasConflicts) return false;
    if (input.isBinary) return false;
    if (input.diffMode === 'both') return false;
    if (virtualSelectionEnabled && !liveSelectionEnabled && input.diffMode !== 'pending') return false;
    if (!input.diffContent || input.diffContent.trim().length === 0) return false;
    return true;
}

export function buildFileLineSelectionFingerprint(
    entry: Pick<
        ScmWorkingEntry,
        'path' | 'previousPath' | 'includeStatus' | 'pendingStatus' | 'hasIncludedDelta' | 'hasPendingDelta' | 'stats'
    > | null | undefined,
): string {
    if (!entry) return 'none';

    return [
        entry.path,
        entry.previousPath ?? '',
        entry.includeStatus,
        entry.pendingStatus,
        String(entry.hasIncludedDelta),
        String(entry.hasPendingDelta),
        String(entry.stats.includedAdded),
        String(entry.stats.includedRemoved),
        String(entry.stats.pendingAdded),
        String(entry.stats.pendingRemoved),
        String(entry.stats.isBinary),
    ].join('|');
}
