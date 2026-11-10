import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const ExecutionRunCancelTurnRequestSchema = lazyZodSchema(() => z.strictObject({
  runId: z.string().check(z.minLength(1)),
  occurrenceId: z.string().check(z.minLength(1)),
  turnId: z.string().check(z.minLength(1)),
}));
export type ExecutionRunCancelTurnRequest = z.infer<typeof ExecutionRunCancelTurnRequestSchema>;

export const ExecutionRunCancelTurnResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(['requested', 'already_requested']),
    runId: z.string().check(z.minLength(1)),
    occurrenceId: z.string().check(z.minLength(1)),
    turnId: z.string().check(z.minLength(1)),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.enum([
      'execution_run_not_found',
      'execution_run_not_current',
      'execution_run_turn_not_active',
      'execution_run_cancel_unsupported',
      'execution_run_cancel_failed',
    ]),
  }),
]));
export type ExecutionRunCancelTurnResponse = z.infer<typeof ExecutionRunCancelTurnResponseSchema>;
