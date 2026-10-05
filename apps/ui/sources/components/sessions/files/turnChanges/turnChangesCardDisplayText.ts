import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { resolveScmChangePathTag } from '@/scm/scmChangePathTag';
import { resolveScmChangeRowDisplayText } from '@/components/workspaces/scm/changes/scmChangeRowDisplayText';
import { toolTextBlock, type ToolDisplayTextBlock } from '@/components/tools/renderers/core/toolDisplayTextTypes';
import { t } from '@/text';
import { summarizeTurnChanges } from './turnChangesCardModel';

export function resolveTurnChangesCardDisplayText(files: readonly ScmFileStatus[]) {
    const summary = summarizeTurnChanges(files);
    return {
        summary,
        title: t('turnChanges.card.edited', { count: summary.fileCount }),
        count: summary.folderCount > 1
            ? t('turnChanges.card.fileCountInFolders', { count: summary.fileCount, folders: summary.folderCount })
            : t('turnChanges.card.fileCount', { count: summary.fileCount }),
        added: summary.linesKnown ? `+${summary.added.toLocaleString()}` : null,
        removed: summary.linesKnown ? `−${summary.removed.toLocaleString()}` : null,
    };
}

/** Only the recap's semantic display text, never its hidden diff payload or action chrome. */
export function projectTurnChangesCardDisplayText(files: readonly ScmFileStatus[]): readonly ToolDisplayTextBlock[] {
    const text = resolveTurnChangesCardDisplayText(files);
    return [
        ...toolTextBlock('tool-turn-changes-title', text.title),
        ...toolTextBlock('tool-turn-changes-added', text.added),
        ...toolTextBlock('tool-turn-changes-removed', text.removed),
        ...toolTextBlock('tool-turn-changes-count', text.count),
        ...files.flatMap((file, index) => {
            const row = resolveScmChangeRowDisplayText(file, true);
            const prefix = `tool-turn-changes-file-${index}`;
            return [
                ...toolTextBlock(`${prefix}-path`, row.path),
                ...toolTextBlock(`${prefix}-tag`, resolveScmChangePathTag(file.fullPath)),
                ...toolTextBlock(`${prefix}-mark`, row.mark),
                ...toolTextBlock(`${prefix}-added`, row.added),
                ...toolTextBlock(`${prefix}-removed`, row.removed),
                ...toolTextBlock(`${prefix}-unavailable`, row.unavailable),
                ...toolTextBlock(`${prefix}-rename`, row.renamedFrom),
            ];
        }),
    ];
}
