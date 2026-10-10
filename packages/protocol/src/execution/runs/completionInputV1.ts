import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH = 8_000;

export const ExecutionRunCompletionV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
  finishedAtMs: z.number().int().nonnegative(),
  canInspect: z.boolean(),
  summary: z.string().max(EXECUTION_RUN_COMPLETION_SUMMARY_MAX_LENGTH).optional(),
}).passthrough());

export type ExecutionRunCompletionV1 = z.infer<typeof ExecutionRunCompletionV1Schema>;
