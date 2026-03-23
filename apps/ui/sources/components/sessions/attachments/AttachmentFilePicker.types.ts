import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type AttachmentFilePickerHandle = Readonly<{
    /**
     * Compatibility alias: behaves like `openFiles()`.
     * Prefer `openFiles()` / `openImages()` for platform-specific pickers.
     */
    open: () => void;
    openFiles: () => void;
    openImages: () => void;
}>;

export type PickedAttachment = AttachmentsUploadFileSource;

export type AttachmentFilePickerProps = Readonly<{
    multiple?: boolean;
    onAttachmentsPicked: (attachments: readonly PickedAttachment[]) => void;
}>;
