import { BrowserScreenshotMediaReferenceV1Schema, type BrowserScreenshotMediaReferenceV1 } from '@happier-dev/protocol/browser/context/v1';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import type { ExactSessionMachineTargetIdentity } from '@/sync/ops/sessionMachineTarget';
import type { AttachmentsUploadConfig, sessionAttachmentsUploadFile } from '@/sync/domains/transfers/ops/uploadSessionAttachment';
import type { AttachmentDraft } from '../attachments/attachmentDraftModel';
import { uploadAttachmentDraftsToSession } from '../attachments/uploadAttachmentDraftsToSession';
import { admitComposerDraftItems } from '../composer/admitComposerDraftItems';
import { appendToSessionDraft } from '../composer/appendToSessionDraft';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { ImageAnnotationSource } from '@/components/ui/media/annotation/types';

export type BrowserAnnotationCommitInput = Readonly<{
    png: Uint8Array; width: number; height: number; original: ImageAnnotationSource;
    document: ImageMarksDocumentV1; comment: string; annotationId: string;
}>;
export type BrowserAnnotationCommitResult = Readonly<{ ok: true; imageRef: BrowserScreenshotMediaReferenceV1; imageNumber?: number }>
    | Readonly<{ ok: false; reason: string }>;

/** Browser Attach hands only flattened pixels to the normal picked-image and transfer owners. */
export async function commitBrowserAnnotation(params: Readonly<{
    sessionTarget: ExactSessionMachineTargetIdentity; config: AttachmentsUploadConfig;
    uploadFile?: typeof sessionAttachmentsUploadFile;
}>, input: BrowserAnnotationCommitInput): Promise<BrowserAnnotationCommitResult> {
    const source = {
        kind: 'memory' as const, bytes: input.png, name: 'browser-annotation.png', mimeType: 'image/png',
    };
    const admission = admitComposerDraftItems({ items: [{ kind: 'image', source }] });
    if (admission.status !== 'admitted') return { ok: false, reason: admission.reason };
    let draft: AttachmentDraft = admission.drafts[0]!;
    try {
        draft = { ...draft, browserAnnotation: { annotationId: input.annotationId, image: input.document.image }, edit: {
            // Both viewport providers hand off PNG data URIs, not borrowed preview handles.
            original: { kind: 'memory', bytes: decodeBase64(input.original.uri.slice('data:image/png;base64,'.length)),
                name: 'browser-annotation-original.png', mimeType: 'image/png', previewUri: input.original.uri },
            document: input.document,
        } };
        const uploaded = await uploadAttachmentDraftsToSession({ sessionId: params.sessionTarget.sessionId,
            sessionTarget: params.sessionTarget, config: params.config, drafts: [draft], uploadFile: params.uploadFile,
            applyDraftPatch: (_id, patch) => { draft = { ...draft, ...patch }; } });
        const image = uploaded.uploaded[0]!;
        if (!image?.attachmentHandle) return { ok: false, reason: 'browser_context_annotation_capture_failed' };
        const reference = BrowserScreenshotMediaReferenceV1Schema.safeParse({ mediaId: image.attachmentHandle.id,
            mediaKind: 'image', width: input.width, height: input.height, sizeBytes: image.sizeBytes,
            file: { sessionId: params.sessionTarget.sessionId, storage: 'session', path: image.path,
                sha256: image.sha256, mimeType: 'image/png' } });
        if (!reference.success) return { ok: false, reason: 'browser_context_annotation_capture_failed' };
        const appended = appendToSessionDraft({ sessionTarget: params.sessionTarget, items: [
            { kind: 'image', source, draft },
            ...(input.comment.trim() ? [{ kind: 'text' as const, text: `\n\n${input.comment.trim()}` }] : []),
        ] });
        return appended.status === 'applied' ? { ok: true, imageRef: reference.data, imageNumber: appended.imageNumbers[0] }
            : { ok: false, reason: appended.status === 'invalidOperation' ? appended.reason : appended.status };
    } catch {
        return { ok: false, reason: 'browser_context_annotation_capture_failed' };
    }
}
