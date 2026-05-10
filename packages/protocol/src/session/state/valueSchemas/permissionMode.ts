import { z } from 'zod';

import { SessionPermissionModeSchema } from '../../../sessionMetadata/sessionPermissionModes.js';

export const SessionStatePermissionModeValueSchema = z
  .object({
    v: z.literal(1),
    permissionMode: SessionPermissionModeSchema,
    updatedAt: z.number().finite(),
  })
  .strict();
