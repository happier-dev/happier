import type { AttachmentsUploadFileSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type AttachmentFilePickerHandle = Readonly<{
    open: () => void;
}>;

export type PickedAttachment = AttachmentsUploadFileSource;

export type AttachmentFilePickerProps = Readonly<{
    multiple?: boolean;
    onAttachmentsPicked: (attachments: readonly PickedAttachment[]) => void;
}>;
