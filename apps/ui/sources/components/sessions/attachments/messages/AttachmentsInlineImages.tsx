import * as React from 'react';

import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import type { SessionMediaInlineImageSummary } from '@/sync/domains/session/media/sessionMediaMessageMeta';

export type InlineImageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>;

function resolveImageMimeType(attachment: InlineImageAttachmentSummary): string | null {
    const raw = typeof attachment.mimeType === 'string' && attachment.mimeType.trim().length > 0
        ? attachment.mimeType.trim().toLowerCase()
        : getImageMimeTypeFromPath(attachment.path) ?? getImageMimeTypeFromPath(attachment.name);
    return raw === 'image/png' || raw === 'image/jpeg' || raw === 'image/webp' || raw === 'image/gif'
        ? raw
        : null;
}

export const AttachmentsInlineImages = React.memo(function AttachmentsInlineImages(props: Readonly<{
    sessionId: string;
    attachments: readonly InlineImageAttachmentSummary[];
    onOpenPath: (path: string) => void;
}>) {
    const media = React.useMemo(() => {
        const result: SessionMediaInlineImageSummary[] = [];
        for (const attachment of props.attachments) {
            const mimeType = resolveImageMimeType(attachment);
            if (!mimeType) continue;
            result.push({
                id: attachment.sha256 ?? attachment.path,
                name: attachment.name,
                path: attachment.path,
                mimeType,
                sizeBytes: attachment.sizeBytes,
                ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
                category: 'attachment',
                role: 'input',
            });
        }
        return result;
    }, [props.attachments]);

    if (media.length === 0) return null;

    return (
        <SessionMediaInlineImages
            sessionId={props.sessionId}
            media={media}
            onOpenPath={props.onOpenPath}
            testIdPrefix="message-attachments"
        />
    );
});
