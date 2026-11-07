import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

/** environmentId is the destination; the selected receipt owns the source bytes. */
export const DeploymentPromoteIntentInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  sourceEnvironmentId: DeploymentIdentifierV1Schema,
  sourceDeploymentId: DeploymentIdentifierV1Schema,
  artifact: z.enum(['image', 'rebuild']),
  requestKey: z.optional(DeploymentIdentifierV1Schema),
}));
export type DeploymentPromoteIntentInputV1 = z.infer<typeof DeploymentPromoteIntentInputV1Schema>;
