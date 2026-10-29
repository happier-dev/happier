import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

/** Qualified structural Environment identity; Source admission remains with its owner. */
export const DeploymentEnvironmentRefV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  projectSourceId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  previewRole: z.optional(z.enum(['preview_admission', 'preview_cleanup'])),
}));
export type DeploymentEnvironmentRefV1 = z.infer<typeof DeploymentEnvironmentRefV1Schema>;
