import type { ComposerTransactionResultV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { admitAttachmentDraftSources } from '../attachments/attachmentDraftAdmission';
import { readAttachmentsUploadConfig } from '../attachments/useAttachmentsUploadConfig';
import type { AttachmentDraft } from '../attachments/attachmentDraftModel';
import type { ComposerAttachmentInsertionItem } from './composerAttachmentAppend';

export type ComposerDraftAppendItem = Readonly<{ kind: 'image'; source: Exclude<AttachmentsUploadFileSource, { kind: 'web' }>; note?: string;
    /** Internal producer already admitted this occurrence through this owner. */
    draft?: AttachmentDraft }>
    | Readonly<{ kind: 'video' | 'file'; source: AttachmentsUploadFileSource; note?: string }>
    | Readonly<{ kind: 'text'; text: string }>;
export type ComposerDraftAppendContent = Readonly<{
    items: readonly ComposerDraftAppendItem[];
    note?: string;
    windowText?: Readonly<{ text: string; name: string }>;
}>;

/** Pictures share paste intake; a prepared browser occurrence retains its issued upload checkpoint. */
export function admitComposerDraftItems(input: ComposerDraftAppendContent):
    | Extract<ComposerTransactionResultV1, { status: 'invalidOperation' }>
    | Readonly<{ status: 'admitted'; drafts: readonly AttachmentDraft[]; items: readonly ComposerAttachmentInsertionItem[] }> {
    const sources = input.items.flatMap(item => {
        if (item.kind === 'text') return [];
        if (item.kind === 'image' && item.draft) return [];
        const source = item.source;
        return [item.kind === 'image' && source.kind === 'memory' && !source.previewUri
            ? { ...source, previewUri: `data:${source.mimeType || 'image/png'};base64,${encodeBase64(source.bytes)}` } : source];
    });
    if (input.windowText) sources.push({ kind: 'memory', name: input.windowText.name,
        bytes: new TextEncoder().encode(input.windowText.text), mimeType: 'text/plain' });
    const admission = sources.length > 0
        ? admitAttachmentDraftSources({ sources, maxFileBytes: readAttachmentsUploadConfig().maxFileBytes })
        : { drafts: [], skippedOversizeCount: 0 };
    if (admission.skippedOversizeCount > 0) return { status: 'invalidOperation', operationIndex: 0, reason: 'attachment_too_large' };
    let admittedIndex = 0;
    const drafts = input.items.flatMap(item => item.kind === 'text' ? []
        : [item.kind === 'image' && item.draft ? item.draft : admission.drafts[admittedIndex++]!]);
    if (input.windowText) drafts.push(admission.drafts[admittedIndex]!);
    let draftIndex = 0;
    const items: ComposerAttachmentInsertionItem[] = input.items.map(item => item.kind === 'text'
        ? { text: item.text } : { draft: drafts[draftIndex++]!, ...(item.note ? { note: item.note } : {}) });
    if (input.note) items.push({ text: input.note });
    return { status: 'admitted', drafts, items };
}
