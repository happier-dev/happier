import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { projectAgentInputAttachmentRowItem, type AgentInputAttachment, type AgentInputAttachmentsRowItem } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { AttachmentDraft } from './attachmentDraftModel';

export function resolveAttachmentSourceName(source: AttachmentUploadSource): string {
    return source.kind === 'web' ? source.file.name : source.name;
}

export function resolveAttachmentImagePresentation(source: AttachmentUploadSource) {
    if (source.kind === 'folder') return null;
    const viewer = resolveFileViewerKind(source.kind === 'web'
        ? { path: source.file.name, mimeType: source.file.type }
        : { path: source.name, mimeType: source.mimeType, ...(source.kind === 'memory' ? { head: source.bytes } : {}) });
    return viewer.kind === 'image' || viewer.kind === 'svg' ? viewer : null;
}

/** Tray and offscreen numbering consume the same source-to-row presentation. */
export function projectAttachmentDraftToAgentInputAttachment(draft: AttachmentDraft, options: Readonly<{
    webPreviewUri?: string;
    onRemove?: () => void;
}> = {}): AgentInputAttachment {
    const source = draft.source;
    const image = resolveAttachmentImagePresentation(source);
    const uri = image ? source.kind === 'native' ? source.uri
        : source.kind === 'memory' ? source.previewUri : options.webPreviewUri : null;
    return {
        key: draft.id, label: resolveAttachmentSourceName(source),
        attachmentType: source.kind === 'folder' ? 'folder' : 'file', status: draft.status,
        preview: uri && image ? { kind: 'image', uri, mimeType: image.mimeType } : undefined,
        uploadProgress: draft.uploadProgress, error: draft.error,
        ...(options.onRemove ? { onRemove: options.onRemove } : {}),
    };
}

/** Picture identity survives an unmount; only its hook-owned web preview URL expires. */
export function projectAttachmentDraftToAgentInputRowItem(draft: AttachmentDraft): AgentInputAttachmentsRowItem {
    const row = projectAgentInputAttachmentRowItem(projectAttachmentDraftToAgentInputAttachment(draft));
    return resolveAttachmentImagePresentation(draft.source)
        ? { ...row, kind: 'media', media: 'image' } : row;
}
