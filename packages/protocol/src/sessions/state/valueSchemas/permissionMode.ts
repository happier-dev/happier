import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionPermissionModeSchema } from '../../metadata/sessionPermissionModes.js';

export const SessionStatePermissionModeValueSchema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    permissionMode: SessionPermissionModeSchema,
    updatedAt: z.number().finite(),
  })
  .strict());
