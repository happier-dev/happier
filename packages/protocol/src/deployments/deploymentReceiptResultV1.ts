import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionOperationAddressV1Schema } from '../actions/operations/addressV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentStateV1Schema } from './deploymentStateV1.js';

/** Accepted deployment outcomes shared by semantic parents and storage transports. */
export const DeploymentReceiptAcceptedResultV1Schema = lazyZodSchema(() => {
  const result = { ok: z.literal(true), environmentId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema };
  return z.union([
    z.strictObject({ ...result, deploymentId: DeploymentIdentifierV1Schema,
      deploymentRevision: DeploymentRevisionV1Schema, state: DeploymentStateV1Schema }),
    z.strictObject({ ...result, kind: z.literal('pending'), actionOperationId: DeploymentIdentifierV1Schema,
      operation: z.optional(ActionOperationAddressV1Schema) }),
  ]);
});
export type DeploymentReceiptAcceptedResultV1 = z.infer<typeof DeploymentReceiptAcceptedResultV1Schema>;
