import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Authored selection resolved against the chosen Agent's connected-service inventory. */
export const ConnectedServicesLaunchAuthIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('default') }),
  z.strictObject({ kind: z.literal('native') }),
  z.strictObject({
    kind: z.literal('connected'),
    serviceId: z.nullable(z.string().check(z.minLength(1))),
    selection: z.nullable(z.enum(['group', 'profile'])),
    id: z.string().check(z.minLength(1)),
  }),
]));
export type ConnectedServicesLaunchAuthIntentV1 = z.infer<typeof ConnectedServicesLaunchAuthIntentV1Schema>;
