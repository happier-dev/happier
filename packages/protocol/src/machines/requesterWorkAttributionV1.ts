import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/** Nonsecret facts stamped by the admitted host; never execution authority. */
export const RequesterWorkAttributionV1Schema = z.object({
  serverId: z.string().min(1),
  accountId: z.string().min(1),
  machineId: z.string().min(1),
  installationId: z.string().min(1),
}).strict();

export type RequesterWorkAttributionV1 = Readonly<z.infer<typeof RequesterWorkAttributionV1Schema>>;
export const RequesterWorkAttributionStoredReadV1Schema = createStoredReadSchema(RequesterWorkAttributionV1Schema);
