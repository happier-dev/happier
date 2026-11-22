import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type AttachmentFilePickerHandle = Readonly<{
    /**
     * Compatibility alias: behaves like `openFiles()`.
     * Prefer `openFiles()` / `openImages()` for platform-specific pickers.
     */
    open: () => void;
    openFiles: () => void;
    openImages: () => void;
    /** Captures a photo with the device camera; native-only (the web picker does not implement it). */
    takePhoto?: () => void;
}>;

export type PickedAttachment = AttachmentsUploadFileSource;

export type AttachmentFilePickerProps = Readonly<{
    multiple?: boolean;
    onAttachmentsPicked: (attachments: readonly PickedAttachment[]) => void;
}>;
