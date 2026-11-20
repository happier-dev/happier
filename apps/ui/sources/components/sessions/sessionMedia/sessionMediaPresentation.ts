import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';

import type { AttachmentImagePreviewModalImage } from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/sessionMedia/sessionMediaMessageMeta';

export function resolveSessionMediaImageMimeType(media: SessionMediaInlineImageSummary): string | null {
    if (typeof media.mimeType === 'string' && media.mimeType.startsWith('image/')) return media.mimeType;
    return getImageMimeTypeFromPath(media.path) ?? getImageMimeTypeFromPath(media.name);
}

export function toSessionMediaPreviewImage(
    sessionId: string,
    media: SessionMediaInlineImageSummary,
    mimeType: string,
): AttachmentImagePreviewModalImage {
    return {
        kind: 'session-image',
        title: media.name,
        sessionId,
        filePath: media.path,
        mimeType,
        sizeBytes: media.sizeBytes,
        cacheKey: media.sha256 ?? null,
    };
}
