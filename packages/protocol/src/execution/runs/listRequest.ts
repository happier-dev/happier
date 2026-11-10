import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../../backends/targets/backendTargetRefV2.js';

export const ExecutionRunStatusSchema = lazyZodSchema(() => z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]));
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;

export const ExecutionRunListRequestSchema = lazyZodSchema(() => z.looseObject({
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  // Canonical backend target values are V2; V1 remains accepted through the
  // shared preprocess so mixed-version components can keep exchanging list
  // filters while the compatibility alias exists.
  backendTarget: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetRefV2InputToV2), z.optional(BackendTargetRefV2Schema)),
  status: z.optional(ExecutionRunStatusSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));
export type ExecutionRunListRequest = z.infer<typeof ExecutionRunListRequestSchema>;
