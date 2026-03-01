import type { ScmCommitSelectionPatch } from '@/sync/domains/state/storageTypes';

export function buildCommitSelectionPathHints(input: Readonly<{
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
}>): string[] {
    const selected = new Set<string>();
    for (const path of input.commitSelectionPaths) {
        const normalized = path.trim();
        if (normalized) selected.add(normalized);
    }
    for (const patch of input.commitSelectionPatches) {
        const normalized = patch.path.trim();
        if (normalized) selected.add(normalized);
    }
    return Array.from(selected).sort((a, b) => a.localeCompare(b));
}

export function countCommitSelectionItems(input: Readonly<{
    commitSelectionPaths: readonly string[];
    commitSelectionPatches: readonly ScmCommitSelectionPatch[];
}>): number {
    return buildCommitSelectionPathHints(input).length;
}
