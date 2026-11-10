import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentRuntimeContentCasV1Schema, DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
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

/** The prepared destination content is committed by the sole Environment writer before admission. */
export const DeploymentPromoteInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...DeploymentRuntimeContentCasV1Schema.shape,
  sourceEnvironmentId: DeploymentIdentifierV1Schema, sourceDeploymentId: DeploymentIdentifierV1Schema,
  artifact: z.enum(['image', 'rebuild']), destinationContent: DeploymentArtifactContentReferenceV1Schema,
}));
export const DeploymentPromoteActionInputV1Schema = lazyZodSchema(() => z.union([
  DeploymentPromoteInputV1Schema, DeploymentPromoteIntentInputV1Schema,
]));
export type DeploymentPromoteActionInputV1 = z.infer<typeof DeploymentPromoteActionInputV1Schema>;
export type DeploymentPromoteInputV1 = z.infer<typeof DeploymentPromoteInputV1Schema>;
