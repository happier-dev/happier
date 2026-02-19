import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import type { AttachmentsUploadConfig } from '@/sync/ops/sessionAttachmentsUpload';

export function useAttachmentsUploadConfig(): AttachmentsUploadConfig {
    const attachmentsUploadsUploadLocation = useSetting('attachmentsUploadsUploadLocation');
    const attachmentsUploadsWorkspaceRelativeDir = useSetting('attachmentsUploadsWorkspaceRelativeDir');
    const attachmentsUploadsVcsIgnoreStrategy = useSetting('attachmentsUploadsVcsIgnoreStrategy');
    const attachmentsUploadsVcsIgnoreWritesEnabled = useSetting('attachmentsUploadsVcsIgnoreWritesEnabled');
    const attachmentsUploadsMaxFileBytes = useSetting('attachmentsUploadsMaxFileBytes');
    const attachmentsUploadsUploadTtlMs = useSetting('attachmentsUploadsUploadTtlMs');
    const attachmentsUploadsChunkSizeBytes = useSetting('attachmentsUploadsChunkSizeBytes');

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
        const uploadTtlMs =
            typeof attachmentsUploadsUploadTtlMs === 'number' && Number.isFinite(attachmentsUploadsUploadTtlMs)
                ? Math.max(5000, Math.floor(attachmentsUploadsUploadTtlMs))
                : 5 * 60 * 1000;
        const chunkSizeBytes =
            typeof attachmentsUploadsChunkSizeBytes === 'number' && Number.isFinite(attachmentsUploadsChunkSizeBytes)
                ? Math.max(4096, Math.floor(attachmentsUploadsChunkSizeBytes))
                : 256 * 1024;

        return {
            uploadLocation,
            workspaceRelativeDir,
            vcsIgnoreStrategy,
            vcsIgnoreWritesEnabled,
            maxFileBytes,
            uploadTtlMs,
            chunkSizeBytes,
        };
    }, [
        attachmentsUploadsChunkSizeBytes,
        attachmentsUploadsMaxFileBytes,
        attachmentsUploadsUploadLocation,
        attachmentsUploadsUploadTtlMs,
        attachmentsUploadsVcsIgnoreStrategy,
        attachmentsUploadsVcsIgnoreWritesEnabled,
        attachmentsUploadsWorkspaceRelativeDir,
    ]);
}

