import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/publicTypes.js';

/**
 * Exact result requested for one native Agent turn. This is an observation
 * contract only: it neither owns Run lifecycle nor changes prompt custody.
 */
export const ExecutionRunResultContractV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text') }),
  z.strictObject({
    kind: z.literal('json'),
    schema: PluginJsonSchemaV2Schema,
  }),
  z.strictObject({
    kind: z.literal('decision'),
    decisions: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
  }).check(z.superRefine((value, ctx) => {
    if (new Set(value.decisions).size !== value.decisions.length) {
      ctx.addIssue({
        code: "custom",
        path: ['decisions'],
        message: 'decision result values must be unique',
      });
    }
  })),
]));
export type ExecutionRunResultContractV1 = z.infer<typeof ExecutionRunResultContractV1Schema>;
