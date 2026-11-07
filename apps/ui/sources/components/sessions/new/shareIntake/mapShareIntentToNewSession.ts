import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

// Structural subset of expo-share-intent's `ShareIntent`, so the mapper stays independent of the native module.
export type SharedContent = Readonly<{
    text?: string | null;
    webUrl?: string | null;
    files?: ReadonlyArray<Readonly<{
        path: string;
        fileName?: string | null;
        mimeType?: string | null;
        size?: number | null;
    }>> | null;
}>;

export type NewSessionShare = Readonly<{
    prompt: string | undefined;
    sources: readonly AttachmentsUploadFileSource[];
}>;

function fileNameFromPath(path: string): string {
    const last = path.split(/[\\/]/).pop() ?? '';
    const decoded = (() => {
        try { return decodeURIComponent(last); } catch { return last; }
    })();
    return decoded.length > 0 ? decoded : 'shared-file';
}

export function mapShareIntentToNewSession(share: SharedContent): NewSessionShare {
    const promptText = (share.webUrl ?? share.text ?? '').trim();
    const sources = (share.files ?? []).map((file): AttachmentsUploadFileSource => ({
        kind: 'native',
        uri: file.path,
        name: file.fileName?.trim() || fileNameFromPath(file.path),
        sizeBytes: file.size ?? null,
        mimeType: file.mimeType ?? null,
    }));
    return { prompt: promptText.length > 0 ? promptText : undefined, sources };
}
