import { z } from 'zod';

import { BackendTargetRefSchema } from '../backendTargets/backendTargetRef.js';
import { EphemeralTaskPermissionModeSchema } from '../ephemeralTasks.js';

export const LlmTaskRunnerConfigV1Schema = z
  .object({
    v: z.literal(1),
    backendTarget: BackendTargetRefSchema,
    modelId: z.string().trim().min(1).optional(),
    permissionMode: EphemeralTaskPermissionModeSchema.optional(),
  })
  .passthrough();

export type LlmTaskRunnerConfigV1 = z.infer<typeof LlmTaskRunnerConfigV1Schema>;
