import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';

export function useAttachmentsUploadConfig(): AttachmentsUploadConfig {
    const attachmentsUploadsUploadLocation = useSetting('attachmentsUploadsUploadLocation');
    const attachmentsUploadsWorkspaceRelativeDir = useSetting('attachmentsUploadsWorkspaceRelativeDir');
    const attachmentsUploadsVcsIgnoreStrategy = useSetting('attachmentsUploadsVcsIgnoreStrategy');
    const attachmentsUploadsVcsIgnoreWritesEnabled = useSetting('attachmentsUploadsVcsIgnoreWritesEnabled');
    const attachmentsUploadsMaxFileBytes = useSetting('attachmentsUploadsMaxFileBytes');

    return React.useMemo(() => {
        const uploadLocation = attachmentsUploadsUploadLocation === 'os_temp' ? 'os_temp' : 'workspace';
        const workspaceRelativeDir =
            typeof attachmentsUploadsWorkspaceRelativeDir === 'string' && attachmentsUploadsWorkspaceRelativeDir.trim().length > 0
                ? attachmentsUploadsWorkspaceRelativeDir.trim()
                : '.happier/uploads';
        const vcsIgnoreStrategy =
            attachmentsUploadsVcsIgnoreStrategy === 'gitignore' || attachmentsUploadsVcsIgnoreStrategy === 'none'
                ? attachmentsUploadsVcsIgnoreStrategy
                : 'git_info_exclude';
        const vcsIgnoreWritesEnabled = attachmentsUploadsVcsIgnoreWritesEnabled !== false;
        const maxFileBytes =
            typeof attachmentsUploadsMaxFileBytes === 'number' && Number.isFinite(attachmentsUploadsMaxFileBytes)
                ? Math.max(1024, Math.floor(attachmentsUploadsMaxFileBytes))
                : 25 * 1024 * 1024;

        return {
            uploadLocation,
            workspaceRelativeDir,
            vcsIgnoreStrategy,
            vcsIgnoreWritesEnabled,
            maxFileBytes,
        };
    }, [
        attachmentsUploadsMaxFileBytes,
        attachmentsUploadsUploadLocation,
        attachmentsUploadsVcsIgnoreStrategy,
        attachmentsUploadsVcsIgnoreWritesEnabled,
        attachmentsUploadsWorkspaceRelativeDir,
    ]);
}
