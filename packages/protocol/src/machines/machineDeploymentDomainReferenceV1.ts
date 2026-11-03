import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Exact retained native edge placement; labels and desired role alone are insufficient. */
export const MachineDeploymentDomainReferenceV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  environmentId: z.string().check(z.minLength(1)), targetLinkId: z.string().check(z.minLength(1)),
  domainId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)),
})));
export type MachineDeploymentDomainReferenceV1 = z.infer<typeof MachineDeploymentDomainReferenceV1Schema>;
