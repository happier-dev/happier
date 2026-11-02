import * as React from 'react';

import { storage, useSetting } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import type { AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import { DEFAULT_ATTACHMENT_UPLOAD_MAX_FILE_BYTES_V1 } from '@happier-dev/protocol/transfers/attachments/attachmentLimitsV1';

type AttachmentUploadSettings = Pick<Settings, 'attachmentsUploadsUploadLocation' | 'attachmentsUploadsWorkspaceRelativeDir'
    | 'attachmentsUploadsVcsIgnoreStrategy' | 'attachmentsUploadsVcsIgnoreWritesEnabled' | 'attachmentsUploadsMaxFileBytes'>;

export function resolveAttachmentsUploadConfig(settings: AttachmentUploadSettings): AttachmentsUploadConfig {
    const uploadLocation = settings.attachmentsUploadsUploadLocation === 'os_temp' ? 'os_temp' : 'workspace';
    const workspaceRelativeDir = typeof settings.attachmentsUploadsWorkspaceRelativeDir === 'string'
        && settings.attachmentsUploadsWorkspaceRelativeDir.trim().length > 0
        ? settings.attachmentsUploadsWorkspaceRelativeDir.trim() : '.happier/uploads';
    const vcsIgnoreStrategy = settings.attachmentsUploadsVcsIgnoreStrategy === 'gitignore' || settings.attachmentsUploadsVcsIgnoreStrategy === 'none'
        ? settings.attachmentsUploadsVcsIgnoreStrategy : 'git_info_exclude';
    return { uploadLocation, workspaceRelativeDir, vcsIgnoreStrategy,
        vcsIgnoreWritesEnabled: settings.attachmentsUploadsVcsIgnoreWritesEnabled !== false,
        maxFileBytes: typeof settings.attachmentsUploadsMaxFileBytes === 'number' && Number.isFinite(settings.attachmentsUploadsMaxFileBytes)
            ? Math.max(1024, Math.floor(settings.attachmentsUploadsMaxFileBytes)) : DEFAULT_ATTACHMENT_UPLOAD_MAX_FILE_BYTES_V1 };
}

export function readAttachmentsUploadConfig(): AttachmentsUploadConfig {
    return resolveAttachmentsUploadConfig(storage.getState().settings);
}

export function useAttachmentsUploadConfig(): AttachmentsUploadConfig {
    const attachmentsUploadsUploadLocation = useSetting('attachmentsUploadsUploadLocation');
    const attachmentsUploadsWorkspaceRelativeDir = useSetting('attachmentsUploadsWorkspaceRelativeDir');
    const attachmentsUploadsVcsIgnoreStrategy = useSetting('attachmentsUploadsVcsIgnoreStrategy');
    const attachmentsUploadsVcsIgnoreWritesEnabled = useSetting('attachmentsUploadsVcsIgnoreWritesEnabled');
    const attachmentsUploadsMaxFileBytes = useSetting('attachmentsUploadsMaxFileBytes');

    return React.useMemo(() => resolveAttachmentsUploadConfig({
        attachmentsUploadsUploadLocation, attachmentsUploadsWorkspaceRelativeDir, attachmentsUploadsVcsIgnoreStrategy,
        attachmentsUploadsVcsIgnoreWritesEnabled, attachmentsUploadsMaxFileBytes,
    }), [
        attachmentsUploadsMaxFileBytes,
        attachmentsUploadsUploadLocation,
        attachmentsUploadsVcsIgnoreStrategy,
        attachmentsUploadsVcsIgnoreWritesEnabled,
        attachmentsUploadsWorkspaceRelativeDir,
    ]);
}
