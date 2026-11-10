import { z } from '../../zodRuntimePolicy.js';

/**
 * Released Account profile shape, still projected by the public-share and
 * released Session-listing readers. The released direct-share routes that also
 * used it were retired under the one-way 0.3 upgrade.
 */
export const ReleasedDirectSessionShareProfileV1Schema = z.strictObject({
  id: z.string(),
  username: z.nullable(z.string()),
  firstName: z.nullable(z.string()),
  lastName: z.nullable(z.string()),
  avatar: z.nullable(z.string()),
});
export type ReleasedDirectSessionShareProfileV1 = z.infer<
  typeof ReleasedDirectSessionShareProfileV1Schema
>;
