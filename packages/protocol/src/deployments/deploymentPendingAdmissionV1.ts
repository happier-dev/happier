import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';

/** Server-authenticated correspondence only; never credentials or execution authority. */
export const DeploymentPendingAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
    requesterAccountId: DeploymentIdentifierV1Schema,
    serverId: DeploymentIdentifierV1Schema,
    requestKey: DeploymentIdentifierV1Schema,
    actionOperationId: DeploymentIdentifierV1Schema,
    controller: z.strictObject({ machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema }),
    environmentRevision: DeploymentRevisionV1Schema,
}));
export type DeploymentPendingAdmissionV1 = z.infer<typeof DeploymentPendingAdmissionV1Schema>;
