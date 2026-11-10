import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { SessionPermissionModeSchema } from '../../metadata/sessionPermissionModes.js';

export const SessionStatePermissionModeValueSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    permissionMode: SessionPermissionModeSchema,
    updatedAt: z.number(),
  }));
