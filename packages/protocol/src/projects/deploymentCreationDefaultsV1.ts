import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from '../deployments/deploymentIdentifiersV1.js';

export const DeploymentRetainPreviousDeploymentsV1Schema = lazyZodSchema(() => z.number().check(
  z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER),
));
export const DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1 = 1;

/** Deliberate creation preferences; partial layers never materialize domain defaults. */
export const DeploymentCreationDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  controllerMachineId: z.optional(DeploymentIdentifierV1Schema),
  retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
}));
export type DeploymentCreationDefaultsV1 = z.infer<typeof DeploymentCreationDefaultsV1Schema>;

export const DeploymentCreationDefaultSourceV1Schema = z.enum(['explicit', 'project', 'account', 'builtin']);
export type DeploymentCreationDefaultSourceV1 = z.infer<typeof DeploymentCreationDefaultSourceV1Schema>;
/** Review projection of the canonical resolver; only values are persisted on creation. */
export const ResolvedDeploymentCreationDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  values: z.extend(DeploymentCreationDefaultsV1Schema, { retainPreviousDeployments: DeploymentRetainPreviousDeploymentsV1Schema }),
  sources: z.strictObject({
    buildMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    controllerMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    retainPreviousDeployments: z.optional(DeploymentCreationDefaultSourceV1Schema),
  }),
}));
export type ResolvedDeploymentCreationDefaultsV1 = z.infer<typeof ResolvedDeploymentCreationDefaultsV1Schema>;
