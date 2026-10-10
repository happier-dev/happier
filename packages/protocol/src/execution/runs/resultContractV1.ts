import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginJsonSchemaV2Schema } from '../../plugins/contributions/publicTypes.js';

/**
 * Exact result requested for one native Agent turn. This is an observation
 * contract only: it neither owns Run lifecycle nor changes prompt custody.
 */
export const ExecutionRunResultContractV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text') }).strict(),
  z.object({
    kind: z.literal('json'),
    schema: PluginJsonSchemaV2Schema,
  }).strict(),
  z.object({
    kind: z.literal('decision'),
    decisions: z.array(z.string().trim().min(1)).min(1),
  }).strict().superRefine((value, ctx) => {
    if (new Set(value.decisions).size !== value.decisions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisions'],
        message: 'decision result values must be unique',
      });
    }
  }),
]));
export type ExecutionRunResultContractV1 = z.infer<typeof ExecutionRunResultContractV1Schema>;
