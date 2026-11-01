import { z } from 'zod';

import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { EphemeralTaskPermissionModeSchema } from '../ephemeralTasks.js';
import { lazySchema } from '../lazySchema.js';

export const LlmTaskRunnerConfigV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    backendTarget: BackendTargetRefSchema,
    modelId: z.string().refine((value) => value.trim().length > 0, {
      message: 'modelId must not be blank',
    }).optional(),
    permissionMode: EphemeralTaskPermissionModeSchema.optional(),
  })
  .passthrough());

export type LlmTaskRunnerConfigV1 = z.infer<typeof LlmTaskRunnerConfigV1Schema>;
