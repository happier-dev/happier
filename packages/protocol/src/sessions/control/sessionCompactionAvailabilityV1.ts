import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Manual compact availability; missing evidence never claims native refusal. */
export const AgentSessionCompactionAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported') }),
  z.strictObject({ status: z.literal('unsupported'), reason: z.literal('unsupported') }),
  z.strictObject({ status: z.literal('unknown') }),
]));
export type AgentSessionCompactionAvailabilityV1 = z.infer<typeof AgentSessionCompactionAvailabilityV1Schema>;
