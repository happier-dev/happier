import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** A qualified Source address; independent of Source contents and sharing. */
export const ProjectSourcesReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  sourceId: z.string().check(z.minLength(1)),
}));
export type ProjectSourcesReadInputV1 = z.infer<typeof ProjectSourcesReadInputV1Schema>;
