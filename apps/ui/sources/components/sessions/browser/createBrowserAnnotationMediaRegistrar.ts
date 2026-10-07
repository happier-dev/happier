import { BrowserScreenshotMediaReferenceV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { normalizeSessionAttachmentUploadPath } from '@happier-dev/protocol/runtime';
import { randomUUID } from '@/platform/randomUUID';
import type { BrowserAnnotationMediaRegistrar } from '@/sync/domains/browser/context/captureProvider';
import { sessionAttachmentsUploadFile, type AttachmentsUploadConfig } from '@/sync/domains/transfers/ops/uploadSessionAttachment';

/** Uses the existing Session attachment transfer; no browser byte store or media-id registry. */
export function createBrowserAnnotationMediaRegistrar(params: Readonly<{
    sessionId: string;
    config: AttachmentsUploadConfig;
    uploadFile?: typeof sessionAttachmentsUploadFile;
}>): BrowserAnnotationMediaRegistrar {
    return async ({ snapshot }) => {
        try {
            const uploaded = await (params.uploadFile ?? sessionAttachmentsUploadFile)({
                sessionId: params.sessionId,
                messageLocalId: randomUUID(),
                file: { kind: 'memory', bytes: snapshot.bytes, name: 'browser-annotation.png', mimeType: snapshot.mimeType },
                config: params.config,
            });
            if (!uploaded.success || !normalizeSessionAttachmentUploadPath(uploaded.path)) return null;
            const reference = BrowserScreenshotMediaReferenceV1Schema.safeParse({
                mediaId: uploaded.attachmentHandle?.id ?? uploaded.sha256, mediaKind: 'image',
                width: snapshot.width, height: snapshot.height, sizeBytes: uploaded.sizeBytes,
                file: { sessionId: params.sessionId, storage: 'session', path: uploaded.path,
                    sha256: uploaded.sha256, mimeType: snapshot.mimeType },
            });
            return reference.success ? reference.data : null;
        } catch {
            return null;
        }
    };
}
