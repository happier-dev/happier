import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const id = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Stable service identity, independent of actor, release and Deployment receipt. */
export const MachineServiceIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('deployment'),
  machineId: id,
  environmentId: id,
  environmentInstanceId: id,
  composeService: id,
  serviceId: id,
}).check(z.superRefine((identity, ctx) => {
  if (identity.serviceId !== `${identity.environmentInstanceId}/${identity.composeService}`) {
    ctx.addIssue({ code: 'custom', path: ['serviceId'], message: 'Service id must match its admitted Environment instance and Compose service.' });
  }
})));
export type MachineServiceIdentityV1 = z.infer<typeof MachineServiceIdentityV1Schema>;

/** C1 owns occurrence encoding; this owner supplies only the canonical service tuple. */
export function machineServiceIdentityTupleV1(identity: MachineServiceIdentityV1): readonly string[] {
  return [identity.kind, identity.machineId, identity.environmentId, identity.environmentInstanceId, identity.composeService, identity.serviceId];
}
