import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const ExecutionRunCompletionV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'timeout']),
  finishedAtMs: z.number().int().nonnegative(),
  canInspect: z.boolean(),
  summary: z.string().max(8_000).optional(),
}).passthrough());

export type ExecutionRunCompletionV1 = z.infer<typeof ExecutionRunCompletionV1Schema>;

function buildExecutionRunCompletionText(completion: ExecutionRunCompletionV1): string {
  const summary = completion.summary?.trim();
  return [
    '<happier_execution_run_notification>',
    'This is an automated background-run notification from Happier, not a user message.',
    `Run ID: ${completion.runId}`,
    `Status: ${completion.status}`,
    ...(summary ? ['', 'Final result:', summary] : []),
    '</happier_execution_run_notification>',
  ].join('\n');
}

export function buildExecutionRunCompletionInputV1(value: ExecutionRunCompletionV1): Readonly<{
  text: string;
  meta: Record<string, unknown>;
}> {
  const completion = ExecutionRunCompletionV1Schema.parse(value);
  return {
    text: buildExecutionRunCompletionText(completion),
    meta: {
      source: 'execution_run',
      sentFrom: 'happier',
      happierStructuredInputV1: { v: 1, executionRunCompletion: completion },
    },
  };
}
