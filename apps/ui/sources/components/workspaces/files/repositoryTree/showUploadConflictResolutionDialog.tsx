import type { UploadConflictResolutionRequest, UploadConflictStrategy } from '@/hooks/workspaces/transfers/useWorkspaceFileTransfers';
import { t } from '@/text';

import { showPathConflictResolutionDialog } from './showPathConflictResolutionDialog';

export async function showUploadConflictResolutionDialog(params: UploadConflictResolutionRequest): Promise<UploadConflictStrategy> {
    return await showPathConflictResolutionDialog({
        title: t('files.upload.conflicts.title'),
        body: t('files.upload.conflicts.body', { conflictCount: params.conflictCount, totalCount: params.totalCount }),
        allowSkip: true,
        primaryStrategy: 'keep_both',
        testIdPrefix: 'upload-conflicts',
        signal: params.signal,
    });
}
