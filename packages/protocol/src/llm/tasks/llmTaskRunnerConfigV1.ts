import { z } from 'zod';

import { BackendTargetRefSchema } from '../../backends/targets/backendTargetRef.js';

export const LlmTaskPermissionModeSchema = z.enum([
  'no_tools',
  'read_only',
  'workspace_write',
  'full',
]);
export type LlmTaskPermissionMode = z.infer<typeof LlmTaskPermissionModeSchema>;

export const LlmTaskRunnerConfigV1Schema = z
  .object({
    v: z.literal(1),
    backendTarget: BackendTargetRefSchema,
    modelId: z.string().trim().min(1).optional(),
    permissionMode: LlmTaskPermissionModeSchema.optional(),
  })
  .passthrough();

export type LlmTaskRunnerConfigV1 = z.infer<typeof LlmTaskRunnerConfigV1Schema>;
