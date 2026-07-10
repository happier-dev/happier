import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  normalizeBackendTargetRefV2InputToV2,
} from '../../backends/targets/backendTargetRefV2.js';

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
  // Canonical backend target values are V2; V1 remains accepted through the
  // shared preprocess so mixed-version components can keep exchanging list
  // filters while the compatibility alias exists.
  backendTarget: z.preprocess(normalizeBackendTargetRefV2InputToV2, BackendTargetRefV2Schema.optional()),
  status: ExecutionRunStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).passthrough();
export type ExecutionRunListRequest = z.infer<typeof ExecutionRunListRequestSchema>;
