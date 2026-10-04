import type { ScmFileStatus } from '@/scm/scmStatusFiles';
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
