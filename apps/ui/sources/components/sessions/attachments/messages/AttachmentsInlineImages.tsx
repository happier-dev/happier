import * as React from 'react';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';

import { SessionMediaInlineImages, type SessionMediaInlinePreviewSource } from '@/components/sessions/media/SessionMediaInlineImages';
import { resolveSessionMediaInlineRenderableImageMimeType } from '@/components/sessions/media/presentation';
import type { SessionMediaInlineMediaSummary } from '@/sync/domains/session/media/sessionMediaMessageMeta';

export type InlineImageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
    attachmentHandle?: SessionAttachmentHandleV1;
}>;

export const AttachmentsInlineImages = React.memo(function AttachmentsInlineImages(props: (
    | Readonly<{ sessionId: string; previewSource?: undefined }>
    /** A message whose files its conversation reads itself (a Discussion attachment). */
    | Readonly<{ previewSource: SessionMediaInlinePreviewSource; sessionId?: undefined }>
) & Readonly<{
    attachments: readonly InlineImageAttachmentSummary[];
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    mediaPreviewEnabled: boolean;
    numbers?: ReadonlyMap<string, number>;
    ringedPath?: string | null;
    onPreviewLoaded?: (path: string, uri: string) => void;
}>) {
    const media = React.useMemo(() => {
        const result: SessionMediaInlineMediaSummary[] = [];
        for (const attachment of props.attachments) {
            const mimeType = resolveSessionMediaInlineRenderableImageMimeType(attachment);
            if (!mimeType) continue;
            result.push({
                id: attachment.sha256 ?? attachment.path,
                mediaKind: 'image',
                name: attachment.name,
                path: attachment.path,
                mimeType,
                sizeBytes: attachment.sizeBytes,
                ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
                ...(attachment.attachmentHandle ? { attachmentHandle: attachment.attachmentHandle } : {}),
                category: 'attachment',
                role: 'input',
            });
        }
        return result;
    }, [props.attachments]);

    if (media.length === 0) return null;

    return (
        <SessionMediaInlineImages
            {...(props.previewSource !== undefined ? { previewSource: props.previewSource } : { sessionId: props.sessionId })}
            media={media}
            onOpenPath={props.onOpenPath}
            fileOpenEnabled={props.fileOpenEnabled}
            mediaPreviewEnabled={props.mediaPreviewEnabled}
            testIdPrefix="message-attachments"
            numbers={props.numbers}
            ringedPath={props.ringedPath}
            onPreviewLoaded={props.onPreviewLoaded}
        />
    );
});
