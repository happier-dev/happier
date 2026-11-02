import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { MachineDeploymentServiceIdentityV1Schema } from '../local/services/serviceIdentityV1.js';

/** Restart only the captured native generation; no source or definition operands. */
export const DeploymentRestartInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id,
  service: MachineDeploymentServiceIdentityV1Schema, expectedGeneration: id,
}).check(z.refine(input => input.environmentId === input.service.environmentId
  && input.machineId === input.service.machineId, { message: 'The service belongs to the selected Environment and Machine.' })));
export type DeploymentRestartInputV1 = z.infer<typeof DeploymentRestartInputV1Schema>;
