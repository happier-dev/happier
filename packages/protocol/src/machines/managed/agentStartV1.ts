import { z } from 'zod';

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionSpawnNewInputV2BaseSchema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { refineSessionDirectoryIntentCheckoutV1 } from '../../sessions/creation/sessionDirectoryIntentV1.js';

/**
 * Ordinary Session authoring held until this acquisition enrolls a Machine.
 * Only the managed owner may bind the resulting execution target; callers
 * cannot claim an existing Machine or supply host admission facts here.
 */
export const ManagedAcquireAgentStartV1Schema = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema
  .omit({ executionTarget: true, environmentVariables: true })
  .strict()
  .superRefine(refineSessionDirectoryIntentCheckoutV1));

export type ManagedAcquireAgentStartV1 = z.infer<typeof ManagedAcquireAgentStartV1Schema>;
