import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';

const IdSchema = lazyZodSchema(() =>
  z.string().check(
    z.minLength(1),
    z.refine((value) => value === value.trim()),
  ),
);

/** Pin or unpin one Environment in the person's Services column on a Home (its private Services organization row). */
export const ProjectServicesPinInputV1Schema = lazyZodSchema(() =>
  z.strictObject({
    serverId: IdSchema,
    environmentId: IdSchema,
    pinned: z.boolean(),
  }),
);
export type ProjectServicesPinInputV1 = z.infer<
  typeof ProjectServicesPinInputV1Schema
>;
/** The Home's pinned services after the change, newest first. */
export const ProjectServicesPinOutputV1Schema = lazyZodSchema(() =>
  z.union([
    z.strictObject({
      ok: z.literal(true),
      pinnedEnvironmentIds: z.array(IdSchema),
    }),
    ActionExecuteFailureSchema,
  ]),
);
export type ProjectServicesPinOutputV1 = z.infer<
  typeof ProjectServicesPinOutputV1Schema
>;
