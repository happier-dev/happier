import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentTeardownReasonV1Schema } from './deploymentActionsV1.js';

/** The controller selects the current runtime link unless the person names one. */
export const DeploymentTeardownRequestInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  targetLinkId: z.optional(DeploymentIdentifierV1Schema),
  requestKey: z.optional(DeploymentIdentifierV1Schema),
  reason: DeploymentTeardownReasonV1Schema,
  removeEnvironment: z.optional(z.literal(true)),
}));
export type DeploymentTeardownRequestInputV1 = z.infer<typeof DeploymentTeardownRequestInputV1Schema>;
