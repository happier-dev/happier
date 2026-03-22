import { z } from 'zod';

import { BackendTargetRefSchema } from './backendTargets/backendTargetRef.js';

export const ExecutionRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);
export type ExecutionRunStatus = z.infer<typeof ExecutionRunStatusSchema>;

export const ExecutionRunListRequestSchema = z.object({
  backendId: z.string().trim().min(1).optional(),
  backendTarget: BackendTargetRefSchema.optional(),
  status: ExecutionRunStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type ExecutionRunListRequest = z.infer<typeof ExecutionRunListRequestSchema>;
