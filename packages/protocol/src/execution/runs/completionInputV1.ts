import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH = 8_000;

export const ExecutionRunCompletionV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  runId: z.string().check(z.minLength(1)),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
  finishedAtMs: z.number().check(z.int(), z.nonnegative()),
  canInspect: z.boolean(),
  summary: z.optional(z.string().check(z.maxLength(EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH))),
}));

export type ExecutionRunCompletionV1 = z.infer<typeof ExecutionRunCompletionV1Schema>;
