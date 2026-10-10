import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const ExecutionRunCancelTurnRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  occurrenceId: z.string().min(1),
  turnId: z.string().min(1),
}).strict());
export type ExecutionRunCancelTurnRequest = z.infer<typeof ExecutionRunCancelTurnRequestSchema>;

export const ExecutionRunCancelTurnResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    status: z.enum(['requested', 'already_requested']),
    runId: z.string().min(1),
    occurrenceId: z.string().min(1),
    turnId: z.string().min(1),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
    errorCode: z.enum([
      'execution_run_not_found',
      'execution_run_not_current',
      'execution_run_turn_not_active',
      'execution_run_cancel_unsupported',
      'execution_run_cancel_failed',
    ]),
  }).strict(),
]));
export type ExecutionRunCancelTurnResponse = z.infer<typeof ExecutionRunCancelTurnResponseSchema>;
