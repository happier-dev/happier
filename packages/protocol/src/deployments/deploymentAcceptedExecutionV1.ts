import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';

const installation = lazyZodSchema(() => z.strictObject({
  machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema,
}));

/** Home-captured execution identities, not secret material or continuing authorization. */
export const DeploymentAcceptedExecutionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), controller: installation, builder: z.optional(installation),
  environmentRevision: DeploymentRevisionV1Schema,
}));
export type DeploymentAcceptedExecutionV1 = z.infer<typeof DeploymentAcceptedExecutionV1Schema>;
