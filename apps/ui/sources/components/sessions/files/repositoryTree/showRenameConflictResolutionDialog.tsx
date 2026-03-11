import { t } from '@/text';

import { showPathConflictResolutionDialog } from './showPathConflictResolutionDialog';

export async function showRenameConflictResolutionDialog(params: Readonly<{
    path: string;
}>): Promise<'keep_both' | 'replace' | 'cancel'> {
    return await showPathConflictResolutionDialog({
        title: t('files.repositoryTree.rename.conflicts.title'),
        body: t('files.repositoryTree.rename.conflicts.body', { path: params.path }),
        allowSkip: false,
        primaryStrategy: null,
        testIdPrefix: 'path-conflicts',
    }) as 'keep_both' | 'replace' | 'cancel';
}
