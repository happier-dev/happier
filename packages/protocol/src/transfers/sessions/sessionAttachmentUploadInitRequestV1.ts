import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';

/** Attachment destinations are derived by the daemon from this exact hosted Session. */
export const SessionAttachmentUploadInitRequestV1Schema = lazyZodSchema(() => z.object({
  t: z.literal('session_attachment_upload_v1'),
  sessionId: asProtocolZod(SessionIdSchema),
  messageLocalId: z.unknown(),
  fileName: z.unknown(),
  sizeBytes: z.unknown(),
  uploadLocation: z.enum(['workspace', 'os_temp']).optional(),
  workspaceRootPath: z.unknown().optional(),
  workspaceRelativeDir: z.string().optional(),
  vcsIgnoreStrategy: z.enum(['git_info_exclude', 'gitignore', 'none']).optional(),
  vcsIgnoreWritesEnabled: z.boolean().optional(),
}).strict());

export type SessionAttachmentUploadInitRequestV1 = Readonly<z.infer<typeof SessionAttachmentUploadInitRequestV1Schema>>;
