import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';

/** Attachment destinations are derived by the daemon from this exact hosted Session. */
export const SessionAttachmentUploadInitRequestV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.literal('session_attachment_upload_v1'),
  sessionId: asProtocolZod(SessionIdSchema),
  messageLocalId: z.unknown(),
  fileName: z.unknown(),
  attachmentId: z.optional(z.string().check(z.minLength(1))),
  relativePath: z.optional(z.string()),
  /** A zero-byte directory finalization preserves empty directories under relativePath. */
  directoryEntries: z.optional(z.array(z.string())),
  sizeBytes: z.unknown(),
  uploadLocation: z.optional(z.enum(['workspace', 'os_temp'])),
  workspaceRootPath: z.optional(z.unknown()),
  workspaceRelativeDir: z.optional(z.string()),
  vcsIgnoreStrategy: z.optional(z.enum(['git_info_exclude', 'gitignore', 'none'])),
  vcsIgnoreWritesEnabled: z.optional(z.boolean()),
}));

export type SessionAttachmentUploadInitRequestV1 = Readonly<z.infer<typeof SessionAttachmentUploadInitRequestV1Schema>>;
