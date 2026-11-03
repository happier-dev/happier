import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

const occurrence = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.minimum(1)),
  occurredAt: z.number().check(z.int(), z.minimum(0)),
}));
/** Latest occurrence of each polarity, not a historical transition journal. */
export const MachinePresenceTransitionsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), revision: z.number().check(z.int(), z.minimum(1)),
  offline: z.nullable(occurrence), online: z.nullable(occurrence),
}));
export type MachinePresenceTransitionsV1 = z.infer<typeof MachinePresenceTransitionsV1Schema>;
export const MachinePresenceReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
}));
