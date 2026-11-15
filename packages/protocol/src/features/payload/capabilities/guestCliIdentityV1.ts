import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

/** Home-owned artifact selection, independent of feature gates and package versions. */
export const GuestCliIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.enum(['home-payload', 'public-release']),
  line: z.string().check(z.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/)),
}));

export type GuestCliIdentityV1 = z.infer<typeof GuestCliIdentityV1Schema>;
