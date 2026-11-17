import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ProjectAccountRowExpectedRevisionV1Schema } from './projectAccountRowsV1.js';
import { ProjectSessionDefaultsV1Schema } from './projectSessionDefaultsV1.js';

/** Separate leaf revision: an edit never changes the parent Project/Source revision. */
export const ProjectSessionDefaultsPatchV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  defaults: z.nullable(ProjectSessionDefaultsV1Schema),
}));
export const ProjectSessionDefaultsLeafV1Schema = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  defaults: z.nullable(ProjectSessionDefaultsV1Schema),
}));
export type ProjectSessionDefaultsLeafV1 = z.infer<typeof ProjectSessionDefaultsLeafV1Schema>;
