import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/** Nonsecret facts stamped by the admitted host; never execution authority. */
export const RequesterWorkAttributionV1Schema = z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  accountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  installationId: z.string().check(z.minLength(1)),
});

export type RequesterWorkAttributionV1 = Readonly<z.infer<typeof RequesterWorkAttributionV1Schema>>;
export const RequesterWorkAttributionStoredReadV1Schema = createStoredReadSchema(RequesterWorkAttributionV1Schema);
