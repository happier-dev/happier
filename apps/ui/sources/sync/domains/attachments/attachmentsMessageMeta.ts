import { z } from 'zod';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';

export const AttachmentMessageMetaItemV1Schema = z.object({
    name: z.string(),
    path: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().finite(),
    sha256: z.string().optional(),
    attachmentHandle: SessionAttachmentHandleV1Schema.optional(),
});

export const AttachmentsMessageMetaV1Schema = z.object({
    attachments: z.array(AttachmentMessageMetaItemV1Schema).default([]),
});

export type AttachmentsMessageMetaV1 = z.infer<typeof AttachmentsMessageMetaV1Schema>;
