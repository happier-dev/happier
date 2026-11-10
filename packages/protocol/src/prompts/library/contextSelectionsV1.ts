import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const ContextSelectionV1Schema = lazyZodSchema(() => z.looseObject({
  machineId: z.optional(z.nullable(z.string())),
  workspacePath: z.optional(z.nullable(z.string())),
}));
export type ContextSelectionV1 = z.infer<typeof ContextSelectionV1Schema>;

export const ContextSelectionsV1Schema = lazyZodSchema(() => z.catch(z.looseObject({
    v: z._default(z.literal(1), 1),
    selectionsByKey: z._default(z.record(z.string(), ContextSelectionV1Schema), {}),
  }), { v: 1, selectionsByKey: {} }));
export type ContextSelectionsV1 = z.infer<typeof ContextSelectionsV1Schema>;
