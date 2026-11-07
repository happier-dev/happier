import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isMachineOnlineV1, type MachinePresenceV1 } from '../machines/machineReachabilityV1.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

/** Controller-offline pauses Environment jobs and alerts; missing presence makes no availability claim. */
export const DeploymentControllerAvailabilityV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: DeploymentIdentifierV1Schema,
    state: z.enum(['available', 'paused', 'unknown']),
}));
export type DeploymentControllerAvailabilityV1 = z.infer<typeof DeploymentControllerAvailabilityV1Schema>;

/** Reads and pushed Machine consumers share the existing presence decision, without another timer. */
export function projectDeploymentControllerAvailabilityV1(
    machineId: string, presence: MachinePresenceV1 | null,
): DeploymentControllerAvailabilityV1 {
    return { machineId, state: presence === null ? 'unknown' : isMachineOnlineV1(presence) ? 'available' : 'paused' };
}
