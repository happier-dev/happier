import { countChangedFilesOutlineRootFolders } from '@/components/workspaces/files/repositoryTree/buildChangedFilesOutlineTree';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type TurnChangesSummary = Readonly<{
    fileCount: number;
    /** Folders at the top of the changed-only tree (a single-child chain counts once). */
    folderCount: number;
    added: number;
    removed: number;
    /** False when a file has no line evidence: then `added`/`removed` are not the turn's totals. */
    linesKnown: boolean;
}>;

export function summarizeTurnChanges(files: readonly ScmFileStatus[]): TurnChangesSummary {
    let added = 0;
    let removed = 0;
    let linesKnown = true;
    for (const file of files) {
        if (file.isComplete === false) linesKnown = false;
        added += Math.max(0, file.linesAdded ?? 0);
        removed += Math.max(0, file.linesRemoved ?? 0);
    }
    const folderCount = countChangedFilesOutlineRootFolders(files);
    return { fileCount: files.length, folderCount, added, removed, linesKnown };
}

/**
 * The card's list is a viewport onto the turn, not a cut of it: about one screenful of rows at a
 * time (twelve 28 px rows under a pointer, eight 36 px rows under a finger), and Show more grows it
 * in place by the same page until every file is listed.
 */
export const TURN_CHANGES_PAGE_ROWS = { precise: 12, touch: 8 } as const;

export function nextTurnChangesVisibleCount(input: Readonly<{ visible: number; total: number; pageRows: number }>): number {
    return Math.min(input.total, Math.max(0, input.visible) + input.pageRows);
}
