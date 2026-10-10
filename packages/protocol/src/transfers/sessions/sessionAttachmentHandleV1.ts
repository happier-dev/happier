import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { TransferSessionIdSchema } from './transferSessionIds.js';

/** An attachment issued by the hosting Session's transfer store; never a filesystem address. */
export const SessionAttachmentHandleV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1),
    sessionId: asProtocolZod(SessionIdSchema),
    id: TransferSessionIdSchema,
}).strict());

export type SessionAttachmentHandleV1 = Readonly<z.infer<typeof SessionAttachmentHandleV1Schema>>;

export const SessionAttachmentDownloadInitRequestV1Schema = lazyZodSchema(() => z.object({
    t: z.literal('session_attachment_download_v1'),
    attachmentHandle: SessionAttachmentHandleV1Schema,
    recipientPublicKeyBase64: z.string().min(1),
}).strict());

export type SessionAttachmentDownloadInitRequestV1 = Readonly<z.infer<typeof SessionAttachmentDownloadInitRequestV1Schema>>;
